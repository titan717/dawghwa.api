import { z } from "zod";
import { booleanish, httpUrlSchema, json, readJson, route, sourceIdSchema } from "@/lib/api/handler";
import { DawghwaError } from "@/lib/core/errors";
import { getRegistry } from "@/lib/providers/registry";
import { getChapterPages, resolveSourceUrl } from "@/lib/services/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    source: sourceIdSchema.optional(),
    chapterId: z.string().trim().min(1).max(128).regex(/^[\w-]+$/, "chapterId contains invalid characters").optional(),
    url: httpUrlSchema.optional(),
    /** MangaDex: compressed "data-saver" images. */
    dataSaver: booleanish.optional(),
    refresh: booleanish.optional(),
  })
  .refine((b) => b.chapterId || b.url, { message: "Provide chapterId (with source) or a chapter url" })
  .refine((b) => b.url || b.source, { message: "source is required when using chapterId", path: ["source"] });

/**
 * POST /api/pages  { source, chapterId } | { url, source? }
 *
 * Returns the ordered page images of one chapter from the provider's own
 * reader, for sources with capabilities.chapterPages. Dispatches to the
 * selected provider's adapter (no MangaDex-specific ids are assumed); page
 * URLs are rewritten to /api/image?source=<id> so bytes are relayed only from
 * that provider's declared image hosts. Locked chapters -> 403 CHAPTER_LOCKED,
 * empty -> 404 PAGES_NOT_FOUND, scrambled -> 422 PAGES_PROTECTED.
 */
export const POST = route(async (req, ctx) => {
  const body = await readJson(req, bodySchema);
  let provider;
  let ref: { chapterId?: string; url?: string };
  if (body.url) {
    const resolved = resolveSourceUrl(body.url, body.source);
    provider = resolved.provider;
    ref = { url: resolved.url.toString(), chapterId: body.chapterId };
  } else {
    provider = getRegistry().get(body.source!);
    if (!provider) throw new DawghwaError("SOURCE_NOT_FOUND", `Unknown source "${body.source}"`);
    ref = { chapterId: body.chapterId };
  }
  const r = await getChapterPages(provider, ref, { dataSaver: body.dataSaver, forceRefresh: body.refresh });
  // Every page is served through /api/image, scoped to this provider's page hosts.
  // A page the relay would refuse is never handed out as a direct upstream URL:
  // the whole response fails closed so the reader falls back to another version.
  const refused = r.pages.filter((page) => !provider.scraper.allowPageImage(page.url));
  if (refused.length) {
    let hosts: string[] = [];
    try {
      hosts = [...new Set(refused.map((p) => new URL(p.url).hostname))].slice(0, 5);
    } catch {
      /* unparsable page URL: reported by count only */
    }
    throw new DawghwaError(
      "PAGE_FORMAT_CHANGED",
      `${provider.name} returned ${refused.length} page image(s) outside its declared image hosts`,
      { details: { refused: refused.length, total: r.pages.length, hosts } },
    );
  }
  const pages = r.pages.map((page) => {
    const allowed = provider.scraper.allowPageImage(page.url)!;
    const image = new URL("/api/image", req.nextUrl.origin);
    image.searchParams.set("url", allowed.toString());
    image.searchParams.set("source", provider.id);
    return { ...page, url: image.toString() };
  });
  return json(
    {
      pages,
      totalPages: r.pages.length,
      source: provider.name,
      sourceId: provider.id,
      chapterId: ref.chapterId,
      meta: { cache: r.cache, age: r.age, dataSaver: Boolean(body.dataSaver) },
    },
    ctx,
  );
});
