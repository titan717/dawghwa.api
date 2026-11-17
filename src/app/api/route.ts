import { json, route } from "@/lib/api/handler";
import { getConfig } from "@/lib/core/config";
import { getCacheInfo } from "@/lib/core/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api - service index. */
export const GET = route(
  async (_req, ctx) =>
    json(
      {
        name: "Dawghwa API",
        version: getConfig().version,
        docs: "https://github.com/titan717/dawghwa.api/blob/main/docs/API.md",
        cache: getCacheInfo().backend,
        endpoints: [
          "GET  /api/sources",
          "GET  /api/sources/:id",
          "POST /api/search",
          "POST /api/chapters",
          "POST /api/manga",
          "POST /api/pages",
          "GET  /api/browse",
          "POST /api/browse",
          "GET  /api/health",
          "POST /api/health",
          "GET  /api/frontpage",
          "POST /api/frontpage",
          "GET  /api/proxy/html",
        ],
      },
      ctx,
      { cacheControl: "public, max-age=300" },
    ),
  { rate: "none" },
);
