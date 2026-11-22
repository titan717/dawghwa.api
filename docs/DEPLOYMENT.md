# Deploying Dawghwa API

Dawghwa API is a Next.js 14 app (App Router, Node.js runtime for every API route). It needs Node.js 20+. Nothing is required beyond the app itself; Redis is optional.

## Choosing a host

| Option | Good for | Notes |
| --- | --- | --- |
| **Vercel** | Zero-ops public deployment | `vercel.json` raises `maxDuration` to 60 s for search/health/chapters (needs a plan that allows 60 s). Add Upstash Redis so the cache is shared across instances. |
| **Docker** (any VM, Fly.io, Railway, Render, a home server) | Long-lived process with a warm in-memory cache | Uses the standalone output. A single instance gets the full benefit of the in-memory cache, request coalescing and circuit breakers. |
| **Bare Node** | Self-hosting without containers | `npm ci && npm run build && npm start` |

Sources behind Cloudflare and similar protection often block datacenter IP ranges, including serverless platforms. A residential or less-flagged network usually reaches more sources. Run `npm run health:report` on the target host to see what is reachable from there.

## Vercel

1. Import `titan717/dawghwa.api` in Vercel. The framework (Next.js) is detected automatically.
2. Optional: add the Upstash Redis integration, or set `REDIS_REST_URL` and `REDIS_REST_TOKEN`.
3. Optional: set `CORS_ORIGINS` to your client origins, and tune rate limits (see below).
4. Deploy. `TRUST_PROXY=true` (the default) is correct on Vercel because the platform sets `X-Forwarded-For`.

Serverless instances do not share memory, so without Redis every cold instance starts with an empty cache, and the inbound rate limiter works per instance.

## Docker

```bash
docker build -t dawghwa-api .
docker run -d --name dawghwa -p 3000:3000 \
  -e TRUST_PROXY=false \
  --restart unless-stopped dawghwa-api
curl -s localhost:3000/api | jq
```

