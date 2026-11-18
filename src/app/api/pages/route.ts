import { z } from "zod";
import { booleanish, httpUrlSchema, json, readJson, route, sourceIdSchema } from "@/lib/api/handler";
import { DawghwaError } from "@/lib/core/errors";
import { getRegistry } from "@/lib/providers/registry";
import { getChapterPages, resolveSourceUrl } from "@/lib/services/catalog";
import { parseMangaDexPageUrl, parseWebtoonPageUrl } from "@/lib/services/cover-image";

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
 * Returns image URLs for one chapter, only for sources whose provider offers a
 * documented, permitted page API (capabilities.chapterPages). Image bytes are
 * never proxied by Dawghwa.
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
  const pages = r.pages.map((page) => {
    const allowed = provider.id === "mangadex"
      ? parseMangaDexPageUrl(page.url)
      : provider.id === "webtoon"
        ? parseWebtoonPageUrl(page.url)
        : null;
    if (!allowed) return page;
    const image = new URL("/api/image", req.nextUrl.origin);
    image.searchParams.set("url", allowed.toString());
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
