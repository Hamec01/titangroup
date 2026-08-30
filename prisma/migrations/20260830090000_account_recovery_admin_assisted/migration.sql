-- Titanor Time — R03.1: admin-assisted account recovery (no SMTP).
--
-- The existing PasswordResetToken model already carries userId / tokenHash (HMAC only) /
-- expiresAt / usedAt / revokedAt and the "one active token per user" rule. R03 turns it from a
-- self-service email flow into an admin-issued one-time short code:
--   * issuedByUserId  — the ADMIN/SUPER_ADMIN who pressed "Restore access" (NULL for any legacy
--                       self-service row; every new row has it).
--   * attemptCount    — failed redeem attempts against THIS code; the code self-revokes once it
--                       crosses the per-code limit (TZ §7.2 "Ограничивается число попыток ввода").
--
-- Plus the permission that gates issuing a code.

ALTER TABLE "PasswordResetToken" ADD COLUMN "issuedByUserId" uuid;
ALTER TABLE "PasswordResetToken" ADD COLUMN "attemptCount" integer NOT NULL DEFAULT 0;

ALTER TABLE "PasswordResetToken"
  ADD CONSTRAINT "PasswordResetToken_issuedByUserId_fkey"
  FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "PasswordResetToken_issuedByUserId_idx" ON "PasswordResetToken"("issuedByUserId");

-- user.recovery.generate — issue a one-time recovery code for an ACTIVE/OFFBOARDING account.
-- Distinct from user.activation.generate (PENDING_ACTIVATION first login) per TZ §7.2.
INSERT INTO "Permission" ("code", "description") VALUES
  ('user.recovery.generate', 'Issue a one-time account-recovery code for an ACTIVE or OFFBOARDING user/worker - docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'user.recovery.generate'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
