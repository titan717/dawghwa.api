# ADR 0002: Provider gating with PROVIDER_<ID> flags and PROVIDER_GATES

Status: accepted (AMIT, cycle 1, 2026-11-23)

## Context

MASTER_PROMPT section 11 says no provider is served until it passes all 9 gates and its
`PROVIDER_<NAME>` flag is on. Before cycle 1 the API had no such flag: every registered
adapter was served unless listed in `DISABLED_SOURCES`. The 2026-11-22 gate records show
0 of 18 candidates passing, so enforcing the rule at once would take production dark.

## Decision

1. Every source has a flag named by `providerFlagName(id)`: `PROVIDER_` plus the id in upper
   case with non-alphanumerics as `_` (for example `PROVIDER_SYNTHETIC_READER`). Values
   `on`, `1`, `true`, `yes` mean on. Only the owner sets flags, after a gate report shows
   all 9 gates pass. Agents and the gate runner never set them.
2. One env var controls enforcement on the legacy routes, `PROVIDER_GATES`:
   - `enforce`: the registry serves only sources whose flag is on. Others are treated like
     `DISABLED_SOURCES` entries.
   - unset or `report` (default): today's behaviour. Each source's gate status is reported
     in internal output only (`describeProvider().gate`, `/api/health` `gates` summary and
     a `gated` status in the shutdown list).
3. New code paths (v2 chapter and image routes) call `isProviderEnabled(id)`, which is strict
   and ignores the mode.
4. Switching `PROVIDER_GATES=enforce` in production is an owner decision. It is not part of
   any agent PR.

Code: `src/lib/gate/flags.ts`, `src/lib/providers/registry.ts`, `src/lib/api/sources.ts`,
`src/app/api/health/route.ts`. Tests: `src/tests/gate/flags.test.ts` covers both modes.

## Consequences

- Default deploys behave as before; nothing goes dark without an explicit owner action.
- Health output shows how many sources would stay up under `enforce` (`gates.served/total`).
- Flag names include internal ids. They live in env and internal output only, never in public
  responses or the app (the v2 leak tests still pass).
- Reverting is one env change: unset `PROVIDER_GATES`.
