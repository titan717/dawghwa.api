# syntax=docker/dockerfile:1
# Dawghwa API - production image (Next.js standalone output, non-root).
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S dawghwa && adduser -S dawghwa -G dawghwa
COPY --from=build --chown=dawghwa:dawghwa /app/.next/standalone ./
COPY --from=build --chown=dawghwa:dawghwa /app/.next/static ./.next/static
USER dawghwa
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/sources > /dev/null || exit 1
CMD ["node", "server.js"]
