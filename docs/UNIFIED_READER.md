# Unified multi-source reader

> Superseded in detail by [UNIFIED_CHAPTERS.md](UNIFIED_CHAPTERS.md) (canonical identity, merge rules, capability matrix, fallback). The chapter-matching notes below describe the earlier draft and are kept for history.

This document is the implementation contract for chapter aggregation and in-app page delivery.

## Current reader-capable adapters

| Provider | Title discovery | Chapter list | Page retrieval | Image delivery | Access boundary |
|---|---|---|---|---|---|
| MangaDex | Existing adapter | Existing adapter | Official MangaDex@Home API | Restricted API image relay; standard-port nodes only; reports @Home outcomes | No paywall or anti-bot bypass |
| WEBTOON | Existing adapter | Existing adapter | Public viewer HTML panel data | Restricted WEBTOON CDN relay | Public episodes only; locked/app-only episodes remain unavailable |
| Dynasty Reader | Existing adapter | Existing adapter | Public chapter page manifest parsed as JSON; no script execution | Restricted Dynasty Reader host relay | Public chapter pages only |

Other registered adapters are **not** considered reader-capable until they implement and pass a source-specific page adapter and image-delivery validation. Adapter registration, search, metadata, or chapter listing alone does not count as in-app reading support.

## Aggregation endpoint

`GET /api/titles/{ref}/chapters/all?limit=32`

- Resolves a canonical metadata title.
- Discovers only operational providers with `chapterPages` capability and without `clientOnly`.
- Uses the existing title matcher and health-aware provider ranking.
- Retrieves chapter lists with bounded concurrency.
- Returns provider variants, per-source chapter retrieval status, skipped providers, and summary counts.
- Returns partial results if an individual source fails.

### Chapter matching safety

A positive chapter number plus a normalized non-empty chapter title is grouped as a **possible** cross-source variant. Untitled and special/unknown-number entries remain source-specific. The current scraper contract does not reliably expose per-chapter language or edition metadata, so the API returns `language: null` and `languageVerified: false`. Clients must show a source choice and must not silently claim translation equivalence.

## Page delivery

`POST /api/pages` accepts a provider chapter ID and/or its provider chapter URL. URL is required for adapters whose chapter IDs are not globally addressable (WEBTOON and Dynasty Reader).

The image relay is not a general URL proxy. Each provider has a fixed host/path allowlist, HTTPS enforcement, public-DNS checks, no redirects, content-type validation, bounded streaming, size limits and timeouts. New providers must add their own parser and tests before their image URLs are proxied.

## Verification status

Fixture tests validate the WEBTOON and Dynasty Reader page extraction contracts and the provider-specific image URL allowlists. CI builds and tests the adapters. This is not the same as a live reading certification: each provider still needs an opt-in live test with a real public title and chapter, including successful page-image delivery from the deployed API.
