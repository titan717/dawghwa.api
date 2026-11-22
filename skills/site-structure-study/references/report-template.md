# <Provider> structure study

- Provider id: `<id>`  Hosts: `<host>` (relationship to other hosts: verified / unverified + evidence)
- Date (UTC): <date>  Researcher: <agent/person>
- Status: `allowed` | `allowed with limits` | `unclear` | `blocked: terms` | `blocked: access`
- Settings used: 1 req/s per host, backoff 1/2/4/8/16 s (max 5 retries), Retry-After honoured (stop if > 60 s), budget <n> requests, UA `<ua>`

## Terms and robots
Quoted excerpts with URL and fetch time, plus the verdict from `terms-check.md`.

## Request log
| # | Time (UTC) | Method | URL | Status | ms | Notes |
|---|---|---|---|---|---|---|

## Endpoints
### <name>: `GET /path/{id}`
- Used by: `src/lib/...:line`
- Params:
- Pagination:
- Response shape:
  ```ts
  { result: { id: string; title: string; ... } }
  ```
- Caching: Cache-Control / ETag / Last-Modified, and whether a 304 was seen
- Rate limits: headers seen / documented / none documented

## Adapter impact
Mismatches between the adapter and what we observed, and the cache TTL we recommend.

## Not verified
List everything you couldn't confirm and why.

## Recommendation
Keep behind flag / enable with human sign-off / blocked. Restate that enabling for users is a human decision.
