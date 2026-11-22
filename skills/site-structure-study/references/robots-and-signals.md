# robots.txt and content signals

## robots.txt (RFC 9309)
- Fetch `https://<host>/robots.txt` once per host per study, and cache it for the run.
- 2xx: parse it. 4xx: no restrictions. 5xx or unreachable: treat as complete disallow and stop.
- Groups: use the group whose `User-agent` matches your product token. If none matches, use `*`. Named-bot groups (for example `GPTBot`, `CCBot`) don't apply to you, but write them down because they show the operator's intent.
- Matching: longest path match wins, and `Allow` wins ties. `*` matches any run of characters, and `$` anchors the end. An empty `Disallow:` allows everything.
- `Crawl-delay` isn't in RFC 9309, but if one is present and it's longer than 1 s, use it.
- Record the robots.txt in full (quoted) with fetch time, status, and response headers.

## Content signals
Some sites (for example Cloudflare-managed robots.txt) add:
```
Content-Signal: search=yes,ai-train=no,use=reference
```
- `search`: building a search index with links and short excerpts.
- `ai-input`: feeding content into AI models at answer time (RAG, grounding).
- `ai-train`: training or fine-tuning models.
- `use`: how AI systems may consume content (`immediate`, `reference`, `full`).
- A missing signal neither grants nor restricts. `no` is an express reservation of rights (sites often cite EU Directive 2019/790, Art. 4).

How this applies here: never train on fetched content. If `ai-input=no`, don't pass fetched content to an LLM. `use=reference` means referencing with links, not reproducing content in full.

## Other signals to record
- `X-Robots-Tag` response header and `<meta name="robots">` (for example `noindex, nofollow`).
- `/.well-known/` policy files, but only if they're linked or commonly published (`security.txt`). Don't enumerate.
