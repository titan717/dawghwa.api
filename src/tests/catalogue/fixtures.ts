import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonResponse } from "../helpers";

const DIR = join(__dirname, "..", "fixtures");

/** Body of a captured upstream response (see src/tests/fixtures/anilist/README.md). */
export function captured<T = unknown>(name: string): T {
  const file = JSON.parse(readFileSync(join(DIR, name), "utf8")) as { body?: unknown };
  return (name.startsWith("anilist/") ? file.body : file) as T;
}

export const MD_SOLO = "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0";
/** "Love that Does Not Begin": MangaDex entry with no tracker links. */
export const MD_UNLINKED = "135aa183-2e3d-459f-a896-1ae6fc2bb06b";

/** Answer AniList by which captured query the request carries. */
export function anilistReply(init: RequestInit, pick: (query: string, variables: Record<string, unknown>) => string): Response {
  const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
  return jsonResponse(captured(`anilist/${pick(query, variables)}.json`));
}
