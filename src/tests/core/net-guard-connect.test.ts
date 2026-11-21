/**
 * Finding 5 (PR #6 review): the destination check must bind the address that
 * is actually dialled. assertPublicDestination resolves once; a rebinding DNS
 * name can answer differently when the socket connects. guardedFetch checks
 * the connect-time answer.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPublicDestination, guardedFetch, guardedLookup, setConnectLookup, setGuardedFetchImpl, setResolver } from "@/lib/core/net-guard";

const lookupWith = (address: string, family = 4) => (_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
  cb(null, [{ address, family }]);
const run = (host: string, all = false) =>
  new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) =>
    guardedLookup(host, { all }, (err, address) => resolve({ err, address })),
  );

afterEach(() => setConnectLookup(null));

describe("guardedLookup (connect-time resolver)", () => {
  it("refuses private, loopback, link-local and metadata answers", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "100.64.0.1"]) {
      setConnectLookup(lookupWith(ip) as never);
      expect((await run("cdn.example")).err?.code, ip).toBe("EDAWGHWA_FORBIDDEN_DESTINATION");
    }
    setConnectLookup(lookupWith("::1", 6) as never);
    expect((await run("cdn.example")).err?.code).toBe("EDAWGHWA_FORBIDDEN_DESTINATION");
  });

  it("refuses when any one of several answers is private", async () => {
    setConnectLookup(((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
      cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }])) as never);
    expect((await run("cdn.example", true)).err?.code).toBe("EDAWGHWA_FORBIDDEN_DESTINATION");
  });

  it("passes public answers through in both lookup shapes", async () => {
    setConnectLookup(lookupWith("93.184.216.34") as never);
    expect(await run("cdn.example")).toEqual({ err: null, address: "93.184.216.34" });
    expect((await run("cdn.example", true)).address).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("refuses blocked internal names before resolving", async () => {
    const spy = vi.fn();
    setConnectLookup(spy as never);
    expect((await run("metadata.internal")).err?.code).toBe("EDAWGHWA_FORBIDDEN_DESTINATION");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("guardedFetch against a real socket", () => {
  let server: Server;
  let port: number;
  beforeEach(async () => {
    // the offline test setup stubs fetch; this test only talks to a loopback server it owns
    vi.unstubAllGlobals();
    setGuardedFetchImpl(null); // exercise the production path (undici's fetch + guarded Agent)
    server = createServer((_req, res) => res.end("private data"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("a name that passes the pre-flight check but rebinds to loopback at connect time is refused", async () => {
    setResolver(async () => ["93.184.216.34"]); // pre-flight answer: public
    setConnectLookup(lookupWith("127.0.0.1") as never); // connect-time answer: loopback
    const url = `http://rebind.example:${port}/`;
    await expect(assertPublicDestination(url.replace(`:${port}`, ""))).resolves.toBeUndefined();
    const err = await guardedFetch(url).then(() => null, (e: Error & { cause?: { code?: string } }) => e);
    expect(err).not.toBeNull();
    expect(err!.cause?.code).toBe("EDAWGHWA_FORBIDDEN_DESTINATION");
  });

  it("control: the same server is reachable when the connect-time lookup is not guarded", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe("private data");
  });
});
