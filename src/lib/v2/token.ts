import { createCipheriv, createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Opaque, short-lived image tokens for /api/v2/img/<token>.
 *
 *   token   = b64url(VERSION | iv[12] | ciphertext | gcmTag[16]) "." b64url(HMAC-SHA256(macKey, part1))
 *   payload = {"s": sourceId, "u": upstreamUrl, "e": expiryUnixSeconds}
 *
 * The payload is encrypted (AES-256-GCM), so neither the upstream URL nor the
 * source id appears in the token, and the whole token is authenticated with
 * HMAC-SHA256 (checked first, in constant time) before anything is decrypted.
 * Keys are derived from IMAGE_PROXY_SECRET with HKDF (separate enc/mac keys).
 *
 * Encryption is deterministic (IV = HMAC(ivKey, plaintext)[0..12]) and expiry
 * is rounded up to a bucket, so the same page issued twice within a bucket has
 * the same URL and browser/CDN caches hit. Determinism only reveals that two
 * tokens are equal, which the URL already does.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const EXPIRY_BUCKET_SECONDS = 600;
export const MAX_TOKEN_LENGTH = 4096;

export interface ImageClaims {
  sourceId: string;
  url: string;
  /** Unix seconds. */
  exp: number;
}

export type VerifyResult = { ok: true; claims: ImageClaims } | { ok: false; reason: "malformed" | "signature" | "expired" };

interface Keys {
  enc: Buffer;
  mac: Buffer;
  iv: Buffer;
}

const keyCache = new Map<string, Keys>();

function keys(secret: string): Keys {
  let k = keyCache.get(secret);
  if (!k) {
    const derive = (info: string) => Buffer.from(hkdfSync("sha256", secret, "dawghwa-v2-img", info, 32));
    k = { enc: derive("enc"), mac: derive("mac"), iv: derive("iv") };
    if (keyCache.size > 4) keyCache.clear();
    keyCache.set(secret, k);
  }
  return k;
}

const b64url = (b: Buffer) => b.toString("base64url");

export function signImageToken(
  claims: { sourceId: string; url: string },
  secret: string,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): { token: string; exp: number } {
  const k = keys(secret);
  const exp = Math.ceil((nowMs / 1000 + ttlSeconds) / EXPIRY_BUCKET_SECONDS) * EXPIRY_BUCKET_SECONDS;
  const plain = Buffer.from(JSON.stringify({ s: claims.sourceId, u: claims.url, e: exp }), "utf8");
  const iv = createHmac("sha256", k.iv).update(plain).digest().subarray(0, IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", k.enc, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const body = b64url(Buffer.concat([Buffer.from([VERSION]), iv, ct, cipher.getAuthTag()]));
  const mac = b64url(createHmac("sha256", k.mac).update(body).digest());
  return { token: `${body}.${mac}`, exp };
}

export function verifyImageToken(token: string, secret: string, nowMs: number = Date.now()): VerifyResult {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, reason: "malformed" };
  }
  const k = keys(secret);
  const [body, mac] = token.split(".") as [string, string];
  const expected = createHmac("sha256", k.mac).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "signature" };
  const raw = Buffer.from(body, "base64url");
  if (raw.length < 1 + IV_BYTES + TAG_BYTES + 2 || raw[0] !== VERSION) return { ok: false, reason: "malformed" };
  let claims: ImageClaims;
  try {
    const iv = raw.subarray(1, 1 + IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const ct = raw.subarray(1 + IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", k.enc, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    const o = JSON.parse(plain) as { s?: unknown; u?: unknown; e?: unknown };
    if (typeof o.s !== "string" || typeof o.u !== "string" || typeof o.e !== "number") return { ok: false, reason: "malformed" };
    claims = { sourceId: o.s, url: o.u, exp: o.e };
  } catch {
    return { ok: false, reason: "signature" };
  }
  if (nowMs / 1000 >= claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
