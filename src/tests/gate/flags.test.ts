import { afterEach, describe, expect, it } from "vitest";
import { isProviderEnabled, isProviderServed, providerFlagName, providerFlagOn, providerGatesMode, providerGateStatus } from "@/lib/gate/flags";
import { describeProvider } from "@/lib/api/sources";
import { getRegistry, resetRegistry } from "@/lib/providers/registry";

const KEYS = ["PROVIDER_GATES", "PROVIDER_MANGADEX", "PROVIDER_DYNASTY_READER"];
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  resetRegistry();
});

describe("provider flags", () => {
  it("derives flag names", () => {
    expect(providerFlagName("dynasty-reader")).toBe("PROVIDER_DYNASTY_READER");
    expect(providerFlagName("writers'-scans")).toBe("PROVIDER_WRITERS_SCANS");
    expect(providerFlagName("mangadex")).toBe("PROVIDER_MANGADEX");
  });

  it("reads on values only", () => {
    for (const v of ["on", "1", "true", "YES"]) expect(providerFlagOn("x", { PROVIDER_X: v })).toBe(true);
    for (const v of ["off", "0", "", "enabled"]) expect(providerFlagOn("x", { PROVIDER_X: v })).toBe(false);
    expect(providerFlagOn("x", {})).toBe(false);
  });

  it("defaults to report mode", () => {
    expect(providerGatesMode({})).toBe("report");
    expect(providerGatesMode({ PROVIDER_GATES: "report" })).toBe("report");
    expect(providerGatesMode({ PROVIDER_GATES: "bogus" })).toBe("report");
    expect(providerGatesMode({ PROVIDER_GATES: " Enforce " })).toBe("enforce");
  });

  it("isProviderEnabled is strict in both modes; isProviderServed follows the mode", () => {
    expect(isProviderEnabled("x", {})).toBe(false);
    expect(isProviderEnabled("x", { PROVIDER_GATES: "report" })).toBe(false);
    expect(isProviderEnabled("x", { PROVIDER_X: "on" })).toBe(true);
    expect(isProviderServed("x", {})).toBe(true);
    expect(isProviderServed("x", { PROVIDER_GATES: "enforce" })).toBe(false);
    expect(isProviderServed("x", { PROVIDER_GATES: "enforce", PROVIDER_X: "on" })).toBe(true);
    expect(providerGateStatus("x", { PROVIDER_GATES: "enforce" })).toEqual({ flag: "PROVIDER_X", flagOn: false, mode: "enforce", served: false });
  });
});

describe("registry under PROVIDER_GATES", () => {
  it("report mode (default): same sources served as before, gate status reported", () => {
    const ops = getRegistry().operational().length;
    expect(ops).toBeGreaterThan(50);
    const md = getRegistry().get("mangadex")!;
    expect(md.operational).toBe(true);
    expect(describeProvider(md).gate).toEqual({ flag: "PROVIDER_MANGADEX", flagOn: false, mode: "report", served: true });
  });

  it("enforce mode: only flagged sources are served", () => {
    process.env.PROVIDER_GATES = "enforce";
    process.env.PROVIDER_MANGADEX = "on";
    resetRegistry();
    const ops = getRegistry().operational().map((p) => p.id);
    expect(ops).toEqual(["mangadex"]);
    const other = getRegistry().get("dynasty-reader")!;
    expect(other.operational).toBe(false);
    expect(other.isDisabled).toBe(true);
    expect(describeProvider(other).gate).toMatchObject({ mode: "enforce", served: false });
  });

  it("enforce mode with no flags serves nothing", () => {
    process.env.PROVIDER_GATES = "enforce";
    resetRegistry();
    expect(getRegistry().operational()).toHaveLength(0);
  });
});

describe("health output under PROVIDER_GATES", () => {
  it("reports the mode and marks gated sources", async () => {
    process.env.PROVIDER_GATES = "enforce";
    resetRegistry();
    const { GET } = await import("@/app/api/health/route");
    const { get } = await import("../api/request");
    const res = await GET(get("/api/health"));
    const body = JSON.parse(await res.text());
    expect(body.gates).toMatchObject({ mode: "enforce", served: 0 });
    expect(body.gates.total).toBeGreaterThan(50);
    const md = body.unavailable.find((u: { id: string }) => u.id === "mangadex");
    expect(md.status).toBe("gated");
  });
});
