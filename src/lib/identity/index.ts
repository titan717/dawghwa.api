/**
 * Canonical title identity.
 *
 * A Dawghwa canonical title is independent of any reading provider. Its id is
 * derived deterministically from the strongest metadata identifier available
 * (MangaDex, then AniList, then MangaUpdates), so the same series reached via
 * `anilist:105398` or via the MangaDex entry that links to it resolves to the
 * same `dwg:md:<uuid>` id once the exact cross-reference is known.
 *
 * Reading providers are linked to a canonical title in two ways:
 *   1. exact cross-reference: an id/URL published by the metadata database
 *      (MangaDex id, MangaDex `links.engtl`/`links.raw` pointing at WEBTOON)
 *   2. corroborated fuzzy match: title similarity is never enough on its own;
 *      a candidate must also match on an independent signal (author/artist)
 *      and must not contradict any (different author, novel edition, sequel
 *      numbering). Everything else is reported as `review` or `rejected` and
 *      is never merged automatically.
 *
 * Every decision carries its evidence so `/api/titles/:ref/identity` can show
 * why two records were (or were not) linked.
 */

import { bestTitleScore, normalizeTitle } from "@/lib/metadata/match";
import type { TitleMetadata } from "@/lib/metadata/types";

export type LinkMethod = "exact-id" | "exact-link" | "corroborated-match";
export type LinkDecision = "linked" | "review" | "rejected";

export interface LinkSignal {
  name: "title" | "alias" | "author" | "format" | "edition" | "year" | "xref";
  /** +1 corroborates, 0 neutral/unknown, -1 contradicts. */
  effect: 1 | 0 | -1;
  detail: string;
  weight?: number;
}

export interface LinkEvidence {
  method: LinkMethod | "fuzzy";
  decision: LinkDecision;
  /** 0..1 */
  confidence: number;
  signals: LinkSignal[];
  /** One-line explanation. */
  reason: string;
}

export interface ProviderLink {
  sourceId: string;
  source: string;
  providerTitleId: string;
  url: string;
  title: string;
  evidence: LinkEvidence;
}

export interface CanonicalTitle {
  /** `dwg:<md|al|mu>:<id>` */
  id: string;
  /** The metadata ref the request came in with. */
  ref: string;
  title: string;
  altTitles: string[];
  /** Normalized titles used for matching (deduplicated). */
  aliases: string[];
  authors: string[];
  artists: string[];
  originalLanguage?: string;
  format?: string;
  status?: string;
  year?: number;
  externalIds: TitleMetadata["externalIds"];
}

export function canonicalTitleId(meta: Pick<TitleMetadata, "provider" | "providerId" | "externalIds">): string {
  const md = meta.externalIds.mangadex ?? (meta.provider === "mangadex" ? meta.providerId : undefined);
  if (md) return `dwg:md:${md.toLowerCase()}`;
  const al = meta.externalIds.anilist ?? (meta.provider === "anilist" ? Number(meta.providerId) : undefined);
  if (al) return `dwg:al:${al}`;
  const mu = meta.externalIds.mangaupdates ?? (meta.provider === "mangaupdates" ? meta.providerId : undefined);
  return `dwg:mu:${mu ?? meta.providerId}`;
}

export function buildCanonicalTitle(meta: TitleMetadata): CanonicalTitle {
  const titles = [meta.titles?.english, meta.title, meta.titles?.romaji, meta.titles?.native, ...meta.altTitles].filter(
    (t): t is string => Boolean(t && t.trim()),
  );
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const t of titles) {
    const n = normalizeTitle(t);
    if (n && !seen.has(n)) {
      seen.add(n);
      aliases.push(t.trim());
    }
  }
  return {
    id: canonicalTitleId(meta),
    ref: meta.ref,
    title: meta.title,
    altTitles: meta.altTitles,
    aliases,
    authors: meta.authors ?? [],
    artists: meta.artists ?? [],
    originalLanguage: meta.originalLanguage,
    format: meta.format,
    status: meta.status,
    year: meta.year,
    externalIds: meta.externalIds,
  };
}

/** Exact provider links published by the metadata database. */
export function exactProviderLinks(
  meta: TitleMetadata,
  providers: { id: string; name: string }[],
): ProviderLink[] {
  const has = new Map(providers.map((p) => [p.id, p.name]));
  const out: ProviderLink[] = [];
  const md = meta.externalIds.mangadex ?? (meta.provider === "mangadex" ? meta.providerId : undefined);
  if (md && has.has("mangadex")) {
    out.push({
      sourceId: "mangadex",
      source: has.get("mangadex")!,
      providerTitleId: md,
      url: `https://mangadex.org/title/${md}`,
      title: meta.title,
      evidence: {
        method: "exact-id",
        decision: "linked",
        confidence: 1,
        signals: [{ name: "xref", effect: 1, detail: `MangaDex id ${md} from ${meta.provider === "mangadex" ? "the title ref" : "the metadata cross-reference"}` }],
        reason: "Same MangaDex record",
      },
    });
  }
  if (has.has("webtoon")) {
    for (const link of meta.links ?? []) {
      let url: URL;
      try {
        url = new URL(link.url);
      } catch {
        continue;
      }
      if (url.hostname !== "www.webtoons.com" && url.hostname !== "webtoons.com") continue;
      const titleNo = url.searchParams.get("title_no");
      if (!titleNo || !/^\d{1,9}$/.test(titleNo) || !/\/list\/?$/.test(url.pathname)) continue;
      if (out.some((l) => l.sourceId === "webtoon" && l.providerTitleId === titleNo)) continue;
      out.push({
        sourceId: "webtoon",
        source: has.get("webtoon")!,
        providerTitleId: titleNo,
        url: `https://www.webtoons.com${url.pathname}?title_no=${titleNo}`,
        title: meta.title,
        evidence: {
          method: "exact-link",
          decision: "linked",
          confidence: 1,
          signals: [{ name: "xref", effect: 1, detail: `${link.site} link published by the metadata database: title_no=${titleNo}` }],
          reason: `Official ${link.site} link from the metadata record`,
        },
      });
    }
  }
  return out;
}

