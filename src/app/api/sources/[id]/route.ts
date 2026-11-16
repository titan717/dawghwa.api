import { json, route } from "@/lib/api/handler";
import { describeProvider } from "@/lib/api/sources";
import { DawghwaError } from "@/lib/core/errors";
import { getRegistry } from "@/lib/providers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/sources/:id - one source with domains, limits, circuit and metrics. */
export const GET = route(async (req, ctx) => {
  const id = decodeURIComponent(req.nextUrl.pathname.split("/").pop() || "").slice(0, 64);
  const provider = getRegistry().get(id);
  if (!provider) throw new DawghwaError("SOURCE_NOT_FOUND", `Unknown source "${id}"`);
  return json({ source: describeProvider(provider, true) }, ctx);
});
