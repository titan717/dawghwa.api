import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DawghwaError } from "./errors";

/**
 * Outbound destination guard (SSRF defence in depth).
 *
 * Every upstream request made through the shared HTTP client is checked:
 * only http/https, default ports, no credentials, and the destination host
 * must not be (or resolve to) a loopback, private, link-local, CGNAT,
 * multicast or otherwise reserved address. DNS answers are cached briefly.
 */

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (family === 6) {
    const a = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (a === "::" || a === "::1") return true;
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a)) return true; // hex-mapped v4: refuse
    const first = parseInt(a.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (a.startsWith("64:ff9b:") || a.startsWith("2001:db8:") || a.startsWith("100::")) return true;
    return false;
  }
  return false;
}

type Resolver = (host: string) => Promise<string[]>;
let resolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);
const dnsCache = new Map<string, { addrs: string[]; expires: number }>();

/** Test hook. */
export function setResolver(fn: Resolver | null): void {
  resolver = fn ?? (async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address));
  dnsCache.clear();
}

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|localdomain)$/i;

export async function assertPublicDestination(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DawghwaError("PROXY_FORBIDDEN", "Invalid destination URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DawghwaError("PROXY_FORBIDDEN", "Only http(s) destinations are allowed");
  }
  if (url.username || url.password) {
    throw new DawghwaError("PROXY_FORBIDDEN", "Destination URLs must not contain credentials");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new DawghwaError("PROXY_FORBIDDEN", "Destination port is not allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (BLOCKED_NAMES.test(host)) {
    throw new DawghwaError("PROXY_FORBIDDEN", "Destination host is not allowed");
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new DawghwaError("PROXY_FORBIDDEN", "Destination address is not allowed");
    return;
  }
  const now = Date.now();
  let entry = dnsCache.get(host);
  if (!entry || entry.expires < now) {
    let addrs: string[];
    try {
      addrs = await resolver(host);
    } catch {
      return; // unresolvable: the fetch itself will fail with a network error
    }
    entry = { addrs, expires: now + 60_000 };
    if (dnsCache.size > 2_000) dnsCache.clear();
    dnsCache.set(host, entry);
  }
  if (entry.addrs.some(isPrivateAddress)) {
    throw new DawghwaError("PROXY_FORBIDDEN", "Destination resolves to a private or reserved address");
  }
}
