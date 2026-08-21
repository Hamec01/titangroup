import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

export interface AdminGpsEvent {
  clockEventId: string;
  operationType: 'CHECK_IN' | 'CHECK_OUT';
  effectiveAt: string;
  siteId: string;
  siteName: string;
  latitude: string;
  longitude: string;
  accuracyMeters: string | null;
  verification: string;
}

export interface AdminWorkerGpsView {
  employee: { id: string; name: string; employeeNumber: string };
  items: AdminGpsEvent[];
  retentionDays: 90;
}

export async function getAdminWorkerGpsView(input: {
  employeeId: string;
  actorUserId: string;
  requestId: string;
  from: Date;
  toExclusive: Date;
}): Promise<AdminWorkerGpsView | null> {
  return prisma.$transaction(async (tx) => {
    const employee = await tx.employee.findUnique({
      where: { id: input.employeeId },
      select: { id: true, firstName: true, lastName: true, employeeNumber: true }
    });
    if (!employee) return null;
    const events = await tx.clockEvent.findMany({
      where: {
        employeeId: input.employeeId,
        effectiveAt: { gte: input.from, lt: input.toExclusive },
        location: { isNot: null }
      },
      orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: {
        id: true,
        operationType: true,
        effectiveAt: true,
        siteId: true,
        site: { select: { name: true } },
        gpsAccuracyMeters: true,
        gpsVerification: true,
        location: { select: { latitude: true, longitude: true } }
      }
    });
    await createAuditEvent(tx, {
      actorUserId: input.actorUserId,
      eventType: 'ATTENDANCE_RAW_GPS_VIEWED',
      entityType: 'EMPLOYEE',
      entityId: input.employeeId,
      requestId: input.requestId,
      beforeValue: null,
      afterValue: { employeeId: input.employeeId, from: input.from.toISOString(), toExclusive: input.toExclusive.toISOString(), eventCount: events.length }
    });
    return {
      employee: { id: employee.id, name: `${employee.firstName} ${employee.lastName}`, employeeNumber: employee.employeeNumber },
      items: events.flatMap((event) => event.location ? [{
        clockEventId: event.id,
        operationType: event.operationType,
        effectiveAt: event.effectiveAt.toISOString(),
        siteId: event.siteId,
        siteName: event.site.name,
        latitude: event.location.latitude.toFixed(6),
        longitude: event.location.longitude.toFixed(6),
        accuracyMeters: event.gpsAccuracyMeters?.toFixed(1) ?? null,
        verification: event.gpsVerification
      }] : []),
      retentionDays: 90
    };
  });
}
