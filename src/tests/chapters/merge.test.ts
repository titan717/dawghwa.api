import { describe, expect, it } from "vitest";
import { fallbackCompatibility, mergeChapters, type ProviderChapterInput } from "@/lib/chapters/merge";

const T = "dwg:md:test";
const ch = (id: string, extra: Partial<ProviderChapterInput["chapters"][number]> = {}) => ({
  id,
  number: Number(extra.chapterLabel ?? 0),
  url: `https://example.org/${id}`,
  language: "en",
  ...extra,
});
const md = (chapters: ProviderChapterInput["chapters"]): ProviderChapterInput => ({ sourceId: "mangadex", source: "MangaDex", edition: "scanlation", chapters });
const dy = (chapters: ProviderChapterInput["chapters"]): ProviderChapterInput => ({ sourceId: "dynasty-reader", source: "Dynasty", edition: "scanlation", chapters });
const wt = (chapters: ProviderChapterInput["chapters"]): ProviderChapterInput => ({ sourceId: "webtoon", source: "WEBTOON", edition: "official", chapters });

describe("mergeChapters", () => {
  it("merges the same chapter from different providers into one row", () => {
    const rows = mergeChapters(T, [md([ch("a1", { chapterLabel: "1" })]), dy([ch("d1", { chapterLabel: "1" })])]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe(`${T}/en/s0/ch:1`);
    expect(rows[0]!.variants.map((v) => v.variantId)).toEqual(["dynasty-reader:d1", "mangadex:a1"]);
    expect(rows[0]!.variants.every((v) => v.match === "number")).toBe(true);
  });

  it("never merges 1 with 1.5, 10 with 10.5, 1.1 with 1.10, or 0 with 0.5", () => {
    const labels = ["1", "1.5", "10", "10.5", "1.1", "1.10", "0", "0.5"];
    const rows = mergeChapters(T, [md(labels.map((l) => ch(`m${l}`, { chapterLabel: l }))), dy(labels.map((l) => ch(`d${l}`, { chapterLabel: l })))]);
    expect(rows).toHaveLength(labels.length);
    expect(rows.map((r) => r.number)).toEqual(["0", "0.5", "1", "1.1", "1.5", "1.10", "10", "10.5"]);
    for (const r of rows) expect(r.variants).toHaveLength(2);
  });

  it("keeps languages separate", () => {
    const rows = mergeChapters(T, [md([ch("en", { chapterLabel: "3" }), ch("es", { chapterLabel: "3", language: "es-la" })])]);
    expect(rows.map((r) => r.language).sort()).toEqual(["en", "es-la"]);
  });

  it("does not merge unknown language into a known one", () => {
    const rows = mergeChapters(T, [md([ch("a", { chapterLabel: "3" })]), dy([ch("b", { chapterLabel: "3", language: undefined })])]);
    expect(rows).toHaveLength(2);
  });

  it("keeps translation groups of one chapter as separate variants of one row", () => {
    const rows = mergeChapters(T, [
      md([ch("g1", { chapterLabel: "5", group: { id: "g1", name: "Alpha" } }), ch("g2", { chapterLabel: "5", group: { id: "g2", name: "Beta" } })]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.translations).toBe(2);
    expect(rows[0]!.variants.map((v) => v.group?.name)).toEqual(["Alpha", "Beta"]);
  });

  it("keeps two entries from the same provider and group apart", () => {
    const rows = mergeChapters(T, [dy([ch("x1", { chapterLabel: "4" }), ch("x2", { chapterLabel: "4" })])]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it("does not merge when volumes contradict", () => {
    const rows = mergeChapters(T, [md([ch("a", { chapterLabel: "1", volume: "1" })]), dy([ch("b", { chapterLabel: "1", volume: "2" })])]);
    expect(rows).toHaveLength(2);
  });

  it("does not merge when meaningful titles contradict", () => {
    const rows = mergeChapters(T, [md([ch("a", { chapterLabel: "7", title: "The Lighthouse Keeper" })]), dy([ch("b", { chapterLabel: "7", title: "Summer Festival Fireworks" })])]);
    expect(rows).toHaveLength(2);
  });

  it("marks agreeing meaningful titles as exact matches", () => {
    const rows = mergeChapters(T, [md([ch("a", { chapterLabel: "7", title: "Summer Festival" })]), dy([ch("b", { chapterLabel: "7", title: "Summer festival!" })])]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.variants.every((v) => v.match === "exact")).toBe(true);
  });

  it("merges unnumbered entries only on identical meaningful titles", () => {
    const rows = mergeChapters(T, [
      md([ch("a", { chapterLabel: null, title: "Side Story: Beach Day" }), ch("b", { chapterLabel: null, title: "Notice" })]),
      dy([ch("c", { chapterLabel: null, title: "Side Story: Beach Day" }), ch("d", { chapterLabel: null, title: "Afterword" })]),
    ]);
    const beach = rows.find((r) => r.title?.includes("Beach"));
    expect(beach!.variants).toHaveLength(2);
    expect(rows).toHaveLength(3);
  });

  it("ignores WEBTOON list positions and uses episode titles", () => {
    const rows = mergeChapters(T, [
      wt([
        ch("1", { number: 1, chapterLabel: null, numberSource: "position", title: "Prologue", sequence: 1 }),
        ch("2", { number: 2, chapterLabel: null, numberSource: "position", title: "Episode 1", sequence: 2 }),
        ch("48", { number: 48, chapterLabel: null, numberSource: "position", title: "Bonus Episode 2 - Levels and Tiers", sequence: 48 }),
        ch("3", { number: 3, chapterLabel: null, numberSource: "position", title: "Episode 2", sequence: 3 }),
      ]),
    ]);
    expect(rows.map((r) => r.key.slice(T.length + 1))).toEqual(["en/s0/prologue:prologue", "en/s0/ch:1", "en/s0/ch:2", "en/s0/special:2"]);
  });

  it("is deterministic regardless of provider arrival order", () => {
    const a = md([ch("a1", { chapterLabel: "1", title: "Start" }), ch("a2", { chapterLabel: "2" })]);
    const b = dy([ch("b1", { chapterLabel: "1" }), ch("b3", { chapterLabel: "3" })]);
    expect(JSON.stringify(mergeChapters(T, [a, b]))).toBe(JSON.stringify(mergeChapters(T, [b, a])));
  });

  it("assigns stable, unique keys and sequential order", () => {
    const rows = mergeChapters(T, [md(["1", "2", "2.5", "3"].map((l) => ch(l, { chapterLabel: l })))]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(rows.map((r) => r.order)).toEqual([0, 1, 2, 3]);
  });
});

describe("fallbackCompatibility", () => {
  const rows = mergeChapters(T, [
    md([ch("m1", { chapterLabel: "1", group: { id: "g", name: "G" } })]),
    dy([ch("d1", { chapterLabel: "1" })]),
    wt([ch("w1", { chapterLabel: null, numberSource: "position", title: "Episode 1" })]),
  ]);
  const row = rows[0]!;
  const v = (id: string) => row.variants.find((x) => x.variantId === id)!;

  it("allows automatic fallback to the same language and edition", () => {
    const r = fallbackCompatibility(row, v("mangadex:m1"), v("dynasty-reader:d1"));
    expect(r).toMatchObject({ ok: true, automatic: true });
    if (r.ok) expect(r.differences).toContain("source");
  });

  it("does not switch edition automatically", () => {
    const r = fallbackCompatibility(row, v("mangadex:m1"), v("webtoon:w1"));
    expect(r).toMatchObject({ ok: true, automatic: false });
  });

  it("rejects other chapters and other languages", () => {
    const other = mergeChapters(T, [md([ch("x", { chapterLabel: "2" }), ch("y", { chapterLabel: "1", language: "fr" })])]);
    expect(fallbackCompatibility(row, v("mangadex:m1"), other[0]!.variants[0]!).ok).toBe(false);
    const multi = mergeChapters(T, [md([ch("a", { chapterLabel: "1" })]), dy([ch("b", { chapterLabel: "1", language: "fr" })])]);
    for (const r of multi) expect(r.variants).toHaveLength(1);
  });
});
