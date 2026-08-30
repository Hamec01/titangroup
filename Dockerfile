FROM node:22-alpine AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci


FROM node:22-alpine AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

RUN npm run build


FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# --- OCI provenance (populated by the build: --build-arg GIT_SHA=... etc.) ---
# The R07-B deploy script (ops/site/deploy-site-r07b.sh) verifies image
# org.opencontainers.image.revision == the SHA it was told to build.
ARG GIT_SHA=unknown
ARG GIT_REF=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.title="titanorgroup-web" \
      org.opencontainers.image.description="titanorgroup.fi — public marketing site (Next.js standalone)" \
      org.opencontainers.image.source="https://github.com/Hamec01/titangroup" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.ref.name="${GIT_REF}" \
      org.opencontainers.image.created="${BUILD_TIME}"
ENV GIT_SHA=${GIT_SHA}

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/data ./data

RUN mkdir -p /app/public/uploads && chown -R node:node /app/public/uploads

USER node

EXPOSE 3000

CMD ["node", "server.js"]
