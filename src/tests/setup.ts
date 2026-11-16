import { afterEach, beforeEach, vi } from "vitest";
import { resetConfig } from "@/lib/core/config";
import { resetCache } from "@/lib/core/cache";
import { resetHttpState } from "@/lib/core/http";
import { setResolver } from "@/lib/core/net-guard";
import { resetRegistry } from "@/lib/providers/registry";
import { resetApiRateLimits } from "@/lib/api/handler";

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
}

beforeEach(() => {
  process.env.UPSTREAM_RETRY_BASE_MS = process.env.UPSTREAM_RETRY_BASE_MS ?? "1";
  process.env.UPSTREAM_RETRY_MAX_MS = process.env.UPSTREAM_RETRY_MAX_MS ?? "5";
  resetAll();
  if (!live) {
    // Adapters log their own failures; keep offline test output readable.
    if (!process.env.DEBUG_TESTS) {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    }
    setResolver(async () => ["93.184.216.34"]);
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
});
