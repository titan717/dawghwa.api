---
name: site-structure-study
description: Study a website's PUBLIC structure before writing or changing a source adapter. Covers public endpoints, response shapes, pagination, rate limits (Retry-After, RateLimit headers), caching headers (Cache-Control, ETag, Last-Modified), robots.txt and content signals, and a terms-of-service check that comes first. Use it when adding a provider, debugging one that broke, or deciding whether a provider may be enabled. Not for logins, paywalled or private areas, bypassing anti-bot protection, or collecting content for AI training.
---

# Site structure study

Produces a written, evidence-backed study of how a site exposes public data, so an adapter can be written or reviewed without guessing. The study is a decision document first: it can end with "do not use this site", and that is a valid result.

## Non-negotiable rules

1. **Terms first.** Read robots.txt, the terms of service, and any API, DMCA or privacy terms before you study a single endpoint. If they prohibit automated access, API use, caching, or third-party apps, stop and report. See `references/terms-check.md`.
2. **Public endpoints only.** No logins, accounts, cookies, tokens, API keys you were not given for this purpose, or anything behind a paywall.
3. **Respect robots.txt.** Disallowed paths are not requested. If robots.txt returns 5xx or can't be reached, treat the whole site as disallowed (RFC 9309). Record the `Content-Signal` line. See `references/robots-and-signals.md`.
4. **Rate limit.** By default, send at most 1 request per second per host, one at a time. Retry only on 429, 5xx, or network errors, with exponential backoff of 1s, 2s, 4s, 8s, 16s (max 5 retries). Always honour `Retry-After`. If `Retry-After` is longer than 60 s, stop. Write the values you used into the study. Keep a hard budget (default 30 requests per study).
5. **Stop and report** on any 401, 403, 407 or 451, any challenge, CAPTCHA, "verify you are human" or "you have been blocked" page, or any conflict with the terms. Do not retry with other user agents, headers, proxies, headless browsers, or cookies. Stopping the host means no more requests to it at all.
6. **No bypassing.** Never solve or get around a CAPTCHA, a Cloudflare or other anti-bot check, a paywall, or a geo-block.
7. **Original work only.** Record facts such as field names, types, status codes, and header values. Never copy the site's source code, markup, styles, scripts, images, logos or branding into the repo. Test fixtures must be minimal real responses, with personal data (IPs, emails, user names) redacted.
8. **No AI training.** Content you fetch is used only to describe structure. Never use it to train or fine-tune a model, and honour `ai-train=no`.
9. **Never enable for users.** A study can support a recommendation, but turning a provider on in production is a human decision. New or doubtful providers go behind an off-by-default flag (in this repo, `EXPERIMENTAL_PROVIDERS`).

## Workflow

1. **Scope.** Name the host or hosts, why they're being studied, and which adapter files already touch them (`rg -n "<host>" src`). Check whether related domains (mirrors, CDNs, API subdomains) are the same service, using first-party evidence only (redirects, footer, terms). If that evidence isn't available, label any third-party evidence as "unverified".
2. **Terms gate.** Use `references/terms-check.md`. Quote the relevant text with its URL and UTC fetch time. Give a plain verdict. If it's blocked, stop here and write the study with status `blocked`.
3. **Robots gate.** Fetch `/robots.txt` once per host. Record the groups that apply to your user agent, any `Crawl-delay` (use it if it's above 1 s), and the content signals.
4. **Endpoint inventory.** Start from the endpoints the existing adapter already calls. Don't go looking for hidden or undocumented admin or internal routes. For each endpoint, record method, path template, required parameters, pagination style, and response shape (field names and types only). Use `references/http-facts.md` for what to record.
5. **Measure politely.** Use `scripts/polite-fetch.mjs`, which enforces rules 3 to 5:
   ```bash
   node skills/site-structure-study/scripts/polite-fetch.mjs https://example.org/api/list?page=1
   ```
   It prints one JSON line of facts per request (status, timing, caching and rate-limit headers) and a summary with the settings used. Exit code 3 means a stop rule fired, so stop and report.
6. **Write the study** using `references/report-template.md`, at `docs/providers/<id>-study.md`. Include the request log (count, times, statuses), the rate-limit settings used, and anything that could not be verified.
7. **Report** the verdict: `safe to keep behind a flag`, `safe to enable (needs human sign-off)`, or `blocked: <reason>`.

## Files

- `references/terms-check.md`: which documents to read, what to look for, and verdict wording.
- `references/robots-and-signals.md`: robots.txt rules (RFC 9309) and Content Signals.
- `references/http-facts.md`: caching, rate-limit, pagination, and response-shape facts to record.
- `references/report-template.md`: the study template.
- `scripts/polite-fetch.mjs`: dependency-free client using built-in fetch. Unit tests are in `src/tests/skills/polite-fetch.test.ts` (run with `npm test`).
