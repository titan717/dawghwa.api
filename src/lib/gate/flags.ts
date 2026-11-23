/**
 * Provider gating flags (docs/adr/0002-provider-gating.md).
 *
 *   PROVIDER_<ID>=on|1|true|yes   the source passed all 9 gates (section 11) and
 *                                 the owner turned it on. Never set by agents.
 *   PROVIDER_GATES=enforce        legacy routes serve only sources whose flag is on.
 *   PROVIDER_GATES unset|report   legacy routes keep today's behaviour; the gate
 *                                 status is only reported (internal outputs).
 *
 * New code paths (v2 chapter and image) use the strict isProviderEnabled(),
 * which ignores the mode. Everything is read from the environment on every
 * call, so operators and tests can change it without a restart.
 */

const ON = /^(1|true|yes|on)$/i;

export type ProviderGatesMode = "enforce" | "report";

/** Any env-like map (process.env or a plain object in tests). */
export type Env = Readonly<Record<string, string | undefined>>;

/** `dynasty-reader` -> `PROVIDER_DYNASTY_READER`; `writers'-scans` -> `PROVIDER_WRITERS_SCANS`. */
export function providerFlagName(id: string): string {
  const slug = id
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `PROVIDER_${slug}`;
}

export function providerFlagOn(id: string, env: Env = process.env): boolean {
  const v = env[providerFlagName(id)];
  return v !== undefined && ON.test(v.trim());
}

export function providerGatesMode(env: Env = process.env): ProviderGatesMode {
  return env.PROVIDER_GATES?.trim().toLowerCase() === "enforce" ? "enforce" : "report";
}

/** Strict: the source passed its gates and its flag is on. Independent of the mode. */
export function isProviderEnabled(id: string, env: Env = process.env): boolean {
  return providerFlagOn(id, env);
}

/** What the legacy registry serves: everything in report mode, only flagged sources in enforce mode. */
export function isProviderServed(id: string, env: Env = process.env): boolean {
  return providerGatesMode(env) === "enforce" ? providerFlagOn(id, env) : true;
}

export interface ProviderGateStatus {
  flag: string;
  flagOn: boolean;
  mode: ProviderGatesMode;
  served: boolean;
}

/** Internal status for registry / health output. */
export function providerGateStatus(id: string, env: Env = process.env): ProviderGateStatus {
  return { flag: providerFlagName(id), flagOn: providerFlagOn(id, env), mode: providerGatesMode(env), served: isProviderServed(id, env) };
}
