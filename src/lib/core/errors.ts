/**
 * Consistent, client-safe error model for Dawghwa API.
 *
 * Every error that leaves the API is converted to an `ApiErrorBody`. Internal
 * messages (stack traces, upstream response bodies, credentials) are never
 * exposed unless EXPOSE_ERROR_DETAILS is enabled for local debugging.
 */

export const ERROR_CODES = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 400,
  INVALID_JSON: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  NOT_FOUND: 404,
  SOURCE_NOT_FOUND: 404,
  UNSUPPORTED_CAPABILITY: 501,
  SOURCE_UNAVAILABLE: 503,
  SOURCE_CIRCUIT_OPEN: 503,
  RATE_LIMITED: 429,
  UPSTREAM_RATE_LIMITED: 503,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_BLOCKED: 502,
  UPSTREAM_HTTP_ERROR: 502,
  UPSTREAM_NETWORK_ERROR: 502,
  UPSTREAM_RESPONSE_TOO_LARGE: 502,
  UPSTREAM_ERROR: 502,
  PROXY_FORBIDDEN: 403,
  /** The provider marks the chapter as locked (paid, coins, early access, login). Never bypassed. */
  CHAPTER_LOCKED: 403,
  /** The chapter resolved but has no page images. */
  PAGES_NOT_FOUND: 404,
  /** Pages are scrambled/encrypted by the provider; Dawghwa does not defeat that protection. */
  PAGES_PROTECTED: 422,
  /** The reader page no longer matches the extractor (provider changed its markup or image hosts). */
  PAGE_FORMAT_CHANGED: 502,
  CANCELLED: 499,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ApiErrorBody {
  /** Human readable message (kept as a string for upstream API compatibility). */
  error: string;
  code: ErrorCode;
  requestId?: string;
  details?: unknown;
}

export class DawghwaError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Safe-to-expose structured details (never upstream bodies). */
  readonly details?: unknown;
  /** Whether a retry may succeed. */
  readonly retryable: boolean;
  /** Seconds the client should wait (rate limits). */
  readonly retryAfter?: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { details?: unknown; retryable?: boolean; retryAfter?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "DawghwaError";
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = opts.details;
    this.retryable = opts.retryable ?? false;
    this.retryAfter = opts.retryAfter;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

export class UpstreamHttpError extends DawghwaError {
  readonly upstreamStatus: number;
  constructor(status: number, url: string) {
    const code: ErrorCode =
      status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_HTTP_ERROR";
    // Keep "HTTP <status>" in the message: upstream adapters and the health
    // checker historically matched on it.
    super(code, `HTTP ${status} from upstream ${safeHost(url)}`, {
      retryable: status === 408 || status === 425 || status === 429 || status >= 500,
      details: { upstreamStatus: status },
    });
    this.upstreamStatus = status;
  }
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { name?: string }).name === "AbortError" ||
      (error as { name?: string }).name === "TimeoutError")
  );
}

/**
 * Convert any thrown value into a DawghwaError. Unknown adapter errors keep a
 * generic classification but their raw message is only exposed when the
 * operator explicitly enables EXPOSE_ERROR_DETAILS.
 */
export function toDawghwaError(error: unknown): DawghwaError {
  if (error instanceof DawghwaError) return error;
  if (isAbortError(error)) {
    return new DawghwaError("UPSTREAM_TIMEOUT", "Upstream request timed out or was cancelled", {
      retryable: true,
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  // Legacy adapter errors: "HTTP 403: Forbidden", "Search failed: 403", ...
  const legacyStatus = message.match(/\b(?:HTTP|failed:?)\s*(\d{3})\b/i);
  if (legacyStatus) {
    const status = Number(legacyStatus[1]);
    return new DawghwaError(
      status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_HTTP_ERROR",
      `Upstream responded with HTTP ${status}`,
      { retryable: status >= 500 || status === 429, details: { upstreamStatus: status }, cause: error },
    );
  }
  if (/fetch failed|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|socket|network/i.test(message)) {
    return new DawghwaError("UPSTREAM_NETWORK_ERROR", "Could not reach upstream source", {
      retryable: true,
      cause: error,
    });
  }
  if (/timeout|timed out/i.test(message)) {
    return new DawghwaError("UPSTREAM_TIMEOUT", "Upstream request timed out", {
      retryable: true,
      cause: error,
    });
  }
  if (/cloudflare|challenge|captcha/i.test(message)) {
    return new DawghwaError("UPSTREAM_BLOCKED", "Upstream source is protected by an anti-bot challenge", {
      cause: error,
    });
  }
  return new DawghwaError("UPSTREAM_ERROR", "Source adapter failed", {
    cause: error,
    details: { reason: message.slice(0, 300) },
  });
}

/** Error codes that indicate the *source* is unhealthy (feed circuit breakers). */
export function isSourceFailure(error: DawghwaError): boolean {
  return [
    "UPSTREAM_TIMEOUT",
    "UPSTREAM_BLOCKED",
    "UPSTREAM_HTTP_ERROR",
    "UPSTREAM_NETWORK_ERROR",
    "UPSTREAM_RATE_LIMITED",
    "UPSTREAM_ERROR",
    "UPSTREAM_RESPONSE_TOO_LARGE",
  ].includes(error.code) &&
    // 404s are about the requested resource, not the source being down.
    !(error.code === "UPSTREAM_HTTP_ERROR" &&
      (error.details as { upstreamStatus?: number } | undefined)?.upstreamStatus === 404);
}

export function toErrorBody(
  error: DawghwaError,
  requestId?: string,
  exposeDetails = false,
): ApiErrorBody {
  const body: ApiErrorBody = { error: error.message, code: error.code };
  if (requestId) body.requestId = requestId;
  if (error.details !== undefined) {
    const details = error.details as Record<string, unknown>;
    if (exposeDetails) body.details = details;
    else if (details && typeof details === "object") {
      // Only structured, known-safe keys are exposed by default.
      const { reason: _reason, ...safe } = details;
      void _reason;
      if (Object.keys(safe).length) body.details = safe;
    }
  }
  return body;
}
