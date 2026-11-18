import { describe, expect, it } from "vitest";
import { DynastyScansScraper } from "@/lib/scrapers/dynastyscans";

class FixtureDynastyScraper extends DynastyScansScraper {
  constructor(private readonly html: string) {
    super();
  }

  protected override async http(): Promise<Response> {
    return new Response(this.html, { status: 200, headers: { "Content-Type": "text/html" } });
  }
}

const chapterUrl = "https://dynasty-scans.com/chapters/example-chapter";

describe("Dynasty Reader chapter page adapter", () => {
  it("extracts the public JSON page manifest without executing scripts", async () => {
    const scraper = new FixtureDynastyScraper(`
      <script>
        var pages = [
          {"name":"001","image":"https://dynasty-scans.com/system/images/page-001.webp"},
          {"name":"002","image":"https://images.dynasty-scans.com/system/images/page-002.webp"}
        ];
      </script>
    `);

    const pages = await scraper.getChapterPages({ url: chapterUrl });
    expect(pages).toHaveLength(2);
    expect(pages[0]?.index).toBe(0);
    expect(pages[0]?.url).toContain("page-001.webp");
    expect(pages[1]?.url).toContain("page-002.webp");
  });

  it("rejects untrusted page hosts and does not execute non-JSON scripts", async () => {
    const scraper = new FixtureDynastyScraper(`
      <script>var pages = [ { name: "001", image: "https://evil.example/page.jpg" } ];</script>
      <div id="image"></div>
    `);

    await expect(scraper.getChapterPages({ url: chapterUrl })).rejects.toThrow(
      "Dynasty Reader returned no publicly readable chapter pages",
    );
  });

  it("does not pretend a single visible image is a complete chapter", async () => {
    const scraper = new FixtureDynastyScraper('<div id="image"><img src="https://dynasty-scans.com/system/images/page-001.jpg" alt="001"></div>');
    await expect(scraper.getChapterPages({ url: chapterUrl })).rejects.toThrow(
      "Dynasty Reader returned no publicly readable chapter pages",
    );
  });

  it("rejects non-chapter URLs", async () => {
    const scraper = new FixtureDynastyScraper("<div></div>");
    await expect(scraper.getChapterPages({ url: "https://dynasty-scans.com/series/example" })).rejects.toThrow(
      "Invalid Dynasty Reader chapter URL",
    );
  });
});
