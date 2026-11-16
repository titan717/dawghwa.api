import { describe, expect, it } from "vitest";
import { assertPublicDestination, isPrivateAddress } from "@/lib/core/net-guard";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1",
  ])("%s is private", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700::1111"])("%s is public", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe("assertPublicDestination", () => {
  it.each([
    "ftp://example.com/",
    "file:///etc/passwd",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "http://localhost/",
    "http://foo.internal/",
    "http://[::1]/",
    "http://10.0.0.1/",
  ])("rejects %s", async (url) => {
    await expect(assertPublicDestination(url)).rejects.toMatchObject({ code: "PROXY_FORBIDDEN" });
  });

  it("accepts public hosts", async () => {
    await expect(assertPublicDestination("https://mangadex.org/")).resolves.toBeUndefined();
  });
});
