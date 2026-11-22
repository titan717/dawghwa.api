import { beforeEach, describe, expect, it } from "vitest";
import { getAllScrapers } from "@/lib/scrapers";
import { DawghwaError } from "@/lib/core/errors";
import { resetConfig } from "@/lib/core/config";
import { getRegistry, resetRegistry } from "@/lib/providers/registry";
import { EXPERIMENTAL_SOURCE_IDS } from "@/lib/providers/status";
import { ADAPTER_DOMAINS } from "@/lib/providers/manifest.generated";
import { htmlResponse, mockFetch } from "../helpers";

/**
 * Contract tests run against every adapter with the network mocked. They do
 * not prove a site works today (see `npm run test:live` / health report);
 * they prove each adapter is registered correctly and fails safely.
 */
const scrapers = getAllScrapers();
const ids = scrapers.map((s) => s.getId());

describe("adapter registry", () => {
  it("has 96 adapters with unique ids and names", () => {
    expect(scrapers.length).toBe(96);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(scrapers.map((s) => s.getName())).size).toBe(ids.length);
  });

  it("every adapter has a domain manifest entry (regenerate with npm run manifest)", () => {
    for (const s of scrapers) expect(ADAPTER_DOMAINS[s.getName()], s.getName()).toBeDefined();
  });

  it("resolves aliases", () => {
    expect(getRegistry().get("writers-scans")?.id).toBe("writers'-scans");
    expect(getRegistry().get("MangaDex")?.id).toBe("mangadex");
  });

  it("leaves experimental adapters out unless EXPERIMENTAL_PROVIDERS names them", () => {
    const experimental = ids.filter((id) => EXPERIMENTAL_SOURCE_IDS.has(id));
    expect(experimental).toEqual(["comix"]);
    expect(getRegistry().all().length).toBe(96 - experimental.length);
    for (const id of experimental) expect(getRegistry().get(id), id).toBeUndefined();
  });

  it("orders providers by priority", () => {
    expect(getRegistry().all()[0].id).toBe("mangadex");
  });
});

describe.each(ids.map((id) => [id]))("adapter %s", (id) => {
  const provider = () => getRegistry().get(id)!;

  // Contract-test experimental adapters too (network is mocked), with the flag on.
  beforeEach(() => {
    if (!EXPERIMENTAL_SOURCE_IDS.has(id)) return;
    process.env.EXPERIMENTAL_PROVIDERS = id;
    resetConfig();
    resetRegistry();
  });

  it("owns its base URL and rejects look-alike hosts", () => {
    const p = provider();
    const base = new URL(p.descriptor.baseUrl);
    expect(p.ownsUrl(base)).toBe(true);
    expect(p.ownsUrl(new URL(`https://evil.example/?u=${base.hostname}`))).toBe(false);
    expect(p.ownsUrl(new URL(`https://${base.hostname}.evil.example/`))).toBe(false);
    expect(p.scraper.canHandle(p.descriptor.baseUrl + "/")).toBe(true);
  });

  it("describes capabilities", () => {
    const c = provider().capabilities;
    expect(c.search && c.chapters).toBe(true);
    expect(typeof c.chapterPages).toBe("boolean");
  });

  it("fails safely (typed error or empty array) when the site returns an unexpected page", async () => {
    const p = provider();
    if (!p.operational) {
      await expect(p.run("search", () => p.scraper.search("x"))).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
      return;
    }
    mockFetch(() => htmlResponse("<html><head><title>Maintenance</title></head><body></body></html>"));
    try {
      const { value } = await p.run("search", () => p.scraper.search("test"), { timeoutMs: 4_000 });
      expect(Array.isArray(value)).toBe(true);
      expect(value.length).toBe(0); // never invents results
    } catch (e) {
      expect(e).toBeInstanceOf(DawghwaError);
    }
  });

  it("reports an outage instead of silently returning [] when the site is down", async () => {
    const p = provider();
    if (!p.operational) return;
    mockFetch(() => new Response("Service Unavailable", { status: 503 }));
    await expect(p.run("search", () => p.scraper.search("test"), { timeoutMs: 4_000 })).rejects.toBeInstanceOf(
      DawghwaError,
    );
  });
});
