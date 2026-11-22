# Comix structure study

- Provider id: `comix`  Hosts: `comix.to` (adapter), `comix.ws` (named by the user). Relationship: likely the same service (mirror or alternate domain), **unverified**. No first-party page could be read. Third-party evidence: the keiyoushi extension lists `mirrors("https://comix.to", "https://comix.ws")`, and a browser add-on supports both domains, calling comix.ws a fallback.
- Date (UTC): 2026-11-22  Researcher: Phase 5 researcher agent
- Status: **`blocked: access`** (Cloudflare 403 anti-bot block on both hosts) and **terms unreadable**
- Settings used: sequential requests >= 1.1 s apart, no retries, no cookies, UA `dawghwa-research/0.1 (site-structure-study)`, budget 30, used 4. Process follows `skills/site-structure-study/SKILL.md`.

## Terms and robots
The full quotes are in the coordinator's analysis notes (`analysis/comix-terms.md`, outside this repo). The `User-agent: *` group of `https://comix.ws/robots.txt` (HTTP 200, 2026-11-22T13:48:05Z) is:

```
User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /
```

It also blocks named AI-training bots (GPTBot, CCBot, ClaudeBot, Google-Extended and others) with `Disallow: /`, and its comments claim an express reservation of rights under Art. 4 of EU Directive 2019/790. The file we received has no `Disallow: /u/` rule. That differs from the description we were given; the file may vary by client or region.

We couldn't read any terms of service, DMCA, privacy or API terms on either host. Paths were not guessed after the block.

## Request log
| # | Time (UTC) | Method | URL | Status | Notes |
|---|---|---|---|---|---|
| 1 | 13:48:05 | GET | https://comix.ws/robots.txt | 200 | text/plain, `cache-control: private, max-age=0, no-store`, no ETag or Last-Modified |
| 2 | 13:48:06 | GET | https://comix.to/robots.txt | 403 | Cloudflare "Sorry, you have been blocked", cf-ray a5e863cc4e164114-IAD |
| 3 | 13:48:07 | GET | https://comix.ws/ | 403 | Cloudflare block page, cf-ray a5e863d3ebc2aa99-IAD. Stop: comix.ws |
| 4 | 13:48:08 | GET | https://comix.to/ | 403 | Cloudflare block page, cf-ray a5e863db6ab6a5b8-IAD. Stop: comix.to |

No Retry-After, RateLimit or X-RateLimit headers were returned on any response.

## Endpoints
Not studied. The stop rule fired before any endpoint request. For reference, the adapter (`src/lib/scrapers/comix.ts`, `src/lib/frontpages/comix.ts`) calls `https://comix.to/api/v2/...` (for example `manga/{hashId}`). We did not verify the shape, caching or limits of those endpoints, and they aren't covered by any terms we could read.

## Adapter impact
- `comix` is now listed in `EXPERIMENTAL_SOURCE_IDS` (`src/lib/providers/status.ts`). It's left out of the registry, so it doesn't appear in sources, search, availability, catalog, frontpage, health or URL matching, unless `EXPERIMENTAL_PROVIDERS` includes `comix`. That flag is empty by default.
- Comix was the only frontpage adapter, so `/api/frontpage` lists no sources by default. The app doesn't call `/api/frontpage`.

## Not verified
- Whether comix.ws and comix.to are run by the same operator.
- Whether any terms of service, API terms or DMCA policy exist.
- Endpoint shapes, pagination, caching and rate limits.
- Whether the block applies to all automated clients or only to this network or user agent. We didn't test other clients, because that would mean trying to get around the block.

## Recommendation
**Not safe to enable.** Keep comix behind `EXPERIMENTAL_PROVIDERS` (off), and don't set that flag in any deployed environment. Reconsider only if a human has (a) confirmed first-party terms that allow third-party clients and (b) a way to access the site that doesn't involve getting around its protection.
