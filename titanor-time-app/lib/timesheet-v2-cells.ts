// Табель v2 → "Редактировать табель": what an admin types into the customer month grid. Values are
// stored as TimesheetV2CellOverride rows and replace the computed cell in Табель v2 and its Excel
// export only (see lib/reporting/monthly-matrix.ts, owner rule 2). Owner's brief: "легко и просто" —
// no approval flow, no period locks; every save is audited.

import { createAuditEvent } from '@/lib/audit';
import { prisma } from '@/lib/prisma';
import { monthRange } from '@/lib/reporting/monthly-matrix';
import { formatMatrixHours, parseCellInput } from '@/lib/timesheet-v2-cell-input';

export { cellInputText, parseCellInput, type ParsedCell } from '@/lib/timesheet-v2-cell-input';

export const MAX_CELL_CHANGES = 3000;

export class TimesheetV2CellError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

export interface CellChange { employeeId: string; date: string; value: string }

/**
 * Saves typed cells for one customer and month in one transaction. Unchanged values are skipped;
 * returns how many cells were written. Validation happens before anything is written.
 */
export async function saveTimesheetV2Cells(input: { siteId: string; workAreaId: string | null; month: string; changes: CellChange[]; actorUserId: string; requestId: string }): Promise<{ saved: number }> {
  const { startDate, endDate } = monthRange(input.month);
  if (input.changes.length > MAX_CELL_CHANGES) throw new TimesheetV2CellError('TOO_MANY_CHANGES');
  const parsed = input.changes.map((change) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(change.date) || change.date < startDate || change.date > endDate) throw new TimesheetV2CellError('DATE_OUTSIDE_MONTH');
    const value = parseCellInput(change.value);
    if (!value) throw new TimesheetV2CellError('INVALID_VALUE');
    return { ...change, ...value };
  });
  const keys = new Set(parsed.map((c) => `${c.employeeId}|${c.date}`));
  if (keys.size !== parsed.length) throw new TimesheetV2CellError('DUPLICATE_CELL');
  const employeeIds = [...new Set(parsed.map((c) => c.employeeId))];
  const known = await prisma.employee.count({ where: { id: { in: employeeIds } } });
  if (known !== employeeIds.length) throw new TimesheetV2CellError('EMPLOYEE_NOT_FOUND', 404);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.timesheetV2CellOverride.findMany({
      where: { siteId: input.siteId, workAreaId: input.workAreaId, employeeId: { in: employeeIds }, date: { gte: new Date(`${startDate}T00:00:00.000Z`), lte: new Date(`${endDate}T00:00:00.000Z`) } }
    });
    const byKey = new Map(existing.map((row) => [`${row.employeeId}|${row.date.toISOString().slice(0, 10)}`, row]));
    const audit: Array<{ employeeId: string; date: string; before: string | null; after: string }> = [];
    for (const change of parsed) {
      const current = byKey.get(`${change.employeeId}|${change.date}`);
      const after = change.off ? 'OFF' : formatMatrixHours(change.minutes) || '0';
      if (current) {
        if (current.minutes === change.minutes && current.off === change.off) continue;
        await tx.timesheetV2CellOverride.update({ where: { id: current.id }, data: { minutes: change.minutes, off: change.off, updatedByUserId: input.actorUserId } });
        audit.push({ employeeId: change.employeeId, date: change.date, before: current.off ? 'OFF' : formatMatrixHours(current.minutes) || '0', after });
      } else {
        await tx.timesheetV2CellOverride.create({ data: { employeeId: change.employeeId, siteId: input.siteId, workAreaId: input.workAreaId, date: new Date(`${change.date}T00:00:00.000Z`), minutes: change.minutes, off: change.off, updatedByUserId: input.actorUserId } });
        audit.push({ employeeId: change.employeeId, date: change.date, before: null, after });
      }
    }
    if (audit.length) {
      await createAuditEvent(tx, { actorUserId: input.actorUserId, eventType: 'TIMESHEET_V2_CELLS_EDITED', entityType: 'TIMESHEET_V2', entityId: null, requestId: input.requestId, beforeValue: null, afterValue: { siteId: input.siteId, workAreaId: input.workAreaId, month: input.month, changes: audit } });
    }
    return { saved: audit.length };
  });
}

/** "Вернуть автоматические значения": removes every typed value of one customer and month. */
export async function resetTimesheetV2Cells(input: { siteId: string; workAreaId: string | null; month: string; actorUserId: string; requestId: string }): Promise<{ removed: number }> {
  const { startDate, endDate } = monthRange(input.month);
  return prisma.$transaction(async (tx) => {
    const where = { siteId: input.siteId, workAreaId: input.workAreaId, date: { gte: new Date(`${startDate}T00:00:00.000Z`), lte: new Date(`${endDate}T00:00:00.000Z`) } };
    const rows = await tx.timesheetV2CellOverride.findMany({ where, select: { employeeId: true, date: true, minutes: true, off: true } });
    if (!rows.length) return { removed: 0 };
    await tx.timesheetV2CellOverride.deleteMany({ where });
    await createAuditEvent(tx, { actorUserId: input.actorUserId, eventType: 'TIMESHEET_V2_CELLS_RESET', entityType: 'TIMESHEET_V2', entityId: null, requestId: input.requestId, beforeValue: { cells: rows.map((r) => ({ employeeId: r.employeeId, date: r.date.toISOString().slice(0, 10), value: r.off ? 'OFF' : formatMatrixHours(r.minutes) || '0' })) }, afterValue: { siteId: input.siteId, workAreaId: input.workAreaId, month: input.month } });
    return { removed: rows.length };
  });
}
