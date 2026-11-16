// Usage: node scripts/benchmark-cold.mjs <baseUrlA> <baseUrlB> > cold.json
// Cold-cache comparison: every request uses a key neither server has seen, and
// the order alternates so neither server benefits from upstream warm-up.
const A = process.argv[2], B = process.argv[3];
const post = (base, p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ids = (await (await fetch("https://api.mangadex.org/manga?limit=40&order[followedCount]=desc&availableTranslatedLanguage[]=en", { headers: { "user-agent": "dawghwa-bench" } })).json()).data.map((m) => m.id);
const words = ["dragon","school","sword","love","demon","hero","magic","tower","king","ghost","star","moon","blood","ice","fire","wolf","night","sky","sea","dream"];
const res = { [A]: { search: [], chapters: [] }, [B]: { search: [], chapters: [] } };
async function time(fn) { const t = performance.now(); const r = await fn(); await r.text(); return { ms: Math.round(performance.now() - t), status: r.status }; }
for (let i = 0; i < 10; i++) {
  const order = i % 2 ? [A, B] : [B, A];
  for (const [k, base] of order.entries()) {
    res[base].search.push(await time(() => post(base, "/api/search", { query: `${words[i * 2 + k]} ${i}`, source: "mangadex" })));
    res[base].chapters.push(await time(() => post(base, "/api/chapters", { url: `https://mangadex.org/title/${ids[i * 2 + k]}`, source: "mangadex" })));
  }
}
const med = (a) => { const s = a.map((x) => x.ms).sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const summary = Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { searchMedianMs: med(v.search), chaptersMedianMs: med(v.chapters), search: v.search, chapters: v.chapters }]));
console.log(JSON.stringify({ at: new Date().toISOString(), note: "MangaDex, cold keys, alternating order, n=10 each", summary }, null, 2));
