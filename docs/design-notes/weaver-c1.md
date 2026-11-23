# WEAVER design note, cycle 1: provider skill, gate runner, adapter contract

Author: WEAVER (Builder 9). Date: 2026-11-23. Reviewer: JUDGE (logic/API).
Repos: `titan717/dawghwa.api` (branch `agent/c1-weaver-gate-runner`) and `titan717/dawghwa` (branch `agent/c1-weaver-site-skill`, skill file only). Both PRs target `agent/cycle-1`.

## What exists today (read in cycle 0)

- 96 scraper adapters in `src/lib/scrapers/*` (extend `BaseScraper`: `search`, `getChapterList`, `extractMangaInfo`, optional page extraction), wrapped by `Provider` (`src/lib/providers/provider.ts`: deadline, breaker, metrics) and registered in `src/lib/providers/registry.ts`. Status comes from `status.ts`; operators can disable via config `providers.disabled`. There is **no per-provider `PROVIDER_<NAME>` flag** today: every non-shutdown adapter is callable in production.
- Outbound HTTP: `src/lib/core/http.ts` (token bucket default 5 rps, retries, challenge detection via `core/antibot.ts` -> `UPSTREAM_BLOCKED`, no bypass) over `core/net-guard.ts` `guardedFetch` (SSRF guard at connect time, test hook `setGuardedFetchImpl`).
- v2 path (RELAY, merged as 0dd3ca0): `src/lib/v2/{breaker,pacer,chapter,image,token,leak}.ts`. `leak.ts` `providerTerms()` already builds the deny-list from the registry.
- Gate records (app repo `docs/providers/*`, 2026-11-22): 0 of 10 candidates and 0 of 8 existing providers pass. Reasons are almost all gate 1 (terms) or gate 4 (challenge/403). PR #32 data shows match is not the same as readable (MangaDex exact matches with 0 chapters).

## Findings that matter for safety (reported, not fixed by me)

1. `core/config.ts` defaults `UPSTREAM_USER_AGENT` to a desktop Chrome string. That is a browser-identity header, which the hard rules treat as spoofing. Recommendation for RELAY/SHIELD: default to an honest bot UA. My runner never uses it (see below).
2. `BaseScraper.pageImageReferer()` sends the provider's own Referer on image requests. Spec H forbids spoofing Referer to defeat hotlink protection. Flag for RELAY/SHIELD.
3. No `PROVIDER_<NAME>` gating exists, so "flag stays OFF" is not enforced in code. I add an inert, opt-in gate registry (below) but do NOT wire it into the live registry this cycle, since that would switch off every current source in production. Decision for AMIT/JUDGE.

## Goal

A reusable, safe way to evaluate a provider against the 9 gates of section 11 and produce an evidence record, without ever enabling one.

## Deliverables and files

App repo:
- `skills/site-analysis/SKILL.md` + `skills/site-analysis/references/{record-template.md,stop-conditions.md}`: order of work (terms, DMCA, robots first), human pace, stop on 401/403/CAPTCHA/challenge/login wall, observe only normal public page behavior, never copy code/markup/styles/assets/text/branding, describe multi-source layout in own words, write `docs/providers/<name>.md` from the template.

