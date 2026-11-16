import { NextRequest, NextResponse } from "next/server";
import { z, ZodError, ZodTypeAny } from "zod";
import { getConfig } from "@/lib/core/config";
import { DawghwaError, toDawghwaError, toErrorBody } from "@/lib/core/errors";
import { KeyedRateLimiter } from "@/lib/core/rate-limiter";

export type RateClass = "standard" | "expensive" | "none";

export interface ApiContext {
  requestId: string;
  clientId: string;
  /** Headers that must be attached to every response (rate limit info, ids). */
  headers: Headers;
}

const limiters: Partial<Record<RateClass, KeyedRateLimiter>> = {};

function limiterFor(cls: RateClass): KeyedRateLimiter | undefined {
  if (cls === "none") return undefined;
  if (!limiters[cls]) {
    const cfg = getConfig().api;
    limiters[cls] = new KeyedRateLimiter(
      cls === "expensive" ? cfg.rateLimitExpensivePerMinute : cfg.rateLimitPerMinute,
    );
  }
  return limiters[cls];
}

/** Test helper. */
export function resetApiRateLimits(): void {
  delete limiters.standard;
  delete limiters.expensive;
}

export function clientIdFor(req: Request): string {
  const cfg = getConfig().api;
  if (cfg.trustProxy) {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) {
      const first = fwd.split(",")[0]?.trim();
      if (first) return first.slice(0, 64);
    }
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim().slice(0, 64);
  }
  // Platform-provided client IP (e.g. Vercel) when available.
  const ip = (req as { ip?: string }).ip;
  if (ip) return ip.slice(0, 64);
  return "anonymous";
}

function applyRateLimit(cls: RateClass, ctx: ApiContext): void {
  if (!getConfig().api.rateLimitEnabled) return;
  const limiter = limiterFor(cls);
  if (!limiter) return;
  const r = limiter.take(`${cls}:${ctx.clientId}`);
  ctx.headers.set("RateLimit-Limit", String(r.limit));
  ctx.headers.set("RateLimit-Remaining", String(r.remaining));
  ctx.headers.set("RateLimit-Policy", `${r.limit};w=60`);
  if (!r.allowed) {
    ctx.headers.set("Retry-After", String(r.retryAfter));
    throw new DawghwaError("RATE_LIMITED", "Too many requests, slow down", {
      retryAfter: r.retryAfter,
      details: { retryAfter: r.retryAfter },
    });
  }
}

/**
 * Read and validate a JSON body with a hard size limit (checked both against
 * Content-Length and while streaming, so a lying header cannot bypass it).
 */
export async function readJson<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S>> {
  const max = getConfig().api.maxBodyBytes;
  const type = (req.headers.get("content-type") || "").toLowerCase();
  // Accept JSON and text/plain (used by userscripts to avoid CORS preflight).
  if (type && !type.includes("application/json") && !type.includes("text/plain")) {
    throw new DawghwaError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    throw new DawghwaError("PAYLOAD_TOO_LARGE", `Request body must be at most ${max} bytes`);
  }
  let raw = "";
  if (req.body) {
    const reader = req.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw new DawghwaError("PAYLOAD_TOO_LARGE", `Request body must be at most ${max} bytes`);
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  }
  let data: unknown;
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new DawghwaError("INVALID_JSON", "Request body is not valid JSON");
  }
  return parseWith(schema, data);
}

export function parseWith<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) {
      const issues = e.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message }));
      const first = issues[0];
      throw new DawghwaError(
        "VALIDATION_ERROR",
        first ? `${first.path ? `${first.path}: ` : ""}${first.message}` : "Invalid request",
        { details: { issues } },
      );
    }
    throw e;
  }
}

export function json(data: unknown, ctx: ApiContext, init: { status?: number; cacheControl?: string } = {}): NextResponse {
  const res = NextResponse.json(data, { status: init.status ?? 200 });
  ctx.headers.forEach((v, k) => res.headers.set(k, v));
  res.headers.set("Cache-Control", init.cacheControl ?? "no-store");
  return res;
}

export function errorResponse(error: unknown, ctx: ApiContext): NextResponse {
  const err = toDawghwaError(error);
  const cfg = getConfig().api;
  if (err.status >= 500 && err.code !== "SOURCE_UNAVAILABLE" && err.code !== "SOURCE_CIRCUIT_OPEN") {
    // Log internally with the cause; the client only gets the safe body.
    console.error(
      JSON.stringify({
        level: "error",
        requestId: ctx.requestId,
        code: err.code,
        message: err.message,
        cause: (err as { cause?: unknown }).cause instanceof Error
          ? String(((err as { cause?: Error }).cause as Error).message).slice(0, 500)
          : undefined,
      }),
    );
  }
  const res = NextResponse.json(toErrorBody(err, ctx.requestId, cfg.exposeErrorDetails), {
    status: err.status === 499 ? 400 : err.status,
  });
  ctx.headers.forEach((v, k) => res.headers.set(k, v));
  if (err.retryAfter !== undefined) res.headers.set("Retry-After", String(err.retryAfter));
  res.headers.set("Cache-Control", "no-store");
  return res;
}

type Handler = (req: NextRequest, ctx: ApiContext) => Promise<Response>;

/**
 * Wrap a route handler: request id, client rate limiting, consistent error
 * format, version header. Unexpected exceptions never leak internals.
 */
export function route(handler: Handler, opts: { rate?: RateClass | ((req: NextRequest) => RateClass) } = {}) {
  return async (req: NextRequest): Promise<Response> => {
    const requestId = req.headers.get("x-request-id")?.replace(/[^\w-]/g, "").slice(0, 64) || crypto.randomUUID();
    const ctx: ApiContext = { requestId, clientId: clientIdFor(req), headers: new Headers() };
    ctx.headers.set("X-Request-Id", requestId);
    ctx.headers.set("X-Dawghwa-Version", getConfig().version);
    try {
      const cls = typeof opts.rate === "function" ? opts.rate(req) : (opts.rate ?? "standard");
      applyRateLimit(cls, ctx);
      const res = await handler(req, ctx);
      ctx.headers.forEach((v, k) => {
        if (!res.headers.has(k)) res.headers.set(k, v);
      });
      return res;
    } catch (e) {
      return errorResponse(e, ctx);
    }
  };
}

/** Common primitives */
export const sourceIdSchema = z
  .string()
  .trim()
  .min(1, "source must not be empty")
  .max(64, "source is too long")
  .regex(/^[\p{L}\p{N} '._-]+$/u, "source contains invalid characters");

export const httpUrlSchema = z
  .string()
  .trim()
  .min(1, "url is required")
  .max(2048, "url is too long")
  .refine((v) => /^https?:\/\//i.test(v), "url must be an absolute http(s) URL");

export const booleanish = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

/** Charge an additional token from the expensive bucket (e.g. "all" searches). */
export function chargeExpensive(ctx: ApiContext): void {
  applyRateLimit("expensive", ctx);
}
