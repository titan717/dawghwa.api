import { describe, expect, it } from "vitest";
import { resetConfig } from "@/lib/core/config";
import { upstreamText } from "@/lib/core/http";
import { getRegistry, isSourceEnabled, resetRegistry } from "@/lib/providers/registry";
import { normalizeChapters, normalizeSearchResults } from "@/lib/providers/normalize";
import { hangingResponse, mockFetch } from "../helpers";

function mangadex() {
  const p = getRegistry().get("mangadex");
  if (!p) throw new Error("mangadex missing");
  return p;
}

describe("Provider.run", () => {
  it("enforces the per-operation timeout and cancels the underlying work", async () => {
    let aborted = false;
    mockFetch((_u, init) => {
      init.signal?.addEventListener("abort", () => (aborted = true));
      return hangingResponse(init);
    });
    const p = mangadex();
    const t0 = Date.now();
    await expect(p.run("search", () => upstreamText("https://api.mangadex.org/x"), { timeoutMs: 50 })).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
    });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(aborted).toBe(true); // upstream leaked the fetch; Dawghwa aborts it
  });

  it("reports client cancellation as CANCELLED and does not trip the breaker", async () => {
    mockFetch((_u, init) => hangingResponse(init));
    const p = mangadex();
    const c = new AbortController();
    const run = p.run("search", () => upstreamText("https://api.mangadex.org/y"), { signal: c.signal });
    setTimeout(() => c.abort(), 10);
    await expect(run).rejects.toMatchObject({ code: "CANCELLED" });
    expect(p.circuit().consecutiveFailures).toBe(0);
  });

  it("promotes swallowed failures (empty result + all upstream requests failed)", async () => {
    mockFetch(() => new Response("down", { status: 500 }));
    const p = mangadex();
    await expect(
      p.run("search", async () => {
        try {
          await upstreamText("https://api.mangadex.org/z");
        } catch {
          /* adapter swallows */
        }
        return [];
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_HTTP_ERROR" });
  });

  it("an empty result after a successful request is a real empty result", async () => {
    mockFetch(() => new Response("[]", { status: 200 }));
    const p = mangadex();
    const r = await p.run("search", async () => {
      await upstreamText("https://api.mangadex.org/ok");
      return [];
    });
    expect(r.value).toEqual([]);
  });

  it("opens the circuit after repeated failures and fails fast", async () => {
    process.env.BREAKER_FAILURE_THRESHOLD = "2";
    resetConfig();
    resetRegistry();
    const p = mangadex();
    const fail = () => p.run("search", async () => Promise.reject(new TypeError("fetch failed")));
    await expect(fail()).rejects.toBeDefined();
    await expect(fail()).rejects.toBeDefined();
    let called = false;
    await expect(
      p.run("search", async () => {
        called = true;
        return [];
      }),
    ).rejects.toMatchObject({ code: "SOURCE_CIRCUIT_OPEN" });
    expect(called).toBe(false);
    // health probes may pass as the half-open trial
    const probe = await p.run("health", async () => ["ok"], { probe: true });
    expect(probe.value).toEqual(["ok"]);
    expect(p.circuit().state).toBe("closed");
    delete process.env.BREAKER_FAILURE_THRESHOLD;
  });

  it("refuses shut-down sources", async () => {
    const p = getRegistry().get("mangapark")!;
    expect(p.operational).toBe(false);
    await expect(p.run("search", async () => [])).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it("honours DISABLED_SOURCES", () => {
    process.env.DISABLED_SOURCES = "mangadex";
    resetConfig();
    resetRegistry();
    expect(getRegistry().get("mangadex")!.operational).toBe(false);
    delete process.env.DISABLED_SOURCES;
  });

  it("keeps experimental providers out of the registry unless EXPERIMENTAL_PROVIDERS names them", () => {
    expect(getRegistry().get("comix")).toBeUndefined();
    expect(getRegistry().operational().some((p) => p.id === "comix")).toBe(false);
    expect(getRegistry().forUrl(new URL("https://comix.to/title/x"))).toBeUndefined();
    process.env.EXPERIMENTAL_PROVIDERS = " Comix ";
    resetConfig();
    resetRegistry();
    expect(getRegistry().get("comix")?.operational).toBe(true);
    expect(isSourceEnabled("comix", [])).toBe(false);
    expect(isSourceEnabled("mangadex", [])).toBe(true);
  });
});

describe("normalize", () => {
  it("makes URLs absolute, trims, dedupes and drops invalid entries", () => {
    const { results, dropped } = normalizeSearchResults(
      [
        { id: "1", title: "  Solo   Leveling ", url: "/manga/1", coverImage: "/c.jpg", latestChapter: "12", lastUpdated: "" },
        { id: "1", title: "Solo Leveling", url: "https://x.example/manga/1", latestChapter: 12, lastUpdated: "" },
        { id: "2", title: "", url: "/manga/2", latestChapter: 1, lastUpdated: "" },
        { id: "3", title: "Bad", url: "javascript:alert(1)", latestChapter: 1, lastUpdated: "" },
      ],
      "https://x.example",
    );
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Solo Leveling");
    expect(results[0].url).toBe("https://x.example/manga/1");
    expect(dropped).toBe(3);
  });

  it("normalizes chapters", () => {
    const { chapters } = normalizeChapters(
      [
        { id: "a", number: 1, title: "Ch 1", url: "/c/1" },
        { id: "a", number: 1, title: "Ch 1", url: "/c/1" },
        { id: "b", number: Number.NaN, title: "x", url: "/c/2" },
      ],
      "https://x.example",
    );
    expect(chapters.length).toBeGreaterThanOrEqual(1);
    expect(chapters[0].url).toBe("https://x.example/c/1");
    expect(chapters.every((c) => Number.isFinite(c.number))).toBe(true);
  });
});
