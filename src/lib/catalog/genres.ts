/**
 * Genre vocabulary shared across providers.
 *
 * Providers spell the same genre differently ("Sci-Fi", "Sci-fi", "Science
 * Fiction"; "Boys' Love", "Boys Love"). Genres are compared by a normalized
 * key and shown under one canonical name. Only spellings that mean the same
 * genre are aliased; related-but-different genres (Shounen Ai vs Boys' Love,
 * Mahou Shoujo vs Magical Girls tag groups) are left distinct on purpose.
 */

import { normalizeTitle } from "@/lib/metadata/match";

const ALIASES: Record<string, string> = {
  "sci fi": "Sci-Fi",
  scifi: "Sci-Fi",
  "science fiction": "Sci-Fi",
  "boys love": "Boys' Love",
  "girls love": "Girls' Love",
  "slice of life": "Slice of Life",
  "martial art": "Martial Arts",
  "martial arts": "Martial Arts",
  "magical girls": "Magical Girls",
  "magical girl": "Magical Girls",
  "super power": "Superpowers",
  superpower: "Superpowers",
  superpowers: "Superpowers",
};

/** Comparison key for a genre name. */
export function genreKey(name: string): string {
  const n = normalizeTitle(name);
  const alias = ALIASES[n];
  return alias ? normalizeTitle(alias) : n;
}

/** Display name for a genre: the alias target, else the provider's spelling (trimmed). */
export function canonicalGenre(name: string): string {
  return ALIASES[normalizeTitle(name)] ?? name.trim();
}

/** Canonical, deduplicated genre list preserving first-seen order. */
export function canonicalGenres(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (!n || !n.trim()) continue;
    const k = genreKey(n);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(canonicalGenre(n));
  }
  return out;
}

/**
 * Translate a requested genre to a provider's own spelling, or undefined when
 * the provider's vocabulary has no such genre (the caller then skips that
 * provider instead of sending an unknown value).
 */
export function resolveGenre(requested: string, vocabulary: readonly string[]): string | undefined {
  const k = genreKey(requested);
  return vocabulary.find((v) => genreKey(v) === k);
}
