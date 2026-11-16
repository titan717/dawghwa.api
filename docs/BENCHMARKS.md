# Benchmarks

All numbers below were measured on 2026-11-16 in the same Linux sandbox (datacenter network). The two servers ran production builds (`next build && next start`):

- **upstream**: unmodified comick-source-api at `086d006`, port 3001
- **dawghwa**: this repository at 1.0.0, port 3002

The raw results are in [`docs/benchmarks/`](./benchmarks). The scripts are `scripts/benchmark.mjs` (scenario run) and `scripts/benchmark-cold.mjs` (cold-key comparison). Live sites add a lot of noise, so treat single runs as indicative only.

## Scenario run (`scripts/benchmark.mjs`)

These are sequential requests against a freshly started server. Repeated requests deliberately reuse the same keys, so cache effects are included.

| Scenario | upstream (run 1) | upstream (run 2) | dawghwa |
| --- | ---: | ---: | ---: |
| `GET /api/sources` | 58 ms | 52 ms | 62 ms |
| search MangaDex #1 / #2 / #3 | 474 / 58 / 816 ms | 577 / 374 / 74 ms | 208 / 26 / 9 ms |
| chapters MangaDex (317 ch.) #1 / #2 / #3 | 769 / 111 / 54 ms | 742 / 62 / 76 ms | 88 / 9 / 9 ms |
| 10 concurrent identical chapter requests (new key) | 458 ms | 412 ms | 58 ms |
| search **all** sources #1 / #2 | 20,044 / 20,030 ms | 20,019 / 20,018 ms | 12,278 / 12,022 ms |
| time to first NDJSON line (all) #1 / #2 | 267 / 199 ms | 233 / 274 ms | 153 / 28 ms |
| sources in "all" search / failed | 96 / 32 | 96 / 31 | 82 / 24 (14 shut-down sources skipped) |
| frontpage Comix trending | 500 | 500 | 502 `UPSTREAM_BLOCKED` |

How to read this:

- **Repeat requests** are served from the cache (`meta.cache: "hit"`), which is why they take about 9 ms. Upstream had no cache, so its repeat times only reflect the source's own speed.
- **10 concurrent identical requests** turn into one upstream fetch in Dawghwa (singleflight), versus 10 in upstream.
- **"All" search** finishes in about 12 s instead of 20 s because of the per-source timeout (12 s vs 20 s), not because the sources got faster. Slow sources simply stop holding up the response. Shut-down sources are no longer searched.
- **The first cold MangaDex chapter request (88 ms vs ~750 ms) is not a fair comparison.** The upstream server ran first with the same URL seconds earlier. The cold-key test below controls for that.

## Cold-key comparison (`scripts/benchmark-cold.mjs`)

Each request uses a search query or manga that neither server has seen. Requests alternate between the servers so neither gets a warm-up advantage. n = 10 per server per operation, MangaDex only.

| Operation | upstream median | dawghwa median |
| --- | ---: | ---: |
| single-source search | 798 ms | 714 ms |
| chapter list | 406 ms | 397 ms |

**Cold single requests are about as fast as upstream.** The differences are within the noise of the live API. Dawghwa adds no measurable overhead, and the shared client does not make a single cold request faster; the source's response time dominates. None of these manga had more than 500 chapters, so the parallel MangaDex feed pagination was not exercised here. Its effect is checked in a unit test (`src/tests/adapters/mangadex.test.ts`): 1,234 chapters means 3 feed pages, with pages 2 and 3 fetched concurrently.

## Summary of measured improvements

- Cached responses: about 9 ms vs about 60-800 ms (upstream refetched every time).
- Duplicate concurrent requests: 1 upstream fetch instead of N (58 ms vs 412-458 ms for 10).
- All-source search: about 12 s vs about 20 s wall time, with the first result streamed sooner (28-153 ms vs 199-274 ms).
- Cold single-source latency: unchanged.

Not measured: memory under sustained load, and behaviour with Redis enabled.

## Reproduce

```bash
npm run build && npm start &                     # port 3000
node scripts/benchmark.mjs http://localhost:3000 mine > mine.json
# compare two servers with fresh keys:
node scripts/benchmark-cold.mjs http://localhost:3001 http://localhost:3000 > cold.json
```
