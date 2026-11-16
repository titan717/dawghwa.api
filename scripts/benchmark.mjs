// Live HTTP benchmark against a running instance.
// Usage: node scripts/benchmark.mjs http://localhost:3000 label > result.json
const BASE = process.argv[2] || "http://localhost:3000";
const LABEL = process.argv[3] || "run";
const now = () => performance.now();
async function timed(name, fn) {
  const t = now();
  let ok = true, info = "";
  try { info = await fn(); } catch (e) { ok = false; info = String(e.message || e); }
  return { name, ms: Math.round(now() - t), ok, info };
}
const post = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const out = [];
out.push(await timed("GET /api/sources", async () => { const r = await fetch(BASE + "/api/sources"); const j = await r.json(); return `${r.status} n=${(j.sources||j.data?.sources||[]).length}`; }));
for (let i = 0; i < 3; i++) out.push(await timed(`search mangadex #${i + 1}`, async () => { const r = await post("/api/search", { query: "solo leveling", source: "mangadex" }); const j = await r.json(); return `${r.status} n=${(j.results||j.data?.results||[]).length}`; }));
const url = "https://mangadex.org/title/37f5cce0-8070-4ada-96e5-fa24b1bd4ff9";
for (let i = 0; i < 3; i++) out.push(await timed(`chapters mangadex #${i + 1}`, async () => { const r = await post("/api/chapters", { url, source: "mangadex" }); const j = await r.json(); return `${r.status} n=${j.totalChapters ?? j.data?.totalChapters}`; }));
out.push(await timed("10x concurrent identical chapters (cold key)", async () => {
  const u = "https://mangadex.org/title/68112dc1-2b80-4f20-beb8-2f2a8716a430";
  const rs = await Promise.all(Array.from({ length: 10 }, () => post("/api/chapters", { url: u, source: "mangadex" }).then(r => r.status)));
  return rs.join(",");
}));
for (let i = 0; i < 2; i++) out.push(await timed(`search ALL sources #${i + 1}`, async () => {
  const t0 = now(); const r = await post("/api/search", { query: "one piece", source: "all" });
  const reader = r.body.getReader(); let first = 0, text = ""; const dec = new TextDecoder();
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (!first) first = now() - t0; text += dec.decode(value, { stream: true }); }
  const lines = text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  const sum = lines.find(l => l.done === true || l.type === "summary") || {};
  return `ttfb=${Math.round(first)}ms sources=${lines.length - 1} failed=${sum.failedSources}`;
}));
out.push(await timed("frontpage comix trending", async () => { const r = await post("/api/frontpage", { source: "comix", section: "trending" }); return `${r.status}`; }));
console.log(JSON.stringify({ label: LABEL, base: BASE, at: new Date().toISOString(), results: out }, null, 2));
