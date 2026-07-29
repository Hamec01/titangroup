-- Titanor Time — third migration: UserSession
-- Generated from prisma/schema.prisma (offline: prisma migrate diff --from-schema-datamodel
-- <pre-change schema snapshot> --to-schema-datamodel prisma/schema.prisma --script). Additive only —
-- the first initial migration (20260728012114_init_titanor_time_foundation) and the second migration
-- (20260728161708_add_role_permission_user_role) are not modified.
--
-- Adds the UserSession entity described in docs/titanor-time/03_DATA_MODEL_ERD.md §4.1 (already fully
-- specified there — id, userId FK, tokenHash (SHA-256 of an opaque token >= 32 bytes, never the raw
-- token itself), authLevel, mfaVerifiedAt, expiresAt, lastSeenAt, ipAddress, userAgent, revokedAt).
-- This is the first sub-step of ЭТАП 5 T5.5 (Login) per docs/PROJECT_ROADMAP.md — schema only, no
-- login endpoint/session-issuing code in this migration. Sessions are never hard-deleted; revocation
-- is the `revokedAt` timestamp, consistent with the project's soft-delete-over-deactivation invariant
-- (03_DATA_MODEL_ERD.md §3).

-- CreateEnum
CREATE TYPE "AuthLevel" AS ENUM ('PASSWORD', 'MFA_VERIFIED');

-- CreateTable
CREATE TABLE "UserSession" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "authLevel" "AuthLevel" NOT NULL DEFAULT 'PASSWORD',
    "mfaVerifiedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" VARCHAR(45),
    "userAgent" TEXT,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");

-- CreateIndex
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");

-- CreateIndex
CREATE INDEX "UserSession_expiresAt_idx" ON "UserSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
