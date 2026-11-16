import { describe, expect, it } from "vitest";
import { GET as proxyGET } from "@/app/api/proxy/html/route";
import { setResolver } from "@/lib/core/net-guard";
import { htmlResponse, mockFetch } from "../helpers";
import { get } from "./request";

const proxy = (url: string) => proxyGET(get(`/api/proxy/html?url=${encodeURIComponent(url)}`));

describe("GET /api/proxy/html security", () => {
  it.each([
    // upstream's unanchored regex accepted these
    "https://evil.example/?u=https://weebcentral.com",
    "https://evil.example/https://asuracomic.net/",
    "https://weebcentral.com.evil.example/",
    // not https / odd ports / credentials
    "http://weebcentral.com/",
    "https://weebcentral.com:8443/",
    "https://user:pass@weebcentral.com/",
    // private network
    "https://169.254.169.254/",
    "https://localhost/",
    // non-client-only sources are not proxied
    "https://mangadex.org/",
  ])("rejects %s without any upstream request", async (url) => {
    const f = mockFetch(() => htmlResponse("x"));
    const res = await proxy(url);
    expect([400, 403]).toContain(res.status);
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects a missing url", async () => {
    const res = await proxyGET(get("/api/proxy/html"));
    expect(res.status).toBe(400);
  });

  it("proxies allowlisted HTML with a sandboxing CSP", async () => {
    mockFetch(() => htmlResponse("<html><script>alert(1)</script></html>"));
    const res = await proxy("https://weebcentral.com/search");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("re-validates redirect targets", async () => {
    mockFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    const res = await proxy("https://weebcentral.com/x");
    expect(res.status).toBe(403);
  });

  it("refuses allowlisted hosts that resolve to private addresses (DNS rebinding)", async () => {
    setResolver(async () => ["10.0.0.1"]);
    const f = mockFetch(() => htmlResponse("x"));
    const res = await proxy("https://weebcentral.com/");
    expect(res.status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it("does not forward non-HTML content", async () => {
    mockFetch(() => new Response("{}", { headers: { "content-type": "application/json" } }));
    const res = await proxy("https://weebcentral.com/api");
    expect(res.status).toBe(403);
  });
});