API repo (new files only, nothing existing modified except `package.json` script `gate:provider`):
- `src/lib/gate/types.ts`: `ProviderAdapter` (Spec Q shape: `id`, `flag`, `offlineAllowed`, `search`, `chapters`, `pages`), `GateId` 1..9, `GateResult { gate, name, status: "pass"|"fail"|"not-run"|"needs-evidence", evidence: string[] }`, `TermsReview` input (human/SCOUT-written JSON: terms URL+date+summary, forbidsAutomation, dmcaContact, offline: "allowed"|"forbidden"|"unclear", licensedExclusions).
- `src/lib/gate/polite.ts`: `PoliteFetcher` with injected `fetch`, clock and sleep. 1 request/second per host (min interval configurable only upward), at most 3 attempts with exponential backoff on 429/5xx, honors `Retry-After` (capped at 60 s; longer = stop as unavailable), throws `BlockedError` on 401/403, on challenge pages (`detectChallenge`) and on login redirects. After a block, every further request to that host throws immediately (latched). Sends `User-Agent: DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, removes caller `User-Agent`, `Referer`, `Origin`, `Cookie`, `sec-*` headers and records that the adapter tried to set them. No proxies, no cookies, redirects followed only on the same registrable host (max 3). Logs every request (time, host, path, status, ms, cache-control/etag/age) for gate 5 evidence.
- `src/lib/gate/robots.ts`: robots.txt parser (groups, `Allow`/`Disallow` longest-match with `*` and `$`, `Crawl-delay`, `Content-Signal` and other unknown lines recorded). `isAllowed(path, ua)` checks our UA group and `*`, stricter wins.
- `src/lib/gate/gates.ts`: one pure evaluator per gate (1 terms, 2 robots, 3 rights, 4 access, 5 politeness, 6 quality on >= 12 titles, 7 reliability from a run history, 8 leak result, 9 offline). Thresholds: match >= 0.82, chapter count within 5% of reference, language equal, no duplicate refs, one chapter whose every page returns `image/*` and passes the adapter's page-host allow rule; gate 7 needs >= 3 runs >= 6 h apart, >= 95% success, median page-list latency < 2000 ms. Gate 8 reads SHIELD's leak-audit JSON (path argument); missing = `needs-evidence`. Verdict PASS only if all 9 are `pass`.
- `src/lib/gate/report.ts`: markdown report (table of gates, evidence bullets, request log summary, verdict, "re-check after" date). Provider names appear only in this internal docs report, never in API responses.
- `src/lib/gate/bridge.ts`: `adapterFromProvider(provider)` builds a `ProviderAdapter` over an existing registered `Provider`, so existing scrapers can be gated. During a run the runner installs the polite fetcher via `setGuardedFetchImpl`, so every adapter request is paced, honest and stoppable.
- `scripts/providers/gate.ts` (tsx CLI): `npm run gate:provider -- --provider <id> --terms <review.json> --titles <titles.json> [--history <runs.json>] [--leak <leak.json>] [--out <report.md>] [--dry-run]`. Order: terms gate first (if it fails: stop, no network), robots (if any used path disallowed: stop), then access + quality + reliability. Any block ends the run with FAIL. `--dry-run` uses fixtures only. It never writes env vars or flags; it prints "flag stays OFF" unless the verdict is PASS, and even then only says the flag may be proposed to AMIT.
- `src/lib/gate/flags.ts` (inert): `providerFlagEnabled(id)` reads `PROVIDER_<ID>`; exported and tested, not wired.

## Tests (Vitest, no network, recorded fixtures)

- `src/tests/gate/polite.test.ts`: 1 req/s spacing per host (fake clock), independent hosts, Retry-After honored, backoff then give up, 401/403/challenge throw BlockedError and latch, header stripping and honest UA, cross-host redirect refused.
- `src/tests/gate/robots.test.ts`: groups, longest match, wildcards, `$`, our UA vs `*` stricter wins, content signals recorded.
- `src/tests/gate/gates.test.ts` + `report.test.ts`: each gate pass/fail edge, verdict, markdown snapshot-free assertions.
- `src/tests/gate/adapter-contract.test.ts`: contract suite every `ProviderAdapter` must pass (shapes, empty results, errors typed, no provider term in titles returned to users) run against a fixture adapter built from recorded JSON in `src/tests/fixtures/gate/` (synthetic names, no real provider data).
- `src/tests/gate/breaker.test.ts`: trip after threshold, open fails fast, half-open single trial, recovery closes, failed trial doubles cooldown, for both `core/CircuitBreaker` and `v2/SourceBreakers` with a fake clock.

## API contract

No HTTP endpoint changes. No response shape changes. The runner is a dev/ops script only.

## Flags

None turned on. `PROVIDER_<NAME>` helper is inert. `IMAGE_PROXY` untouched.

## Acceptance criteria

1. `npm test` passes including the new suites; `tsc --noEmit` and lint clean for new files.
2. `--dry-run` on fixtures prints a 9-gate markdown report with a FAIL verdict when any gate fails and PASS only when all pass.
3. No real provider is contacted by tests; only SCOUT's live run uses the runner.
4. No provider name in `src/app/**` or responses (existing leak tests still green).

## Risks

- Existing scrapers' own retries (core/http) still run under the polite fetcher; mitigated by setting `UPSTREAM_RETRIES=0` and `SOURCE_DEFAULT_RPS=1` inside the runner process.
- Full-page load for 12 titles at 1 req/s is slow (about 15 minutes); acceptable for a manual run.
- Terms and rights gates need human judgment; the runner only checks the review record is complete and consistent.

## Handoff

Runner and usage doc go to SCOUT after JUDGE approval and merge into `agent/cycle-1`.
