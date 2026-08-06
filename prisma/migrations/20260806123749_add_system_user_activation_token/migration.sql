-- CreateTable
CREATE TABLE "UserActivationToken" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "status" "ActivationTokenStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserActivationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserActivationToken_tokenHash_key" ON "UserActivationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "UserActivationToken_userId_status_idx" ON "UserActivationToken"("userId", "status");

-- CreateIndex
CREATE INDEX "UserActivationToken_expiresAt_idx" ON "UserActivationToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "UserActivationToken" ADD CONSTRAINT "UserActivationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserActivationToken" ADD CONSTRAINT "UserActivationToken_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Section B — raw SQL not expressible in Prisma schema syntax
-- (owner-confirmed system user activation schema checkpoint)
-- ============================================================================

-- ck_user_activation_token_expiry_after_creation
ALTER TABLE "UserActivationToken"
  ADD CONSTRAINT "ck_user_activation_token_expiry_after_creation"
  CHECK ("expiresAt" > "createdAt");

-- ck_user_activation_token_status_shape
-- USED requires usedAt set, and set within [createdAt, expiresAt]; every other status requires
-- usedAt to stay NULL. Same shape as ck_activation_token_status_shape (ActivationToken).
ALTER TABLE "UserActivationToken"
  ADD CONSTRAINT "ck_user_activation_token_status_shape"
  CHECK (
    ("status" = 'USED' AND "usedAt" IS NOT NULL AND "usedAt" >= "createdAt" AND "usedAt" <= "expiresAt")
    OR ("status" <> 'USED' AND "usedAt" IS NULL)
  );

-- ex_user_activation_token_pending_unique
-- At most one live (PENDING) code per userId at a time. Prisma's @@unique cannot express a
-- partial index — same pattern as ex_activation_token_pending_unique (ActivationToken).
CREATE UNIQUE INDEX "ex_user_activation_token_pending_unique" ON "UserActivationToken" ("userId") WHERE "status" = 'PENDING';
