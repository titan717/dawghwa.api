import { json, route } from "@/lib/api/handler";
import { describeMetadataProviders } from "@/lib/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/catalog/providers - enabled metadata providers, capabilities and attribution. */
export const GET = route(async (_req, ctx) => json({ providers: describeMetadataProviders() }, ctx));
