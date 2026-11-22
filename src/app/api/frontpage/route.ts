import { z } from "zod";
import { booleanish, json, readJson, route, sourceIdSchema } from "@/lib/api/handler";
import { DawghwaError } from "@/lib/core/errors";
import { getRegistry } from "@/lib/providers/registry";
import { getFrontpageSection } from "@/lib/services/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/frontpage - sources with frontpage support and their sections. */
export const GET = route(async (_req, ctx) => {
  const frontpages = frontpageProviders();
  return json({ sources: frontpages.map((p) => p.frontpage!.getInfo()), sourceIds: frontpages.map((p) => p.id) }, ctx, {
    cacheControl: "public, max-age=300",
  });
});

/** Frontpage-capable providers registered on this server (respects EXPERIMENTAL_PROVIDERS). */
function frontpageProviders() {
  return getRegistry()
    .all()
    .filter((p) => p.frontpage);
}

const bodySchema = z.object({
  source: sourceIdSchema,
  section: z.string().trim().min(1, "Section is required").max(64).regex(/^[a-z_]+$/, "section must be a section id"),
  page: z.number().int().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  days: z.number().int().min(1).max(365).optional(),
  refresh: booleanish.optional(),
});

/** POST /api/frontpage { source, section, page?, limit?, days?, refresh? } */
export const POST = route(async (req, ctx) => {
  const body = await readJson(req, bodySchema);
  const provider = getRegistry().get(body.source);
  if (!provider?.frontpage) {
    throw new DawghwaError(
      provider ? "UNSUPPORTED_CAPABILITY" : "SOURCE_NOT_FOUND",
      `Source "${body.source}" does not have frontpage support. Available sources: ${frontpageProviders().map((p) => p.id).join(", ") || "none"}`,
    );
  }
  const sections = provider.frontpage.getAvailableSections();
  const config = sections.find((s) => s.id === body.section);
  if (!config) {
    throw new DawghwaError(
      "VALIDATION_ERROR",
      `Unknown section "${body.section}". Available sections: ${sections.map((s) => s.id).join(", ")}`,
    );
  }
  const days = body.days ?? 7;
  if (config.supportsTimeFilter && config.availableTimeFilters && !config.availableTimeFilters.includes(days)) {
    throw new DawghwaError(
      "VALIDATION_ERROR",
      `days must be one of ${config.availableTimeFilters.join(", ")} for section "${config.id}"`,
    );
  }
  if (!config.supportsPagination && (body.page ?? 1) > 1) {
    throw new DawghwaError("VALIDATION_ERROR", `Section "${config.id}" does not support pagination`);
  }
  const r = await getFrontpageSection(
    provider,
    config.id,
    { page: body.page ?? 1, limit: body.limit ?? 30, days },
    { forceRefresh: body.refresh },
  );
  return json(
    {
      source: provider.frontpage.getSourceId(),
      sourceName: provider.frontpage.getSourceName(),
      section: r.section,
      fetchedAt: Date.now() - r.age * 1000,
      meta: { cache: r.cache, age: r.age },
    },
    ctx,
  );
});
