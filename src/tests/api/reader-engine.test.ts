import { describe, expect, it } from "vitest";
import { GET as capabilitiesGET } from "@/app/api/sources/capabilities/route";
import { POST as reportsPOST } from "@/app/api/reports/route";
import { READER_VERIFICATION } from "@/lib/providers/verification";
import { resetReports } from "@/lib/providers/reports";
import { get, post } from "./request";

describe("GET /api/sources/capabilities", () => {
  it("only reports native-reader verification for ledger providers", async () => {
    const res = await capabilitiesGET(get("/api/sources/capabilities"), { params: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: { id: string; declared: { pages: boolean }; verified: { nativeReader: boolean } }[]; totals: Record<string, number> };
    const verified = body.providers.filter((p) => p.verified.nativeReader).map((p) => p.id).sort();
    expect(verified).toEqual(Object.keys(READER_VERIFICATION).sort());
    // verified implies an implemented page API
    for (const p of body.providers) if (p.verified.nativeReader) expect(p.declared.pages).toBe(true);
    expect(body.totals.nativeReaderVerified).toBe(verified.length);
    expect(body.totals.registered).toBeGreaterThan(verified.length);
  });
});

describe("POST /api/reports", () => {
  it("accepts reader failure reports without touching provider health", async () => {
    resetReports();
    const res = await reportsPOST(post("/api/reports", { sourceId: "mangadex", kind: "pages", fallback: { attempted: true, succeeded: true, toSourceId: "dynasty-reader" } }), { params: {} });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true, totals: { total: 1, fallbacks: 1, fallbackSucceeded: 1 } });
    const caps = (await (await capabilitiesGET(get("/api/sources/capabilities"), { params: {} })).json()) as { providers: { id: string; availability: { circuit: string; failures: number; readerReports: { total: number } } }[] };
    const md = caps.providers.find((p) => p.id === "mangadex")!;
    expect(md.availability.readerReports.total).toBe(1);
    expect(md.availability.failures).toBe(0);
    expect(md.availability.circuit).toBe("closed");
  });

  it("validates input", async () => {
    expect((await reportsPOST(post("/api/reports", { sourceId: "mangadex", kind: "nope" }), { params: {} })).status).toBe(400);
    expect((await reportsPOST(post("/api/reports", { sourceId: "no-such-source", kind: "pages" }), { params: {} })).status).toBe(404);
  });
});
