# Provider gate runner

`scripts/providers/gate.ts` runs the 9 gates of MASTER_PROMPT section 11 against one adapter
and writes a markdown report for `docs/providers/<name>.md` (app repo). It never turns a flag
on, never edits env or config, and stops at the first 401, 403 or challenge.

## Usage

```bash
# No network: synthetic fixture provider
npm run gate:provider -- --dry-run

# Real adapter (only after a terms review says automated access is allowed)
npm run gate:provider -- --provider <id> --terms review.json --titles titles.json \
  [--history runs.json] [--leak leak.json] [--daily 800] [--paths /search,/series/*] [--out report.md]
```

| Input | Shape (src/lib/gate/types.ts) | Gate |
|---|---|---|
| `--terms` | `TermsReview`, written by a person or SCOUT after reading the terms, own words | 1, 3, 9 |
| `--titles` | `QualityTitle[]`, 12 or more, all three kinds, popular and niche, ongoing and finished | 6 |
| `--history` | `RunRecord[]`; this run is appended. Unparseable records are refused | 7 |
| `--leak` | SHIELD leak audit with the provider on (`matches`, `providerOn`) | 8 |
| `--daily` | projected requests per day per host | 5 |
| `--paths` | robots.txt patterns the adapter uses; the paths actually requested are re-checked | 2 |

## How it fetches

- One request per second per host (or the robots.txt `Crawl-delay` if larger), backoff on
  429 and 5xx using `Retry-After`, at most 2 retries, and `UPSTREAM_RETRIES=0` so the core
  layer does not retry on top.
- User agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)` only. Any adapter-supplied
  User-Agent, Referer, Origin, Cookie, Authorization or `sec-*` header is stripped and fails
  gate 4.
- Requests go through the SSRF guard on every hop, redirects included. Redirects are followed
  only to the same host or a declared host of the adapter; anything else is refused and recorded.
- 401, 403, a challenge page or a login redirect latches the host: nothing more is sent to it
  and the verdict is `blocked`.
- Page images are typed from their bytes (`sniffImageType`); SVG is refused. Match threshold
  is `AVAILABILITY_MIN_SCORE` (0.82).

## Verdicts

`enabled` means all 9 gates pass, and the report may be proposed to the owner. `disabled` or
`blocked` means the flag stays off, with a re-check date. See ADR 0002 for how flags are read.
