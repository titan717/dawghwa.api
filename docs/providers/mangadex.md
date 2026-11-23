# MangaDex (existing API provider `mangadex`)

Site: mangadex.org, api.mangadex.org, uploads.mangadex.org, MangaDex@Home image nodes. Operator: MangaDex US, Inc. (named in the ToS). Endpoints the adapter uses: `api.mangadex.org` (`/manga`, `/manga/{id}/feed`, `/manga/tag`, `/at-home/server/{id}`) and `uploads.mangadex.org/covers`.

Gate numbering below follows MASTER_PROMPT section 11. Re-checked 2026-11-23 by SCOUT (cycle 0).

## Verdict (2026-11-23)

**FAIL. Flag stays OFF. Downloadable: false.**

The main reason is a conflict between MangaDex's API policy and Dawghwa's locked hidden-source rule. **The owner has to decide this; agents cannot resolve it.**

- The MangaDex API Acceptable Usage Policy makes the API free only for projects that (1) credit MangaDex, (2) credit the scanlation groups when they let users read chapters, and honor written takedown requests from group leaders, and (3) run no ads or paid services. ([api.mangadex.org/docs](https://api.mangadex.org/docs/), read 2026-11-23)
- Dawghwa's locked decision says users never see providers or source names. Rules 1 and 2 require showing exactly those names. So the hidden-source rule and MangaDex's terms cannot both be met. Under the gate rules, terms that require attribution mean a gate 1 FAIL.
- If the owner ever wants MangaDex, the product rule would have to change. That means visible credit for MangaDex and for the group on every chapter, a takedown process for group requests, and no ads or paid tiers. That decision belongs to the owner. Until then the flag stays OFF.

## Gates

| # | Gate | Result 2026-11-23 |
|---|---|---|
| 1 | Terms | **FAIL**. The API policy requires visible credit to MangaDex and the groups, which conflicts with hidden sources. The site ToS (v2026.10.31) also forbids bots, scripts, data mining and "offline reader" style automated systems on the Site, and systematic retrieval to build a collection without written permission. The API policy is the specific permission for API use, but it carries the attribution condition. |
| 2 | robots.txt | pass for the adapter's host as far as checked. `mangadex.org/robots.txt` (`User-Agent: *`) disallows `/api`, `/terms`, `/privacy`, `/my/*`, `/titles/feed` and a few more on the main site. The adapter uses the separate host `api.mangadex.org`, whose robots.txt was not fetched (one request budget). No content-signal lines. |
| 3 | Rights and takedowns | partial. MangaDex honors group removal requests and requires API users to honor them too. Licensed titles have 0 to 4 chapters (PR #32). |
| 4 | Access | **pass from the sandbox today** with the identifying bot UA: robots.txt, `/compliance/terms` (SPA shell, no challenge) and `api.mangadex.org/docs/` all returned 200 with no redirect. The 2026-11-22 challenge was seen with a browser UA. Note that MangaDex requires a real, unspoofed User-Agent. **The API's default Chrome UA (`src/lib/core/config.ts`) breaks that requirement.** |
| 5 | Rate and politeness | Documented limits (2026-11-23): about 5 requests per second per IP across `api.mangadex.org`; `GET /at-home/server/{id}` 40 per minute; `GET /manga/random` 60 per minute; collections capped at offset+size 10,000 and size 100 (500 for some feeds). Persistent 429s escalate to a temporary 403 IP ban, then silent drops. Patterns that use many requests where one would do get throttled. Hotlinked images get a wrong response, so images must go through our own proxy (which Spec H already does). CORS is not served to other sites. A `Via` header is rejected. |
| 6 | Quality | from PR #32, not re-run: 12/12 exact matches, substantial chapters for only 5/12 titles. |
| 7 | Reliability | not run |
| 8 | Hidden-source compliance | **conflict by design** (see the verdict) |
| 9 | Offline permission | **false**. Neither the API policy nor the ToS grants offline or saved reading for third-party apps. The ToS gives users a personal, non-commercial licence to download copies, but it also names "offline readers" among the forbidden automated systems. Unclear = false. |

## What MangaDex explicitly allows (recorded for the owner)

- Free use of the public API for projects that meet the three conditions above. Donations are fine. Ads and selling access to anything that comes from the API are not. MangaDex judges edge cases itself and may cut off offenders.
- Hiding the source: **not permitted**. Credit to MangaDex and to the scanlation groups is a condition of use.
- Offline: **not explicitly permitted**, so `downloadable: false`.
- Rate limits: see gate 5.
- Client requirements: a real UA (no spoofing), no `Via` header, our own image proxy, and our own CORS.

## Sources (read 2026-11-23)

- MangaDex API Acceptable Usage Policy: https://api.mangadex.org/docs/ (fetched from the sandbox, 200)
- Limitations and Requirements: https://api.mangadex.org/docs/2-limitations/ (read through a fetch service)
- Terms of Service v2026.10.31: https://mangadex.org/compliance/terms (the sandbox got the SPA shell; the text was read through a fetch service)
- robots.txt: https://mangadex.org/robots.txt (sandbox, 200)

## Re-check evidence 2026-11-23

Requests from the sandbox used UA `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no cookies, no Referer/Origin, redirects not followed, 2+ s apart, stop on 401/403/429 or challenge. My script flagged `/compliance/terms` as a possible challenge because the shell mentions reCaptcha in a comment. On review it was the normal app shell, and I sent nothing more to that host. JUDGE's finding applies here too: earlier access that relied on the API's Chrome UA or spoofed Referer/Origin does not count for gate 4.

| URL | HTTP | Time (UTC) | Result |
|---|---|---|---|
| https://mangadex.org/robots.txt | 200 | 2026-11-23T15:44:57Z | robots served, no redirect |
| https://mangadex.org/compliance/terms | 200 | 2026-11-23T15:44:59Z | SPA shell (no challenge); text needs JS |
| https://api.mangadex.org/docs/ | 200 | 2026-11-23T15:45:01Z | API docs with the Acceptable Usage Policy |

## Previous record (2026-11-22, cycle 1 of the earlier run; gate numbers there use the old scheme)

## Evidence (gate 9)

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://mangadex.org/robots.txt | 200 (after 302) | 2026-11-22T15:42:58Z | - | redirected to https://mangadex.org/edge/challenge?src=L3JvYm90cy50eHQ (MangaDex "Browser verification" page, JS + cookies required) → treated as challenge, STOP |
| https://mangadex.org/compliance/terms | 200 (after 302) | 2026-11-22T15:42:59Z | - | redirected to https://mangadex.org/edge/challenge?src=L2NvbXBsaWFuY2UvdGVybXM (MangaDex "Browser verification" page, JS + cookies required) → treated as challenge, STOP |
| https://api.mangadex.org/docs/ | 200 (after 302) | 2026-11-22T15:42:58Z | - | redirected to https://mangadex.org/edge/challenge?src=L2RvY3Mv (MangaDex "Browser verification" page, JS + cookies required) → treated as challenge, STOP |
