import { describe, expect, it } from "vitest";
import { EXPIRY_BUCKET_SECONDS, signImageToken, verifyImageToken } from "@/lib/v2/token";

const SECRET = "test-secret-0123456789abcdef-0123456789";
const URL_ = "https://uploads.mangadex.org/data/0123456789abcdef0123/1-abc.jpg";
const T0 = Date.UTC(2026, 10, 22, 12, 1, 0); // mid-bucket

describe("v2 image tokens", () => {
  it("round-trips the source and URL", () => {
    const { token, exp } = signImageToken({ sourceId: "mangadex", url: URL_ }, SECRET, 1800, T0);
    const v = verifyImageToken(token, SECRET, T0 + 1000);
    expect(v).toEqual({ ok: true, claims: { sourceId: "mangadex", url: URL_, exp } });
  });

  it("never contains the upstream URL, host or source id in clear or base64 form", () => {
    const { token } = signImageToken({ sourceId: "mangadex", url: URL_ }, SECRET, 1800, T0);
    const lower = token.toLowerCase();
    for (const s of ["mangadex", "uploads", "https", ".jpg"]) expect(lower).not.toContain(s);
    const decoded = Buffer.from(token.split(".")[0]!, "base64url").toString("latin1").toLowerCase();
    expect(decoded).not.toContain("mangadex");
    expect(decoded).not.toContain("https");
  });

  it("rounds expiry up to a bucket and is deterministic inside it (cacheable URLs)", () => {
    const a = signImageToken({ sourceId: "s", url: URL_ }, SECRET, 1800, T0);
    const b = signImageToken({ sourceId: "s", url: URL_ }, SECRET, 1800, T0 + 5_000);
    expect(a.exp % EXPIRY_BUCKET_SECONDS).toBe(0);
    expect(a.exp).toBeGreaterThanOrEqual(T0 / 1000 + 1800);
    expect(a.exp).toBeLessThan(T0 / 1000 + 1800 + EXPIRY_BUCKET_SECONDS);
    expect(b.token).toBe(a.token);
    const other = signImageToken({ sourceId: "s", url: URL_.replace("1-abc", "2-abc") }, SECRET, 1800, T0);
    expect(other.token).not.toBe(a.token);
  });

  it("rejects an expired token", () => {
    const { token, exp } = signImageToken({ sourceId: "s", url: URL_ }, SECRET, 300, T0);
    expect(verifyImageToken(token, SECRET, exp * 1000 - 1).ok).toBe(true);
    expect(verifyImageToken(token, SECRET, exp * 1000)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects tampering with the payload or the MAC, and other secrets", () => {
    const { token } = signImageToken({ sourceId: "s", url: URL_ }, SECRET, 1800, T0);
    const [body, mac] = token.split(".") as [string, string];
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
    expect(verifyImageToken(`${flip(body, 10)}.${mac}`, SECRET, T0)).toEqual({ ok: false, reason: "signature" });
    expect(verifyImageToken(`${body}.${flip(mac, 5)}`, SECRET, T0)).toEqual({ ok: false, reason: "signature" });
    expect(verifyImageToken(`${body}.${mac.slice(0, -4)}`, SECRET, T0)).toEqual({ ok: false, reason: "signature" });
    expect(verifyImageToken(token, `${SECRET}-other`, T0)).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects malformed input", () => {
    for (const t of ["", "abc", "a.b.c", "../etc/passwd", "x".repeat(5000) + ".y", "a b.c"]) {
      expect(verifyImageToken(t, SECRET, T0)).toEqual({ ok: false, reason: "malformed" });
    }
  });
});
