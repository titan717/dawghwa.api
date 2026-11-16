import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-operation context propagated through async calls.
 *
 * Source adapters are long-lived singletons shared by concurrent requests, so
 * cancellation signals, deadlines and the provider identity cannot be stored on
 * the adapter instance. Instead the provider executor runs each operation inside
 * an AsyncLocalStorage scope and the shared HTTP client reads it from there.
 */
export interface OperationContext {
  providerId?: string;
  signal?: AbortSignal;
  /** Epoch ms after which no new upstream attempts are started. */
  deadline?: number;
  stats: OperationStats;
}

export interface OperationStats {
  upstreamRequests: number;
  upstreamSuccesses: number;
  conditionalHits: number;
  dedupedRequests: number;
  retries: number;
  /** Last upstream failure, even if the adapter swallowed it. */
  lastError?: unknown;
}

const storage = new AsyncLocalStorage<OperationContext>();

export function newStats(): OperationStats {
  return {
    upstreamRequests: 0,
    upstreamSuccesses: 0,
    conditionalHits: 0,
    dedupedRequests: 0,
    retries: 0,
  };
}

export function runWithContext<T>(ctx: OperationContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentContext(): OperationContext | undefined {
  return storage.getStore();
}
