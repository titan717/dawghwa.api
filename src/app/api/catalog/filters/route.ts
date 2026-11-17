import { json, route } from "@/lib/api/handler";
import { getFilterOptions, getMetadataProvider } from "@/lib/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/catalog/filters?provider=anilist - genres, tags, sorts, formats and statuses the provider supports. */
export const GET = route(async (req, ctx) => {
  const provider = getMetadataProvider(req.nextUrl.searchParams.get("provider")?.slice(0, 32) ?? undefined);
  const r = await getFilterOptions(provider);
  return json({ ...r.options, attribution: provider.attribution, meta: { cache: r.cache, age: r.age } }, ctx);
});
