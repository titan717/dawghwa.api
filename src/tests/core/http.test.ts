import { describe, expect, it } from "vitest";
import { httpStats, upstreamFetch, upstreamText } from "@/lib/core/http";
import { resetConfig } from "@/lib/core/config";
import { newStats, runWithContext } from "@/lib/core/context";
import { setResolver } from "@/lib/core/net-guard";
import { CF_CHALLENGE_HTML, hangingResponse, htmlResponse, mockFetch } from "../helpers";

function inContext<T>(fn: () => Promise<T>, deadlineMs = 5_000) {
  const stats = newStats();
  const controller = new AbortController();
  return runWithContext(
    { providerId: "test", signal: controller.signal, deadline: Date.now() + deadlineMs, stats },
    fn,
  ).then((value) => ({ value, stats }));
}

describe("upstreamFetch", () => {
  it("retries 5xx with backoff and succeeds", async () => {
    let n = 0;
    const f = mockFetch(() => (++n < 3 ? new Response("err", { status: 502 }) : htmlResponse("ok")));
    const { value, stats } = await inContext(() => upstreamText("https://example.com/a"));
    expect(value).toBe("ok");
    expect(f).toHaveBeenCalledTimes(3);
    expect(stats.retries).toBe(2);
  });

  it("gives up after the configured retries and returns the last response", async () => {
    process.env.UPSTREAM_RETRIES = "1";
    resetConfig();
    const f = mockFetch(() => new Response("err", { status: 503 }));
    const res = await upstreamFetch("https://example.com/b");
    expect(res.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(2);
    delete process.env.UPSTREAM_RETRIES;
  });

  it("does not retry 403/404 (upstream retried every error 3x)", async () => {
    const f = mockFetch(() => new Response("nope", { status: 403 }));
    expect((await upstreamFetch("https://example.com/c")).status).toBe(403);
    expect(f).toHaveBeenCalledTimes(1);
    const g = mockFetch(() => new Response("missing", { status: 404 }));
    expect((await upstreamFetch("https://example.com/d")).status).toBe(404);
    expect(g).toHaveBeenCalledTimes(1);
  });

  it("classifies anti-bot challenges as UPSTREAM_BLOCKED without retrying", async () => {
    const f = mockFetch(() => htmlResponse(CF_CHALLENGE_HTML, { status: 403 }));
    await expect(upstreamFetch("https://example.com/e")).rejects.toMatchObject({ code: "UPSTREAM_BLOCKED" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("times out hung requests per attempt", async () => {
    process.env.UPSTREAM_TIMEOUT_MS = "30";
    process.env.UPSTREAM_RETRIES = "0";
    resetConfig();
    mockFetch((_u, init) => hangingResponse(init));
    const t0 = Date.now();
    await expect(upstreamFetch("https://example.com/slow")).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(1_000);
    delete process.env.UPSTREAM_TIMEOUT_MS;
    delete process.env.UPSTREAM_RETRIES;
  });

  it("respects the operation deadline and caller cancellation", async () => {
    mockFetch((_u, init) => hangingResponse(init));
    const t0 = Date.now();
    await expect(inContext(() => upstreamFetch("https://example.com/x"), 50)).rejects.toBeDefined();
    expect(Date.now() - t0).toBeLessThan(1_000);

    const c = new AbortController();
    const p = upstreamFetch("https://example.com/y", { signal: c.signal });
    c.abort(new Error("client went away"));
    await expect(p).rejects.toBeDefined();
  });

  it("retries network errors", async () => {
    let n = 0;
    mockFetch(() => {
      if (++n === 1) throw new TypeError("fetch failed");
      return htmlResponse("ok");
    });
    expect(await upstreamText("https://example.com/net")).toBe("ok");
  });

  it("deduplicates identical concurrent GETs and each caller gets a readable body", async () => {
    const f = mockFetch(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return htmlResponse("shared");
    });
    const bodies = await Promise.all(
      Array.from({ length: 5 }, () => upstreamFetch("https://example.com/same").then((r) => r.text())),
    );
    expect(bodies).toEqual(Array(5).fill("shared"));
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("uses ETag conditional requests and serves the cached body on 304", async () => {
    let calls = 0;
    const f = mockFetch((_u, init) => {
      calls++;
      const inm = new Headers(init.headers).get("if-none-match");
      if (inm === '"v1"') return new Response(null, { status: 304 });
      return htmlResponse("body-v1", { headers: { etag: '"v1"' } });
    });
    expect(await upstreamText("https://example.com/etag")).toBe("body-v1");
    const { value, stats } = await inContext(() => upstreamText("https://example.com/etag"));
    expect(value).toBe("body-v1");
    expect(stats.conditionalHits).toBe(1);
    expect(calls).toBe(2);
    expect(new Headers(f.mock.calls[1][1]!.headers).get("if-none-match")).toBe('"v1"');
  });

  it("does not store no-store responses for conditional requests", async () => {
    const f = mockFetch(() => htmlResponse("x", { headers: { etag: '"a"', "cache-control": "no-store" } }));
    await upstreamText("https://example.com/nostore");
    await upstreamText("https://example.com/nostore");
    expect(new Headers(f.mock.calls[1][1]!.headers).get("if-none-match")).toBeNull();
  });

  it("enforces the response size limit", async () => {
    process.env.UPSTREAM_MAX_RESPONSE_BYTES = String(64 * 1024);
    resetConfig();
    mockFetch(() => htmlResponse("x".repeat(70 * 1024)));
    await expect(upstreamFetch("https://example.com/big")).rejects.toMatchObject({
      code: "UPSTREAM_RESPONSE_TOO_LARGE",
    });
    delete process.env.UPSTREAM_MAX_RESPONSE_BYTES;
  });

  it("refuses private destinations, including via redirects", async () => {
    const f = mockFetch(() => htmlResponse("secret"));
    await expect(upstreamFetch("http://127.0.0.1/")).rejects.toMatchObject({ code: "PROXY_FORBIDDEN" });
    await expect(upstreamFetch("http://169.254.169.254/latest/meta-data")).rejects.toMatchObject({
      code: "PROXY_FORBIDDEN",
    });
    expect(f).not.toHaveBeenCalled();

    setResolver(async (host) => (host === "internal.example" ? ["10.0.0.5"] : ["93.184.216.34"]));
    await expect(upstreamFetch("https://internal.example/")).rejects.toMatchObject({ code: "PROXY_FORBIDDEN" });

    mockFetch((url) =>
      url.startsWith("https://public.example")
        ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
        : htmlResponse("metadata"),
    );
    await expect(upstreamFetch("https://public.example/r")).rejects.toMatchObject({ code: "PROXY_FORBIDDEN" });
  });

  it("follows safe redirects and reports the final URL", async () => {
    mockFetch((url) =>
      url === "https://a.example/start"
        ? new Response(null, { status: 301, headers: { location: "/final" } })
        : htmlResponse("done"),
    );
    const res = await upstreamFetch("https://a.example/start");
    expect(await res.text()).toBe("done");
    expect(res.url).toBe("https://a.example/final");
  });

  it("exposes limiter stats", async () => {
    mockFetch(() => htmlResponse("ok"));
    await inContext(() => upstreamText("https://example.com/s"));
    expect(httpStats()).toBeDefined();
  });
});
