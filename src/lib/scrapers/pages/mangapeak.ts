/**
 * "mangapeak" WordPress theme (MangaTaro, RoliaScan).
 *
 * The reader page carries `<body data-chapter-id>` and its chapter.js loads
 * the pages for every visitor from `GET /auth/chapter-content?chapter_id=<id>`
 * → `{success, chapter_type, images: [url...]}`. Anonymous visitors get the
 * same response the public reader receives (no cookies are sent). A 403
 * INSUFFICIENT_ROLE is the site's own gate and is reported as locked; text
 * (novel) chapters have no page images.
 */
import * as cheerio from "cheerio";
import { UpstreamHttpError } from "@/lib/core/errors";
import { chapterLocked, formatChanged, pagesNotFound, type RawPage } from "./extract";

type Http = (input: string, init?: RequestInit) => Promise<Response>;

export async function mangapeakPages(http: Http, chapterUrl: string, source: string): Promise<RawPage[]> {
  const page = await http(chapterUrl);
  if (!page.ok) throw new UpstreamHttpError(page.status, chapterUrl);
  const $ = cheerio.load(await page.text());
  const id = $("body").attr("data-chapter-id")?.trim();
  if (!id || !/^\d+$/.test(id)) throw formatChanged(source, "the chapter id on the reader page");
  const api = `${new URL(chapterUrl).origin}/auth/chapter-content?chapter_id=${id}`;
  const res = await http(api, { headers: { Accept: "application/json", Referer: chapterUrl } });
  let data: { success?: boolean; code?: string; chapter_type?: string; images?: unknown[] };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    if (!res.ok) throw new UpstreamHttpError(res.status, api);
    throw formatChanged(source, "the chapter content response");
  }
  if (res.status === 403 || data.code === "INSUFFICIENT_ROLE") throw chapterLocked(source, "restricted by the provider");
  if (!res.ok) throw new UpstreamHttpError(res.status, api);
  if (data.chapter_type === "text") throw pagesNotFound(source, "publishes this chapter as text, not page images");
  if (!data.success || !Array.isArray(data.images)) throw formatChanged(source, "the chapter content response");
  return data.images.map((u) => ({ url: typeof u === "string" ? u : undefined }));
}
