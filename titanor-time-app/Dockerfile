# Build context is the REPOSITORY ROOT (not this directory) so this build can
# reach the single shared source of truth, ../prisma/schema.prisma, without
# copying or duplicating it into this app. See compose.titanor-time.yaml.
#
# node:22-bookworm-slim (glibc/Debian), not alpine (musl) — Prisma's query
# engine binaries are built for glibc and do not run correctly on musl libc.

FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

COPY titanor-time-app/package.json titanor-time-app/package-lock.json* ./
RUN npm install


FROM node:22-bookworm-slim AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

# node:*-slim omits the openssl CLI; Prisma's engine works without it (linked
# against libssl directly) but its own version-detection step warns loudly
# without it. Installing it removes that ambiguity.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies /app/node_modules ./node_modules
COPY titanor-time-app/ ./
COPY prisma ./prisma

RUN npx prisma generate --schema prisma/schema.prisma

RUN npm run build


FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node

EXPOSE 3000

CMD ["node", "server.js"]
