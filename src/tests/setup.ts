import { afterEach, beforeEach, vi } from "vitest";
import { resetConfig } from "@/lib/core/config";
import { resetCache } from "@/lib/core/cache";
import { resetHttpState } from "@/lib/core/http";
import { setGuardedFetchImpl, setResolver } from "@/lib/core/net-guard";
import { resetRegistry } from "@/lib/providers/registry";
import { resetApiRateLimits } from "@/lib/api/handler";
import { resetMetadataClient } from "@/lib/metadata/client";

/**
 * Offline-by-default test environment. Unless LIVE_TESTS=1, every test runs
 * with a fake DNS resolver (public address) and a fetch() that refuses real
 * network access, so tests are deterministic and never hit third-party sites.
 */
const live = process.env.LIVE_TESTS === "1";

export function resetAll(): void {
  resetConfig();
  resetCache();
  resetHttpState();
  resetRegistry();
  resetApiRateLimits();
  resetMetadataClient();
}

beforeEach(() => {
  process.env.UPSTREAM_RETRY_BASE_MS = process.env.UPSTREAM_RETRY_BASE_MS ?? "1";
  process.env.UPSTREAM_RETRY_MAX_MS = process.env.UPSTREAM_RETRY_MAX_MS ?? "5";
  // Experimental providers are off unless a test turns them on explicitly.
  delete process.env.EXPERIMENTAL_PROVIDERS;
  resetAll();
  if (!live) {
    // Adapters log their own failures; keep offline test output readable.
    if (!process.env.DEBUG_TESTS) {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    }
    setResolver(async () => ["93.184.216.34"]);
    // Production uses undici's own fetch; offline tests intercept the global one.
    setGuardedFetchImpl((input, init) => globalThis.fetch(input, init));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        throw new Error(`Unexpected network access in offline test: ${String(input)}`);
      }),
    );
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setResolver(null);
  setGuardedFetchImpl(null);
});
