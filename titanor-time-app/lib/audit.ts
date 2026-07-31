import { Prisma } from '@prisma/client';

export interface AuditEventInput {
  actorUserId: string | null;
  eventType: string;
  entityType: string;
  entityId: string | null;
  requestId: string;
  beforeValue?: Prisma.InputJsonValue | null;
  afterValue?: Prisma.InputJsonValue | null;
  reason?: string | null;
}

/**
 * Writes one AuditEvent row (docs/titanor-time/03_DATA_MODEL_ERD.md §4.8).
 * `tx` must be the same transaction client as the business action being
 * recorded, not the top-level `prisma` singleton — §3's cross-cutting rule
 * ("Действие + AuditEvent — одна транзакция") means the audit row commits or
 * rolls back atomically with whatever it's documenting; a caller opening a
 * second, separate transaction here would break that guarantee.
 * beforeValue/afterValue must never contain GPS coordinates, password
 * hashes, or session tokens (§4.8) — this function does not scrub them,
 * that's the caller's responsibility.
 */
export async function createAuditEvent(
  tx: Prisma.TransactionClient,
  input: AuditEventInput
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      actorUserId: input.actorUserId,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      requestId: input.requestId,
      // Plain `null` isn't directly assignable to a nullable Json field in
      // Prisma's generated input type — it needs the Prisma.DbNull sentinel
      // to mean "set this column to SQL NULL" (Prisma.JsonNull would instead
      // store the JSON literal `null`, a different, unwanted value here).
      beforeValue: input.beforeValue === null ? Prisma.DbNull : input.beforeValue,
      afterValue: input.afterValue === null ? Prisma.DbNull : input.afterValue,
      reason: input.reason
    }
  });
}
