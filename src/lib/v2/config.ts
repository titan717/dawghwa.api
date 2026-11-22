/**
 * v2 reader settings, read from the environment on every call so tests (and
 * operators) can toggle them without a restart of the config cache.
 *
 *   IMAGE_PROXY                 "1" | "true" enables opaque /api/v2/img/<token> page URLs
 *   IMAGE_PROXY_SECRET          signing/encryption secret, at least 32 characters
 *   IMAGE_PROXY_TTL_SECONDS     token lifetime (default 1800, 300..86400)
 *   IMAGE_PROXY_RATE_PER_MINUTE per-client image requests per minute (default 600)
 *
 * IMAGE_PROXY without a usable secret is treated as disabled (current
 * behaviour) rather than signing with a per-instance random key, which would
 * break images whenever a request lands on another serverless instance.
 */

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

function int(name: string, def: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || process.env[name] === undefined || process.env[name] === "") return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export const MIN_SECRET_LENGTH = 32;

export interface ImageProxySettings {
  /** True only when the flag is on AND a usable secret is present. */
  enabled: boolean;
  /** Flag requested but no usable secret: an operator action is needed. */
  misconfigured: boolean;
  secret?: string;
  ttlSeconds: number;
  ratePerMinute: number;
}

export function imageProxySettings(): ImageProxySettings {
  const flag = truthy(process.env.IMAGE_PROXY);
  const secret = process.env.IMAGE_PROXY_SECRET?.trim();
  const usable = Boolean(secret && secret.length >= MIN_SECRET_LENGTH);
  return {
    enabled: flag && usable,
    misconfigured: flag && !usable,
    secret: usable ? secret : undefined,
    ttlSeconds: int("IMAGE_PROXY_TTL_SECONDS", 1800, 300, 86_400),
    ratePerMinute: int("IMAGE_PROXY_RATE_PER_MINUTE", 600, 1, 100_000),
  };
}