- The image builds with `NEXT_OUTPUT=standalone`, runs as a non-root user, and has a `HEALTHCHECK` on `/api/sources`.
- Behind a reverse proxy (Caddy, nginx, Traefik) that sets `X-Forwarded-For`, keep `TRUST_PROXY=true`. If clients connect directly, set `TRUST_PROXY=false` so they cannot spoof their identity for rate limiting.
- To share a cache between replicas, point `REDIS_REST_URL` at Upstash, or at a self-hosted Redis via the open-source [serverless-redis-http](https://github.com/hiett/serverless-redis-http) bridge.

Example `docker-compose.yml` with a self-hosted Redis:

```yaml
services:
  api:
    build: .
    ports: ["3000:3000"]
    environment:
      TRUST_PROXY: "false"
      REDIS_REST_URL: http://redis-http:80
      REDIS_REST_TOKEN: change-me
    restart: unless-stopped
  redis:
    image: redis:7-alpine
    restart: unless-stopped
  redis-http:
    image: hiett/serverless-redis-http:latest
    environment:
      SRH_MODE: env
      SRH_TOKEN: change-me
      SRH_CONNECTION_STRING: redis://redis:6379
    restart: unless-stopped
```

Note: the SSRF guard blocks only outbound requests to *sources*. The Redis client is configured by the operator and may use a private address.

## Bare Node / self-hosting

```bash
git clone https://github.com/titan717/dawghwa.api.git && cd dawghwa.api
npm ci
npm run build
PORT=3000 npm start
```

Run it under a process manager (systemd, pm2) behind a TLS-terminating reverse proxy. Minimal systemd unit:

```ini
[Unit]
Description=Dawghwa API
After=network.target

[Service]
WorkingDirectory=/opt/dawghwa.api
Environment=NODE_ENV=production PORT=3000 TRUST_PROXY=true
ExecStart=/usr/bin/npm start
Restart=always
User=dawghwa

[Install]
WantedBy=multi-user.target
```

## Environment variables

Every variable is optional. [`.env.example`](../.env.example) lists all of them with their defaults. Grouped summary:

| Group | Variables |
| --- | --- |
| Outbound HTTP | `UPSTREAM_USER_AGENT`, `UPSTREAM_TIMEOUT_MS`, `UPSTREAM_RETRIES`, `UPSTREAM_RETRY_BASE_MS`, `UPSTREAM_RETRY_MAX_MS`, `UPSTREAM_MAX_RESPONSE_BYTES`, `CONDITIONAL_CACHE_ENTRIES`, `CONDITIONAL_CACHE_MAX_BYTES` |
| Source isolation | `SOURCE_OPERATION_TIMEOUT_MS`, `SOURCE_DEFAULT_RPS`, `SOURCE_DEFAULT_BURST`, `SOURCE_DEFAULT_MAX_CONCURRENT`, `BREAKER_FAILURE_THRESHOLD`, `BREAKER_COOLDOWN_MS`, `DISABLED_SOURCES`, `SOURCE_PRIORITY`, `EXPERIMENTAL_PROVIDERS` |
| Search / health | `SEARCH_CONCURRENCY`, `SEARCH_SOURCE_TIMEOUT_MS`, `SEARCH_OVERALL_TIMEOUT_MS`, `HEALTH_CONCURRENCY`, `HEALTH_SOURCE_TIMEOUT_MS`, `HEALTH_OVERALL_TIMEOUT_MS` |
| Cache | `CACHE_ENABLED`, `CACHE_MEMORY_MAX_ENTRIES`, `CACHE_MEMORY_MAX_BYTES`, `REDIS_REST_URL`/`UPSTASH_REDIS_REST_URL`, `REDIS_REST_TOKEN`/`UPSTASH_REDIS_REST_TOKEN`, `REDIS_PREFIX`, `CACHE_{SEARCH,CHAPTERS,METADATA,FRONTPAGE,HEALTH}_{TTL,SWR}`, `CACHE_PAGES_TTL` |
| Metadata / catalogue | `METADATA_PROVIDERS`, `METADATA_DEFAULT_PROVIDER`, `METADATA_TIMEOUT_MS`, `ANILIST_REQUESTS_PER_MINUTE`, `CACHE_CATALOG_TTL`, `CACHE_CATALOG_SWR` |
| Source availability | `AVAILABILITY_MIN_SCORE`, `AVAILABILITY_MAX_ALT_QUERIES` |
| API protection | `API_MAX_BODY_BYTES`, `RATE_LIMIT_ENABLED`, `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_EXPENSIVE_PER_MINUTE`, `TRUST_PROXY`, `CORS_ORIGINS`, `EXPOSE_ERROR_DETAILS` |
| Misc | `DAWGHWA_VERSION`, `PORT`, `NEXT_OUTPUT=standalone` (build-time; set by the Dockerfile) |

Never commit `.env` files. `.gitignore` excludes them except `.env.example`.

## Operating it

- **Monitoring**: `GET /api/health` gives a summary, and `GET /api/sources?verbose=true` shows circuit-breaker state and per-source success/failure counters. Errors with status 500 and above are logged as one JSON line each, with `requestId`, so client reports can be matched to logs.
- **Turning off a broken source** without a deploy: set `DISABLED_SOURCES=id1,id2` and restart. Requests to it then return `SOURCE_UNAVAILABLE`.
- **Experimental sources** (listed in `EXPERIMENTAL_SOURCE_IDS` in `src/lib/providers/status.ts`, currently `comix`) are not registered at all unless named in `EXPERIMENTAL_PROVIDERS` (empty by default). Requests to them return `SOURCE_NOT_FOUND`. Do not set this in production without a recorded terms review; see `skills/site-structure-study/SKILL.md`.
- **Status report**: the `Source Health Report` GitHub workflow regenerates `docs/SOURCE_STATUS.md` weekly. Results come from GitHub's datacenter network and will show more anti-bot blocks than a residential host.
- **Upgrading from upstream code**: the `upstream` git remote points at GooglyBlox/comick-source-api. New upstream adapters can be cherry-picked; then run `npm run manifest`, `npm run docs:sources` and `npm test`.
