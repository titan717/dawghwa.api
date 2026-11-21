import { z } from "zod";
import { booleanish, json, parseWith, route } from "@/lib/api/handler";
import {
  browseCatalog,
  CATALOG_SORTS,
  DEMOGRAPHICS,
  getMetadataProvider,
  MATCH_MODES,
  TITLE_FORMATS,
  TITLE_STATUSES,
} from "@/lib/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const list = z
  .array(z.string().trim().max(64))
  .max(20)
  .transform((v) => v.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean))
  .optional();

const enumList = (values: readonly string[]) =>
  z
    .array(z.string().trim().max(64))
    .max(20)
    .transform((v) => [...new Set(v.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean))])
    .pipe(z.array(z.enum(values as [string, ...string[]])).max(10))
    .optional();

const querySchema = z.object({
  provider: z.string().trim().max(32).optional(),
  q: z.string().trim().max(200).optional(),
  genres: list,
  excludeGenres: list,
  tags: list,
  status: enumList(TITLE_STATUSES),
  format: enumList(TITLE_FORMATS),
  demographics: enumList(DEMOGRAPHICS),
  genreMode: z.enum(MATCH_MODES as [string, ...string[]]).optional(),
  excludeMode: z.enum(MATCH_MODES as [string, ...string[]]).optional(),
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  sort: z.enum(CATALOG_SORTS as [string, ...string[]]).optional(),
  nsfw: booleanish.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  refresh: booleanish.optional(),
});

/**
 * GET /api/catalog?provider=anilist&q=&genre=Action&genre=Fantasy&excludeGenre=&tag=&status=ongoing
 *   &format=manhwa&year=2018&sort=popularity&nsfw=false&page=1&limit=20
 *
 * `status` and `format` may repeat (or be comma separated) to match any of
 * several values; `demographic` likewise. `genreMode=and|or` controls how
 * included genres/tags combine and `excludeMode=or|and` how excluded ones do.
 * A provider that cannot apply a filter rejects the request (400) rather than
 * ignoring it; GET /api/catalog/filters lists what each provider supports.
 *
 * Browse/search series metadata from AniList, MangaDex or MangaUpdates. Use
 * GET /api/titles/:ref/sources on a result to find which sources carry it.
 */
export const GET = route(async (req, ctx) => {
  const sp = req.nextUrl.searchParams;
  const all = (...keys: string[]) => {
    const v = keys.flatMap((k) => sp.getAll(k));
    return v.length ? v : undefined;
  };
  const params = parseWith(querySchema, {
    provider: sp.get("provider") ?? undefined,
    q: sp.get("q") ?? undefined,
    genres: all("genre", "genres"),
    excludeGenres: all("excludeGenre", "excludeGenres"),
    tags: all("tag", "tags"),
    status: all("status", "statuses"),
    format: all("format", "formats"),
    demographics: all("demographic", "demographics"),
    genreMode: sp.get("genreMode") ?? undefined,
    excludeMode: sp.get("excludeMode") ?? undefined,
    year: sp.get("year") ?? undefined,
    sort: sp.get("sort") ?? undefined,
    nsfw: sp.get("nsfw") ?? undefined,
    page: sp.get("page") ?? undefined,
    limit: sp.get("limit") ?? undefined,
    refresh: sp.get("refresh") ?? undefined,
  });
  const provider = getMetadataProvider(params.provider);
  const { refresh, status, format, provider: _p, ...rest } = params;
  void _p;
  // A single value keeps the long-standing `status` / `format` filters, so
  // providers that only support one value keep working; several values need
  // the provider to support the multi-value `statuses` / `formats` filters.
  const query = {
    ...rest,
    ...(status?.length === 1 ? { status: status[0] } : status?.length ? { statuses: status } : {}),
    ...(format?.length === 1 ? { format: format[0] } : format?.length ? { formats: format } : {}),
  };
  const r = await browseCatalog(provider, query as Parameters<typeof browseCatalog>[1], { forceRefresh: refresh });
  return json(
    {
      provider: provider.id,
      items: r.result.items,
      pageInfo: r.result.pageInfo,
      attribution: provider.attribution,
      meta: { cache: r.cache, age: r.age },
    },
    ctx,
  );
});
