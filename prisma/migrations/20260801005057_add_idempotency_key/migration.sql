-- Titanor Time — eighth migration: add IdempotencyKey
--
-- Design per docs/titanor-time/03_DATA_MODEL_ERD.md §4.1, shown to and approved by the owner
-- (2026-08-01) as-is, no amendments this time (unlike AuditEvent). One row per
-- (actorUserId, httpMethod, routeTemplate, idempotencyKey) — path parameters are deliberately
-- excluded from the unique key (they only feed requestHash) so a client-side bug (reusing the same
-- Idempotency-Key for a different target resource) surfaces as 409 IDEMPOTENCY_KEY_REUSED instead of
-- silently creating an unrelated cached entry. encryptedResponseBody is populated only once status
-- moves PROCESSING -> COMPLETED; the AES-256-GCM key lives outside the DB (IDEMPOTENCY_ENCRYPTION_KEY
-- env var), never in this table.
--
-- Scope boundary: schema only, no consumer yet — same pattern as hasPermission()/AuditEvent, built
-- ahead of its first caller. lib/idempotency.ts and the first endpoint using it are separate,
-- later tasks — see IMPLEMENTATION_STATUS.md §11.

-- CreateEnum
CREATE TYPE "IdempotencyKeyStatus" AS ENUM ('PROCESSING', 'COMPLETED');

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actorUserId" UUID NOT NULL,
    "httpMethod" VARCHAR(8) NOT NULL,
    "routeTemplate" VARCHAR(255) NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "status" "IdempotencyKeyStatus" NOT NULL,
    "encryptedResponseBody" BYTEA,
    "statusCode" INTEGER,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_actorUserId_httpMethod_routeTemplate_idempot_key" ON "IdempotencyKey"("actorUserId", "httpMethod", "routeTemplate", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
