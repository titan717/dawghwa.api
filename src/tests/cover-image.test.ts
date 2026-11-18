import { describe, expect, it } from "vitest";
import { parseCoverUrl, parseMangaDexPageUrl, parseWebtoonPageUrl } from "@/lib/services/cover-image";

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


describe("parseMangaDexPageUrl", () => {
  const hash = "a".repeat(32);
  const file = "1-8a6f8f5f1b8f4b8a.jpg";

  it("accepts only supported MangaDex @Home image paths", () => {
    for (const url of [
      `https://uploads.mangadex.org/data/${hash}/${file}`,
      `https://s1.mangadex.network/data-saver/${hash}/${file}`,
      `https://s2.mangadex.org/data/${hash}/${file}`,
    ]) {
      expect(parseMangaDexPageUrl(url)?.toString()).toBe(url);
    }
  });

  it("rejects untrusted hosts, paths, credentials and URL modifiers", () => {
    for (const url of [
      null,
      "",
      "not a url",
      `http://uploads.mangadex.org/data/${hash}/${file}`,
      `https://uploads.mangadex.org.evil.example/data/${hash}/${file}`,
      `https://evil.example/data/${hash}/${file}`,
      `https://user:pw@uploads.mangadex.org/data/${hash}/${file}`,
      `https://uploads.mangadex.org:8443/data/${hash}/${file}`,
      `https://uploads.mangadex.org/data/${hash}/${file}?token=x`,
      `https://uploads.mangadex.org/data/${hash}/../${file}`,
      `https://uploads.mangadex.org/covers/${hash}/${file}`,
      `https://uploads.mangadex.org/data/not-a-hash/${file}`,
      `https://uploads.mangadex.org/data/${hash}/image.html`,
    ]) {
      expect(parseMangaDexPageUrl(url)).toBeNull();
    }
  });
});


describe("parseWebtoonPageUrl", () => {
  it("accepts only the public WEBTOON image CDN hosts and image paths", () => {
    for (const url of [
      "https://webtoon-phinf.pstatic.net/2026/11/18/panel-001.jpg",
      "https://swebtoon-phinf.pstatic.net/2026/11/18/panel-002.webp?type=q70",
    ]) {
      expect(parseWebtoonPageUrl(url)?.toString()).toBe(url);
    }
  });

  it("rejects arbitrary hosts, credentials, ports and unsafe paths", () => {
    for (const url of [
      null,
      "https://evil.example/panel.jpg",
      "https://webtoon-phinf.pstatic.net.evil.example/panel.jpg",
      "http://webtoon-phinf.pstatic.net/panel.jpg",
      "https://user:pw@webtoon-phinf.pstatic.net/panel.jpg",
      "https://webtoon-phinf.pstatic.net:8443/panel.jpg",
      "https://webtoon-phinf.pstatic.net/a/../panel.jpg",
      "https://webtoon-phinf.pstatic.net/panel.html",
      "https://webtoon-phinf.pstatic.net/panel.jpg?other=1",
    ]) {
      expect(parseWebtoonPageUrl(url)).toBeNull();
    }
  });
});
