-- CreateEnum
CREATE TYPE "ActivationTokenStatus" AS ENUM ('PENDING', 'USED', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "ActivationToken" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employeeId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "status" "ActivationTokenStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActivationToken_tokenHash_key" ON "ActivationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ActivationToken_employeeId_status_idx" ON "ActivationToken"("employeeId", "status");

-- CreateIndex
CREATE INDEX "ActivationToken_expiresAt_idx" ON "ActivationToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "ActivationToken" ADD CONSTRAINT "ActivationToken_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivationToken" ADD CONSTRAINT "ActivationToken_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Section B — raw SQL not expressible in Prisma schema syntax
-- (owner-confirmed activation schema checkpoint)
-- ============================================================================

-- ck_activation_token_status_shape
-- USED requires usedAt set, and set within [createdAt, expiresAt]; every other status requires
-- usedAt to stay NULL. Mirrors ck_payroll_period_status_metadata_shape/ck_timesheet_review_scope_shape.
ALTER TABLE "ActivationToken"
  ADD CONSTRAINT "ck_activation_token_status_shape"
  CHECK (
    ("status" = 'USED' AND "usedAt" IS NOT NULL AND "usedAt" >= "createdAt" AND "usedAt" <= "expiresAt")
    OR ("status" <> 'USED' AND "usedAt" IS NULL)
  );

-- ck_activation_token_expiry_after_creation
ALTER TABLE "ActivationToken"
  ADD CONSTRAINT "ck_activation_token_expiry_after_creation"
  CHECK ("expiresAt" > "createdAt");

-- ex_activation_token_pending_unique
-- At most one live (PENDING) code per employee at a time. Prisma's @@unique cannot express a
-- partial index — same pattern as ex_timesheet_review_scope_site_unique. The issuance
-- transaction (lib/activation.ts) always resolves any existing PENDING row (EXPIRED if past
-- expiresAt, otherwise REVOKED) before inserting a new one, under a row lock on Employee — this
-- index is the DB-level backstop against two concurrent issuance requests both passing that
-- check before either writes.
CREATE UNIQUE INDEX "ex_activation_token_pending_unique" ON "ActivationToken" ("employeeId") WHERE "status" = 'PENDING';
