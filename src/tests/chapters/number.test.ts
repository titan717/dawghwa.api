import { describe, expect, it } from "vitest";
import { chapterDisplay, compareChapters, parseChapterNumber, parseNumberString } from "@/lib/chapters/number";

const sortKeys = (items: { raw: string | null; title?: string; seq?: number }[]) =>
  items
    .map((i, idx) => ({ parsed: parseChapterNumber(i.raw, i.title), sequence: i.seq ?? idx, title: i.title, key: `${i.raw}|${i.title}` }))
    .sort(compareChapters)
    .map((s) => s.key);

describe("parseNumberString", () => {
  it("keeps the exact fraction digits instead of float-parsing", () => {
    expect(parseNumberString("1.10")).toEqual({ major: 1, minor: "10" });
    expect(parseNumberString("1.1")).toEqual({ major: 1, minor: "1" });
    expect(parseNumberString("10.5")).toEqual({ major: 10, minor: "5" });
    expect(parseNumberString("0")).toEqual({ major: 0, minor: null });
    expect(parseNumberString("0.5")).toEqual({ major: 0, minor: "5" });
  });
  it("normalizes leading zeros and .0 but rejects non-numbers", () => {
    expect(parseNumberString("007")).toEqual({ major: 7, minor: null });
    expect(parseNumberString("10.0")).toEqual({ major: 10, minor: null });
    expect(parseNumberString("10,5")).toEqual({ major: 10, minor: "5" });
    expect(parseNumberString("Prologue")).toBeNull();
    expect(parseNumberString("12a")).toBeNull();
    expect(parseNumberString(null)).toBeNull();
    expect(parseNumberString("")).toBeNull();
  });
});

describe("parseChapterNumber", () => {
  it("distinguishes 1 / 1.5 / 1.10 / 1.1", () => {
    const n = ["1", "1.5", "1.10", "1.1"].map((r) => parseChapterNumber(r).number);
    expect(new Set(n).size).toBe(4);
    expect(n).toEqual(["1", "1.5", "1.10", "1.1"]);
  });
  it("classifies prologues, epilogues, specials and oneshots", () => {
    expect(parseChapterNumber(null, "Prologue").kind).toBe("prologue");
    expect(parseChapterNumber("0", "Prologue").kind).toBe("prologue");
    expect(parseChapterNumber(null, "Epilogue").kind).toBe("epilogue");
    expect(parseChapterNumber(null, "Side Story - Rei (1)").kind).toBe("special");
    expect(parseChapterNumber(null, "Oneshot").kind).toBe("oneshot");
    expect(parseChapterNumber(null, "Vol. 2 Extras").kind).toBe("special");
    expect(parseChapterNumber(null, "Random notes").kind).toBe("unnumbered");
  });
  it("reads numbers from labels when the provider gives none", () => {
    expect(parseChapterNumber(null, "Episode 25")).toMatchObject({ kind: "regular", number: "25", source: "label" });
    expect(parseChapterNumber(null, "Ch. 12.5: Rain")).toMatchObject({ number: "12.5", source: "label" });
    expect(parseChapterNumber(null, "(S2) Episode 4")).toMatchObject({ number: "4", season: 2 });
  });
  it("never treats a list position as a chapter number", () => {
    // WEBTOON: episode_no 2 is titled "Episode 1"
    expect(parseChapterNumber("2", "Episode 1", "position")).toMatchObject({ number: "1", source: "label" });
    expect(parseChapterNumber("48", "Levels and Tiers", "position")).toMatchObject({ number: null, kind: "unnumbered" });
  });
  it("keeps numbered specials apart from the regular chapter", () => {
    const special = parseChapterNumber(null, "Bonus Episode 2 - Levels and Tiers");
    expect(special).toMatchObject({ kind: "special", number: "2" });
    expect(parseChapterNumber(null, "Episode 2").kind).toBe("regular");
  });
});

describe("compareChapters", () => {
  it("orders prologue < 0 < 0.5 < 1 < 1.1 < 1.5 < 1.10 < 2 < epilogue < specials", () => {
    const order = sortKeys([
      { raw: null, title: "Epilogue" },
      { raw: "1.10" },
      { raw: "2" },
      { raw: null, title: "Side story" },
      { raw: "1.5" },
      { raw: "0.5" },
      { raw: "1" },
      { raw: null, title: "Prologue" },
      { raw: "1.1" },
      { raw: "0" },
    ]);
    expect(order).toEqual([
      "null|Prologue",
      "0|undefined",
      "0.5|undefined",
      "1|undefined",
      "1.1|undefined",
      "1.5|undefined",
      "1.10|undefined",
      "2|undefined",
      "null|Epilogue",
      "null|Side story",
    ]);
  });
  it("puts a numbered special right after its regular chapter", () => {
    expect(sortKeys([{ raw: null, title: "Bonus Episode 2" }, { raw: "3" }, { raw: "2" }])).toEqual(["2|undefined", "null|Bonus Episode 2", "3|undefined"]);
  });
  it("is stable for unnumbered entries (provider sequence)", () => {
    const a = sortKeys([{ raw: null, title: "Notice B", seq: 5 }, { raw: null, title: "Notice A", seq: 9 }]);
    expect(a).toEqual(["null|Notice B", "null|Notice A"]);
  });
  it("sorts seasons before chapter numbers", () => {
    const order = sortKeys([{ raw: null, title: "(S2) Episode 1" }, { raw: null, title: "(S1) Episode 30" }]);
    expect(order).toEqual(["null|(S1) Episode 30", "null|(S2) Episode 1"]);
  });
});

describe("chapterDisplay", () => {
  it("labels kinds without inventing numbers", () => {
    expect(chapterDisplay(parseChapterNumber("10.5"))).toBe("Chapter 10.5");
    expect(chapterDisplay(parseChapterNumber(null, "Prologue"), "Prologue")).toBe("Prologue");
    expect(chapterDisplay(parseChapterNumber(null, "Bonus Episode 2"), "Bonus Episode 2")).toBe("Bonus Episode 2");
  });
});
