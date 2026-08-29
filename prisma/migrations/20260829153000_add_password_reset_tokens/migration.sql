-- Account recovery: hashed, short-lived, one-time password reset tokens.
-- The raw token appears only in the recovery URL sent by SMTP and is never
-- persisted or written to AuditEvent.
CREATE TABLE "PasswordResetToken" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_createdAt_idx" ON "PasswordResetToken"("userId", "createdAt" DESC);
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

ALTER TABLE "PasswordResetToken"
  ADD CONSTRAINT "PasswordResetToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PasswordResetToken"
  ADD CONSTRAINT "ck_password_reset_token_expiry_after_creation"
  CHECK ("expiresAt" > "createdAt");

ALTER TABLE "PasswordResetToken"
  ADD CONSTRAINT "ck_password_reset_token_terminal_state"
  CHECK (NOT ("usedAt" IS NOT NULL AND "revokedAt" IS NOT NULL));
