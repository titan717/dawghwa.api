import { describe, expect, it } from "vitest";
import { bestTitleScore, confidenceFor, normalizeTitle, searchableTitles, titleSimilarity } from "@/lib/metadata/match";

describe("title matching", () => {
  it("normalizes case, punctuation and diacritics", () => {
    expect(normalizeTitle("  Kaguya-sama: Love Is War!  ")).toBe(normalizeTitle("kaguya sama love is war"));
    expect(normalizeTitle("Pokémon")).toBe(normalizeTitle("Pokemon"));
  });

  it("scores exact and near-exact titles highly", () => {
    expect(titleSimilarity("Solo Leveling", "Solo Leveling")).toBe(1);
    expect(titleSimilarity("Solo Leveling", "Solo Leveling (Manhwa)")).toBe(1);
    expect(titleSimilarity("The Beginning After the End", "Beginning After The End")).toBeGreaterThanOrEqual(0.95);
  });

  it("keeps sequels and spin-offs below the high-confidence threshold", () => {
    expect(titleSimilarity("Solo Leveling", "Solo Leveling: Ragnarok")).toBeLessThan(0.82);
    expect(titleSimilarity("Jujutsu Kaisen", "Jujutsu Kaisen 0")).toBeLessThan(0.82);
    expect(titleSimilarity("Solo Leveling", "Omniscient Reader")).toBeLessThan(0.6);
  });

  it("matches against every known title and reports which one matched", () => {
    const r = bestTitleScore("Na Honjaman Level Up", ["Solo Leveling", "Na Honjaman Level Up"]);
    expect(r.score).toBe(1);
    expect(r.against).toBe("Na Honjaman Level Up");
  });

  it("maps scores to confidence levels", () => {
    expect(confidenceFor(1, 0.82)).toBe("exact");
    expect(confidenceFor(0.85, 0.82)).toBe("high");
    expect(confidenceFor(0.7, 0.82)).toBe("possible");
    expect(confidenceFor(0.3, 0.82)).toBeUndefined();
  });

  it("only uses Latin-script titles as search queries", () => {
    const q = searchableTitles("Solo Leveling", ["나 혼자만 레벨업", "Na Honjaman Level Up", "solo leveling", "俺だけレベルアップな件"]);
    expect(q).toEqual(["Solo Leveling", "Na Honjaman Level Up"]);
  });
});
