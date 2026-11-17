/**
 * Title matching used to decide whether a source's search result is the same
 * series as a metadata entry. Deterministic and explainable: a normalized
 * exact/compact comparison, then a blend of character-bigram Dice similarity
 * and token overlap, with a penalty when the titles carry different numbers
 * ("Solo Leveling" vs "Solo Leveling 2") or one is a subtitle-extended version
 * of the other ("Solo Leveling" vs "Solo Leveling: Ragnarok").
 */

const STOPWORDS = new Set(["the", "a", "an", "of", "no", "wa", "ga", "wo", "to", "and"]);

export function normalizeTitle(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Remove bracketed annotations sources append, e.g. "Title (Manhwa)" or "Title [Official]". */
export function stripAnnotations(input: string): string {
  const stripped = input.replace(/\s*[[(（【][^\])）】]*[\])）】]\s*/g, " ").trim();
  return stripped || input;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) ?? 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

function tokens(s: string): string[] {
  return s.split(" ").filter((t) => t && !STOPWORDS.has(t));
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function numbers(s: string): string {
  return (s.match(/\d+/g) ?? []).map((n) => String(Number(n))).sort().join(",");
}

/** Similarity of two titles in [0, 1]. */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(stripAnnotations(a));
  const nb = normalizeTitle(stripAnnotations(b));
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ca = na.replace(/ /g, "");
  const cb = nb.replace(/ /g, "");
  if (ca === cb) return 0.98;
  const ta = tokens(na);
  const tb = tokens(nb);
  if (ta.length && tb.length && ta.join(" ") === tb.join(" ")) return 0.96;

  let score = (2 * dice(ca, cb) + jaccard(ta, tb)) / 3;
  if (numbers(na) !== numbers(nb)) score *= 0.8;
  // One title is the other plus extra words (sequel / spin-off subtitle).
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length && long.length > short.length && short.every((t) => long.includes(t))) {
    score = Math.min(score, 0.78);
  }
  return Math.round(score * 1000) / 1000;
}

/** Best similarity of `candidate` against any of the known titles. */
export function bestTitleScore(candidate: string, known: string[]): { score: number; against?: string } {
  let best = { score: 0, against: undefined as string | undefined };
  for (const k of known) {
    const s = titleSimilarity(candidate, k);
    if (s > best.score) best = { score: s, against: k };
    if (s === 1) break;
  }
  return best;
}

export type MatchConfidence = "exact" | "high" | "possible";

export function confidenceFor(score: number, minScore: number): MatchConfidence | undefined {
  if (score >= 0.95) return "exact";
  if (score >= minScore) return "high";
  if (score >= 0.6) return "possible";
  return undefined;
}

/**
 * Titles worth querying sources with, most useful first: English, romanized,
 * then short Latin-script synonyms. Native-script titles are kept for
 * matching but not used as queries (most sources only index Latin titles).
 */
export function searchableTitles(primary: string, alts: string[], max = 4): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [primary, ...alts]) {
    const n = normalizeTitle(t);
    if (!n || seen.has(n)) continue;
    if (!/^[\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}]+$/u.test(t)) continue;
    if (t.length > 120) continue;
    seen.add(n);
    out.push(t.trim());
    if (out.length >= max) break;
  }
  return out;
}
