# WEAVER, cycle 1 log

Role: Builder 9, provider skill and adapters. Design note: `docs/design-notes/weaver-c1.md`
(JUDGE approved with conditions 1 to 8; condition 7 superseded by AMIT: wire the flag).

## Done
- `src/lib/gate/`: polite fetcher (DawghwaBot UA only, 1 req/s per host, backoff, latch on
  401/403/challenge/login, header stripping, declared-host redirects, SSRF guard per hop),
  robots.txt parser, 9 gate evaluators, quality run, report, Provider bridge, fixture.
- `scripts/providers/gate.ts` CLI (`npm run gate:provider`), sets `UPSTREAM_RETRIES=0`,
  `SOURCE_DEFAULT_RPS=1` and the bot UA before config is read and asserts them.
- Flags: `PROVIDER_<ID>` + `PROVIDER_GATES=enforce|report` (default report), ADR 0002;
  registry, describeProvider `gate`, health `gates` summary and `gated` status.
- `net-guard.ts`: `getGuardedFetchImpl()` so the bridge restores the previous impl.
- Tests: 7 files, 95 tests in `src/tests/gate` (polite, robots, flags, gates, run,
  adapter contract, bridge and breaker).

## Found while testing
- The request log kept only the pathname, so a robots rule on a query string was missed
  in the after-run gate 2 check. Fixed: path plus query is logged and checked.
- Under the default config the core HTTP layer sends a browser UA; the runner strips it and
  fails gate 4 unless `UPSTREAM_USER_AGENT` is the bot UA (the CLI sets it). RELAY owns the
  production UA fix.

## Not done
- No real provider run (SCOUT, after terms review). No flag turned on.
