import { describe, expect, it } from "vitest";
import { WebtoonScraper } from "@/lib/scrapers/webtoon";

class FixtureWebtoonScraper extends WebtoonScraper {
  constructor(private readonly html: string) {
    super();
  }

  protected override async http(): Promise<Response> {
    return new Response(this.html, { status: 200, headers: { "Content-Type": "text/html" } });
  }
}

const viewerUrl = "https://www.webtoons.com/en/fantasy/example/episode-1/viewer?title_no=1&episode_no=1";

describe("WEBTOON chapter page adapter", () => {
  it("extracts public data-url panels and dimensions from viewer HTML", async () => {
    const scraper = new FixtureWebtoonScraper(`
      <div id="_imageList">
        <img class="_images" src="transparency.png" data-url="https://webtoon-phinf.pstatic.net/2026/11/18/panel-001.jpg" width="800" height="1200">
        <img class="_images" data-url="https://swebtoon-phinf.pstatic.net/2026/11/18/panel-002.webp?type=q70" width="800" height="1180">
      </div>
    `);

    const pages = await scraper.getChapterPages({ url: viewerUrl });
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ index: 0, width: 800, height: 1200 });
    expect(pages[0]?.url).toContain("panel-001.jpg");
    expect(pages[1]?.index).toBe(1);
  });

  it("does not return placeholder or untrusted image hosts", async () => {
    const scraper = new FixtureWebtoonScraper(`
      <div id="_imageList">
        <img class="_images" src="https://webtoon-phinf.pstatic.net/transparency.png">
        <img class="_images" data-url="https://evil.example/panel.jpg">
      </div>
    `);

    await expect(scraper.getChapterPages({ url: viewerUrl })).rejects.toThrow(
      "WEBTOON returned no publicly readable episode panels",
    );
  });

  it("rejects non-viewer URLs", async () => {
    const scraper = new FixtureWebtoonScraper("<div></div>");
    await expect(scraper.getChapterPages({ url: "https://www.webtoons.com/en/title/list" })).rejects.toThrow(
      "Invalid WEBTOON viewer URL",
    );
  });
});
