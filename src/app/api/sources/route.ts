import { z } from "zod";
import { json, parseWith, route } from "@/lib/api/handler";
import { describeProvider } from "@/lib/api/sources";
import { getRegistry } from "@/lib/providers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["active", "unstable", "shutdown", "disabled", "operational"]).optional(),
  capability: z.enum(["search", "chapters", "mangaInfo", "frontpage", "chapterPages", "browse", "clientOnly"]).optional(),
  type: z.enum(["scanlator", "aggregator"]).optional(),
  verbose: z.enum(["true", "false", "1", "0"]).optional(),
});

/**
 * GET /api/sources
 * Lists every registered source with status, capabilities and circuit state.
 * Optional filters: ?status=, ?capability=, ?type=, ?verbose=true
 */
export const GET = route(async (req, ctx) => {
  const q = parseWith(querySchema, Object.fromEntries(req.nextUrl.searchParams));
  const verbose = q.verbose === "true" || q.verbose === "1";
  let providers = getRegistry().all();
  if (q.status === "operational") providers = providers.filter((p) => p.operational);
  else if (q.status === "disabled") providers = providers.filter((p) => p.isDisabled);
  else if (q.status) providers = providers.filter((p) => p.descriptor.status === q.status && !p.isDisabled);
  if (q.capability) providers = providers.filter((p) => p.capabilities[q.capability!]);
  if (q.type) providers = providers.filter((p) => p.descriptor.type === q.type);
  // Upstream listed sources in registration order; Dawghwa lists by priority, then name.
  return json(
    { sources: providers.map((p) => describeProvider(p, verbose)), total: providers.length },
    ctx,
    { cacheControl: "public, max-age=60" },
  );
});
