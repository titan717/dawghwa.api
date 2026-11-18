import { describe, expect, it } from "vitest";
import { parseCoverUrl } from "@/lib/services/cover-image";

const ID = "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0";
const FILE = "e90bdc47-c8b9-4df7-b2c0-17641b645ee1.jpg";

describe("parseCoverUrl", () => {
  it("accepts MangaDex cover URLs, including thumbnails", () => {
    for (const s of [`https://uploads.mangadex.org/covers/${ID}/${FILE}`, `https://uploads.mangadex.org/covers/${ID}/${FILE}.256.jpg`, `https://uploads.mangadex.org/covers/${ID}/${FILE}.512.jpg`]) {
      expect(parseCoverUrl(s)?.toString()).toBe(s);
    }
  });
  it("rejects every other destination", () => {
    for (const s of [
      null,
      "",
      "not a url",
      `http://uploads.mangadex.org/covers/${ID}/${FILE}`,
      `https://uploads.mangadex.org.evil.example/covers/${ID}/${FILE}`,
      `https://evil.example/covers/${ID}/${FILE}`,
      `https://user:pw@uploads.mangadex.org/covers/${ID}/${FILE}`,
      `https://uploads.mangadex.org:8443/covers/${ID}/${FILE}`,
      `https://uploads.mangadex.org/covers/${ID}/${FILE}?x=1`,
      `https://uploads.mangadex.org/covers/${ID}/../../data/x.jpg`,
      `https://uploads.mangadex.org/data/${ID}/${FILE}`,
      `https://uploads.mangadex.org/covers/${ID}/${FILE}.html`,
      `https://uploads.mangadex.org/covers/not-a-uuid/${FILE}`,
    ]) {
      expect(parseCoverUrl(s)).toBeNull();
    }
  });
});
