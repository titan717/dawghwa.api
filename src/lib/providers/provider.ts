import { BaseScraper } from "@/lib/scrapers/base";
import type { BaseFrontpage } from "@/lib/frontpages/base";
import { CircuitBreaker, BreakerSnapshot } from "@/lib/core/circuit-breaker";
import { getConfig } from "@/lib/core/config";
import { OperationStats, newStats, runWithContext } from "@/lib/core/context";
import { DawghwaError, ErrorCode, isSourceFailure, toDawghwaError } from "@/lib/core/errors";
import { setProviderRateLimit } from "@/lib/core/http";
import type { ProviderRateLimit } from "@/lib/core/rate-limiter";
import { abortError, combineSignals } from "@/lib/core/retry";
import type { SourceType } from "@/types";
import type { ProviderStatus } from "./status";

export type ProviderOperation = "search" | "chapters" | "mangaInfo" | "frontpage" | "chapterPages" | "health";

export interface ProviderCapabilities {
  search: boolean;
  chapters: boolean;
  mangaInfo: boolean;
  frontpage: boolean;
  chapterPages: boolean;
  /** Upstream marks these as needing the client to fetch HTML (anti-bot); the API still serves them where it can. */
  clientOnly: boolean;
}

export interface ProviderMetrics {
  requests: number;
  successes: number;
  failures: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastErrorCode?: ErrorCode;
  /** Exponentially weighted moving average of successful operation latency. */
  avgLatencyMs?: number;
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  baseUrl: string;
  description: string;
  type: SourceType;
  status: ProviderStatus;
  statusNote?: string;
  priority: number;
  aliases: string[];
  domains: readonly string[];
  rateLimit: ProviderRateLimit;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Health probes may pass an open circuit (they act as the recovery trial). */
  probe?: boolean;
}

export interface RunResult<T> {
  value: T;
  durationMs: number;
  stats: OperationStats;
}

/**
 * Runtime wrapper around one independent source adapter.
 *
 * Every adapter call goes through `run()`, which provides isolation: a
 * per-operation deadline and cancellation, a circuit breaker, passive health
 * metrics, consistent error classification, and detection of failures that
 * the adapter swallowed (returned [] after every upstream request failed).
 */
export class Provider {
  readonly breaker: CircuitBreaker;
  readonly metrics: ProviderMetrics = { requests: 0, successes: 0, failures: 0 };

  constructor(
    readonly descriptor: ProviderDescriptor,
    readonly scraper: BaseScraper,
    readonly frontpage?: BaseFrontpage,
    private readonly disabled = false,
  ) {
    const cfg = getConfig().providers;
    this.breaker = new CircuitBreaker(cfg.breakerFailureThreshold, cfg.breakerCooldownMs);
    setProviderRateLimit(descriptor.id, descriptor.rateLimit);
  }

  get id(): string {
    return this.descriptor.id;
  }

  get name(): string {
    return this.descriptor.name;
  }

  get capabilities(): ProviderCapabilities {
    return {
      search: true,
      chapters: true,
      mangaInfo: true,
      frontpage: Boolean(this.frontpage),
      chapterPages: this.scraper.supportsChapterPages(),
      clientOnly: this.scraper.isClientOnly(),
    };
  }

  /** Operational = may be called at all (not shut down / disabled by the operator). */
  get operational(): boolean {
    return !this.disabled && this.descriptor.status !== "shutdown";
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  circuit(): BreakerSnapshot {
    return this.breaker.snapshot();
  }

  /** Does `url` belong to this source? Exact host or subdomain match only. */
  ownsUrl(url: URL): boolean {
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return this.descriptor.domains.some((d) => host === d || host.endsWith(`.${d}`));
  }

  assertOperational(): void {
    if (this.disabled) {
      throw new DawghwaError("SOURCE_UNAVAILABLE", `${this.name} is disabled on this server`, {
        details: { source: this.id, status: "disabled" },
      });
    }
    if (this.descriptor.status === "shutdown") {
      throw new DawghwaError("SOURCE_UNAVAILABLE", `${this.name} is shut down and no longer supported`, {
        details: { source: this.id, status: "shutdown", note: this.descriptor.statusNote },
      });
    }
  }

  async run<T>(op: ProviderOperation, fn: () => Promise<T>, opts: RunOptions = {}): Promise<RunResult<T>> {
    this.assertOperational();
    if (!opts.probe) this.breaker.assertCanPass(this.name);

    const timeoutMs = opts.timeoutMs ?? getConfig().providers.operationTimeoutMs;
    const { signal, cleanup } = combineSignals([opts.signal], timeoutMs);
    const stats = newStats();
    const started = Date.now();
    this.metrics.requests += 1;

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? abortError());
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => undefined);

    try {
      const value = await runWithContext(
        { providerId: this.id, signal, deadline: started + timeoutMs, stats },
        () => Promise.race([fn(), aborted]),
      );

      // Surface failures the adapter swallowed: an empty result where every
      // upstream request failed is an outage, not "no results".
      if (
        Array.isArray(value) &&
        value.length === 0 &&
        stats.lastError !== undefined &&
        stats.upstreamSuccesses === 0
      ) {
        throw stats.lastError;
      }

      const durationMs = Date.now() - started;
      this.breaker.onSuccess();
      this.metrics.successes += 1;
      this.metrics.lastSuccessAt = new Date().toISOString();
      this.metrics.avgLatencyMs =
        this.metrics.avgLatencyMs === undefined
          ? durationMs
          : Math.round(this.metrics.avgLatencyMs * 0.8 + durationMs * 0.2);
      return { value, durationMs, stats };
    } catch (raw) {
      let error = toDawghwaError(raw);
      if (signal.aborted && opts.signal?.aborted) {
        error = new DawghwaError("CANCELLED", "Request was cancelled by the client");
      } else if (signal.aborted) {
        error = new DawghwaError("UPSTREAM_TIMEOUT", `${this.name} did not finish within ${timeoutMs}ms`, {
          retryable: true,
          details: { timeoutMs },
        });
      }
      if (error.code !== "CANCELLED") {
        this.metrics.failures += 1;
        this.metrics.lastFailureAt = new Date().toISOString();
        this.metrics.lastErrorCode = error.code;
      }
      if (isSourceFailure(error)) this.breaker.onFailure();
      else this.breaker.onNeutral();
      throw error;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      cleanup();
    }
  }
}
