# Multi-source title page: internal notes

**Internal only.** Product decision: Dawghwa users never see sources. These notes describe how a multi-source title page could work, so the team can borrow the logic (ranking, fallback, honest states) while keeping the source layer hidden. They're based only on what was already recorded in [PR #32](https://github.com/titan717/dawghwa/pull/32) (`docs/research/providers-2026-11.md`) and `docs/research/comix-inventory.md` (2026-11-20/21). Nothing new was fetched for this file, and no third-party text, markup or styling is copied.

## What the earlier notes recorded

- comix-inventory (title page): the chapter list had one row per upload per scanlation group, not merged across groups. It also had a group filter, a sort control and 20 rows per page.
- PR #32 (live API, 12 titles): a match and readable chapters are different things. MangaDex matched every title exactly but had 0–4 chapters for licensed series. Chapter counts for the same series differ by provider (One Piece 1205 vs 1). Row counts differ from the latest chapter number because of `.5` extras and gaps. Exact matches can come through alternative titles ("Absolute Reign" vs "Absolute Dominion"). Low-score "possible" matches are usually different works.

## How several sources could be presented (internal model)

1. **One merged chapter list, not one row per upload.** Group rows by chapter number into a single canonical list. Each canonical chapter keeps a ranked set of internal source candidates. This is the opposite of the per-group rows recorded on comix.ws, and it fits "users never see sources".
2. **Two internal checks per source, both required.** A source counts as usable for a title only when (a) the match is exact (≥ 0.95) or high (≥ 0.82), and (b) the chapter fetch returned at least one chapter. Possible matches (0.6–0.82) never count.
3. **Silent default and fallback.** Pick the usable source with the highest latest chapter number. Ties go to exact over high, then the most recent update. If a chapter isn't on the default source, quietly use the next source that has that chapter number. If no source has it, say so to the user plainly (for example "Chapter 1199 isn't available yet") rather than jumping elsewhere without telling them.
4. **What the user sees instead of sources.** One "latest chapter" figure (the highest verified number), the merged chapter count, and per-chapter availability. If every source is blocked or empty, show one neutral state ("Chapters unavailable right now"), not a list of failing providers.
5. **Internal states to keep distinct (for logs and health, not the UI).** Readable · matched with 0 chapters · no match · possible match only · blocked by site · circuit open · timed out · not checked. They decide fallback order and feed `health:report`.
6. **Title-identity safety.** When a source's own title differs from the canonical title, log it, and treat it as lower confidence for automatic merging until it's confirmed. PR #32 couldn't confirm that the "Absolute Reign / Dominion / Domination" matches are one series.
7. **Language.** Only label a language when a source reports one. MangaDex and Webtoon do. Several scanlation sites don't.

## Constraint from cycle 1

As of [README.md](README.md), no candidate and no existing provider passes every gate. Any multi-source merging should therefore only run on sources the lead explicitly approves.
