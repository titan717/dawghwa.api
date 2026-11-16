import { describe, expect, it } from "vitest";
import { detectChallenge } from "@/lib/core/antibot";
import { DawghwaError, UpstreamHttpError, isSourceFailure, toDawghwaError, toErrorBody } from "@/lib/core/errors";
import { CF_CHALLENGE_HTML } from "../helpers";

describe("detectChallenge", () => {
  it("detects Cloudflare challenge pages", () => {
    expect(detectChallenge(CF_CHALLENGE_HTML)).toEqual({ blocked: true, vendor: "cloudflare" });
    expect(detectChallenge("", new Headers({ "cf-mitigated": "challenge" })).blocked).toBe(true);
  });
  it("does not flag normal pages that merely load Cloudflare-hosted assets", () => {
    const html = '<html><head><title>Manga</title><script src="https://cdnjs.cloudflare.com/x.js"></script></head></html>';
    expect(detectChallenge(html).blocked).toBe(false);
  });
});

describe("errors", () => {
  it("maps legacy adapter messages", () => {
    expect(toDawghwaError(new Error("HTTP 403: Forbidden")).code).toBe("UPSTREAM_HTTP_ERROR");
    expect(toDawghwaError(new Error("Search failed: 429")).code).toBe("UPSTREAM_RATE_LIMITED");
    expect(toDawghwaError(new TypeError("fetch failed")).code).toBe("UPSTREAM_NETWORK_ERROR");
    const abort = new Error("x");
    abort.name = "AbortError";
    expect(toDawghwaError(abort).code).toBe("UPSTREAM_TIMEOUT");
    expect(toDawghwaError(new Error("weird")).code).toBe("UPSTREAM_ERROR");
  });

  it("404s are not source failures; 5xx are", () => {
    expect(isSourceFailure(new UpstreamHttpError(404, "https://x.example"))).toBe(false);
    expect(isSourceFailure(new UpstreamHttpError(502, "https://x.example"))).toBe(true);
    expect(isSourceFailure(new DawghwaError("VALIDATION_ERROR", "bad"))).toBe(false);
  });

  it("hides internal reasons unless details are explicitly exposed", () => {
    const err = toDawghwaError(new Error("secret internal stack /srv/app token=abc"));
    const body = toErrorBody(err, "req-1");
    expect(JSON.stringify(body)).not.toContain("token=abc");
    expect(body).toMatchObject({ code: "UPSTREAM_ERROR", requestId: "req-1" });
    expect(JSON.stringify(toErrorBody(err, "r", true))).toContain("token=abc");
  });
});