export interface CandidateRecord {
  sourceId: string;
  source: string;
  providerTitleId: string;
  url: string;
  title: string;
  altTitles?: string[];
  /** undefined = provider does not expose authors (unknown), [] = none listed. */
  authors?: string[];
  year?: number;
}

const NOVEL_MARK = /\b(?:light\s+|web\s+)?novels?\b|\bLN\b/i;

/** "Kitazawa, Akari" / "AOI (あおい)" / "Akari KITAZAWA" -> comparable tokens. */
export function normalizePerson(name: string): string {
  return normalizeTitle(name.replace(/\([^)]*\)/g, " ")).split(" ").filter(Boolean).sort().join(" ");
}

function peopleOverlap(a: string[], b: string[]): { match: boolean; detail: string } {
  const A = new Map(a.map((n) => [normalizePerson(n), n]));
  for (const n of b) {
    const key = normalizePerson(n);
    if (key && A.has(key)) return { match: true, detail: `${n} = ${A.get(key)}` };
  }
  return { match: false, detail: `${b.join(", ") || "none"} vs ${a.join(", ") || "none"}` };
}

/** Thresholds are part of the contract; tests pin them. */
export const LINK_THRESHOLDS = { title: 0.9, review: 0.75 } as const;

/**
 * Decide whether a provider record is the canonical title. Deterministic and
 * explainable: same inputs -> same decision and signals.
 */
export function scoreCandidate(canonical: CanonicalTitle, c: CandidateRecord): LinkEvidence {
  const signals: LinkSignal[] = [];
  const candidateTitles = [c.title, ...(c.altTitles ?? [])].filter(Boolean);
  let best = { score: 0, against: undefined as string | undefined, via: c.title };
  for (const t of candidateTitles) {
    const s = bestTitleScore(t, canonical.aliases);
    if (s.score > best.score) best = { score: s.score, against: s.against, via: t };
  }
  signals.push({
    name: best.via === c.title ? "title" : "alias",
    effect: best.score >= LINK_THRESHOLDS.title ? 1 : best.score >= LINK_THRESHOLDS.review ? 0 : -1,
    detail: `"${best.via}" vs "${best.against ?? canonical.title}" = ${best.score.toFixed(3)}`,
    weight: best.score,
  });

  const people = [...canonical.authors, ...canonical.artists];
  let author: 1 | 0 | -1 = 0;
  if (c.authors === undefined || !c.authors.length || !people.length) {
    signals.push({ name: "author", effect: 0, detail: c.authors === undefined ? "Provider does not expose authors" : "No author information to compare" });
  } else {
    const o = peopleOverlap(people, c.authors);
    author = o.match ? 1 : -1;
    signals.push({ name: "author", effect: author, detail: o.match ? `Author match: ${o.detail}` : `Different authors: ${o.detail}` });
  }

  const novel = NOVEL_MARK.test(c.title) && canonical.format !== "novel" && !canonical.aliases.some((t) => NOVEL_MARK.test(t));
  if (novel) signals.push({ name: "edition", effect: -1, detail: "Candidate is a novel edition; the canonical title is not" });

  if (c.year && canonical.year && Math.abs(c.year - canonical.year) > 2) {
    signals.push({ name: "year", effect: -1, detail: `Year ${c.year} vs ${canonical.year}` });
  }

  const contradicted = signals.some((s) => s.effect === -1 && s.name !== "title" && s.name !== "alias");
  const titleOk = best.score >= LINK_THRESHOLDS.title;
  const confidence = Math.round(Math.min(1, best.score * (author === 1 ? 1 : 0.8) * (contradicted ? 0.5 : 1)) * 1000) / 1000;

  if (contradicted) {
    return { method: "fuzzy", decision: "rejected", confidence, signals, reason: "Contradicting metadata (" + signals.filter((s) => s.effect === -1 && s.name !== "title").map((s) => s.name).join(", ") + ")" };
  }
  if (titleOk && author === 1) {
    return { method: "corroborated-match", decision: "linked", confidence, signals, reason: "Title and author agree" };
  }
  if (best.score >= LINK_THRESHOLDS.review) {
    return { method: "fuzzy", decision: "review", confidence, signals, reason: titleOk ? "Title matches but no independent signal corroborates it; not merged" : "Similar title only; not merged" };
  }
  return { method: "fuzzy", decision: "rejected", confidence, signals, reason: "Title does not match" };
}
