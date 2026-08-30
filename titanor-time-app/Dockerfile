# Build context is the REPOSITORY ROOT (not this directory) so this build can
# reach the single shared source of truth, ../prisma/schema.prisma, without
# copying or duplicating it into this app. See compose.titanor-time.yaml.
#
# node:22-bookworm-slim (glibc/Debian), not alpine (musl) — Prisma's query
# engine binaries are built for glibc and do not run correctly on musl libc.
#
# R06-B (Docker/runtime optimization): the runner no longer carries the full
# ~880 MB dev node_modules. The web server runs from Next.js standalone output
# (its own traced node_modules); the scheduler + operational CLIs run from
# precompiled CJS bundles (.runtime/, no tsx/npx/network); `prisma migrate
# deploy` runs from an explicit minimal CLI closure (.prisma-tools/). One
# image, one digest — web and scheduler differ only by command.

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

# Reproducible install: the lockfile is mandatory (no `*` glob) and `npm ci`
# fails if package.json and package-lock.json disagree.
COPY titanor-time-app/package.json titanor-time-app/package-lock.json ./
RUN npm ci


# ---------------------------------------------------------------------------
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

# Precompile the long-lived scheduler, its healthcheck, the one-shot tick, and
# the emergency operator CLIs (bootstrap-super-admin / reset-password) to
# self-contained CJS. Runtime then runs `node .runtime/<name>.cjs` — no tsx, no
# TypeScript, no `npx`, no npm download. esbuild is present here (via tsx).
RUN node scripts/build-runtime-scripts.mjs

# Assemble the minimal `prisma` CLI closure (schema-engine + CLI) for
# `prisma migrate deploy` / `migrate status` / `migrate resolve`. Kept apart
# from the app's query path (that uses @prisma/client from standalone).
RUN node scripts/assemble-prisma-tools.mjs


# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# --- web runtime: Next.js standalone (self-contained; its own traced node_modules,
#     including @prisma/client + the native query engine forced in via
#     next.config.mjs `outputFileTracingIncludes`) ---
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# --- fonts/brand assets loaded by absolute path at request time
#     (lib/reporting/*-pdf.ts -> path.join(process.cwd(), 'assets/...')); Next's
#     output-file tracing never sees these, same gap as the Prisma engine ---
COPY --from=builder --chown=node:node /app/assets ./assets

# --- scheduler + operational CLIs, precompiled (node <file>.cjs) ---
COPY --from=builder --chown=node:node /app/.runtime ./.runtime

# --- prisma migrate deploy tooling + the migrations themselves (NOT loaded by
#     the running app; invoked out-of-band by the deploy script / an operator) ---
COPY --from=builder --chown=node:node /app/.prisma-tools ./.prisma-tools
COPY --from=builder --chown=node:node /app/prisma ./prisma

# --- uploads: compose / pilot bind a host directory here; the real container
#     UID/GID (node, 1000:1000) must own the mount point ---
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

# --- OCI provenance (populated by the build: --build-arg GIT_SHA=... etc.) ---
ARG GIT_SHA=unknown
ARG GIT_REF=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.title="titanor-time-app" \
      org.opencontainers.image.description="Titanor Time — web server + attendance scheduler (one image, two commands)" \
      org.opencontainers.image.source="https://github.com/Hamec01/titangroup" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.ref.name="${GIT_REF}" \
      org.opencontainers.image.created="${BUILD_TIME}"
ENV GIT_SHA=${GIT_SHA}

USER node

EXPOSE 3000

# Web server. The scheduler overrides this with
#   node .runtime/attendance-auto-submit-scheduler.cjs
CMD ["node", "server.js"]
