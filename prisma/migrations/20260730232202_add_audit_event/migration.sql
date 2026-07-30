-- Titanor Time — sixth migration: add AuditEvent
--
-- Design per docs/titanor-time/03_DATA_MODEL_ERD.md §4.8, refined and explicitly approved by the
-- owner (2026-07-31) with three amendments to the agent's initial proposal:
--   1. actorUserId is nullable (not NOT NULL) — LOGIN_FAILED for an unrecognized identifier has no
--      resolvable User, and no substitute ("system" account etc.) may be used, as that would falsify
--      the audit record.
--   2. entityId is nullable — e.g. entityType='AUTHENTICATION', entityId=NULL for a failed login with
--      no single domain entity.
--   3. requestId stays NOT NULL — a separate future task will add per-request X-Request-Id generation
--      on both success and error responses (not just jsonError() as today) before any code writes to
--      this table.
-- Indexes are the owner's exact spec, sized for the audit-log read pattern (filter by actor/type/
-- entity, paginate by createdAt) — (createdAt DESC, id DESC) specifically for stable cursor pagination
-- across rows sharing the same createdAt.
--
-- Scope boundary (owner's explicit sequencing): this migration only. Request-context/X-Request-Id
-- propagation and a shared createAuditEvent() helper are separate, later tasks — see
-- IMPLEMENTATION_STATUS.md §11. No route/service writes to this table yet.

-- ============================================================================
-- Section A — structural SQL matching prisma/schema.prisma (tables, indexes, foreign keys)
-- ============================================================================

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actorUserId" UUID,
    "eventType" VARCHAR(64) NOT NULL,
    "entityType" VARCHAR(64) NOT NULL,
    "entityId" UUID,
    "beforeValue" JSONB,
    "afterValue" JSONB,
    "reason" TEXT,
    "requestId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_eventType_createdAt_idx" ON "AuditEvent"("eventType", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_createdAt_idx" ON "AuditEvent"("entityType", "entityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_id_idx" ON "AuditEvent"("createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Section B — raw SQL not expressible in Prisma schema syntax
-- ============================================================================

-- trg_audit_event_immutable
-- "Immutable, append-only" (03_DATA_MODEL_ERD.md §4.8) enforced physically, not just by the absence
-- of a write API (02_ROLE_PERMISSION_MATRIX.md §2.10: audit.read is the only permission touching this
-- table — no permission or endpoint ever grants UPDATE/DELETE). Unconditional — every UPDATE and
-- DELETE is rejected, no exception for any actor including SUPER_ADMIN. Same P0001/frozen-identifier
-- convention as every other business-rule trigger in this schema (see the first migration).
CREATE OR REPLACE FUNCTION fn_audit_event_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_EVENT_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_event_immutable
  BEFORE UPDATE OR DELETE
  ON "AuditEvent"
  FOR EACH ROW
  EXECUTE FUNCTION fn_audit_event_immutable();
