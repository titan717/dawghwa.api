import { vi } from "vitest";

export type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Replace global fetch with a handler; returns the mock for call assertions. */
export function mockFetch(handler: FetchHandler) {
  const fn = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (init.signal?.aborted) throw init.signal.reason;
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });
}

export function htmlResponse(html: string, init: ResponseInit = {}): Response {
  return new Response(html, {
    status: 200,
    ...init,
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers as Record<string, string>) },
  });
}

/** A fetch that never resolves until aborted (simulates a hung upstream). */
export function hangingResponse(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
  });
}

export const CF_CHALLENGE_HTML =
  '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-platform"></div></body></html>';
