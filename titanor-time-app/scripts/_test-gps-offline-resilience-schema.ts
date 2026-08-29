// T14.1 (2026-08-29) — GPS offline resilience schema: ClockEventLocation approximate columns +
// their CHECK, and WorkSite.gpsOftenUnavailable default.
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

function isCheckViolation(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes('23514') || m.includes('ck_clock_event_location_approx_shape');
}

async function makeClockEvent(): Promise<{ eventId: string }> {
  const emp = await prisma.employee.create({ data: { employeeNumber: `T14-${randomUUID().slice(0, 8)}`, firstName: 'T', lastName: '14' } });
  const site = await prisma.workSite.create({ data: { name: `T14 ${randomUUID().slice(0, 5)}` } });
  const ev = await prisma.clockEvent.create({
    data: {
      id: randomUUID(),
      employeeId: emp.id,
      operationType: 'CHECK_IN',
      siteId: site.id,
      clientCapturedAt: new Date(),
      capturedOffline: true,
      effectiveAt: new Date(),
      gpsVerification: 'NOT_VERIFIED',
      gpsUnavailableReason: 'TIMEOUT',
      processingState: 'ACCEPTED',
      channel: 'OFFLINE_SYNC',
      payloadHash: 'a'.repeat(64),
      requestId: randomUUID()
    }
  });
  return { eventId: ev.id };
}

async function main() {
  // 1. WorkSite.gpsOftenUnavailable default false, togglable
  {
    const s = await prisma.workSite.create({ data: { name: `T14-flag ${randomUUID().slice(0, 5)}` } });
    check('WorkSite.gpsOftenUnavailable defaults to false', s.gpsOftenUnavailable === false);
    const u = await prisma.workSite.update({ where: { id: s.id }, data: { gpsOftenUnavailable: true } });
    check('WorkSite.gpsOftenUnavailable can be set true', u.gpsOftenUnavailable === true);
  }

  // 2. a fresh fix: isApproximate=false, both age columns null
  {
    const { eventId } = await makeClockEvent();
    const loc = await prisma.clockEventLocation.create({ data: { clockEventId: eventId, latitude: 60.44, longitude: 22.21 } });
    check('fresh ClockEventLocation: isApproximate=false, ages null', loc.isApproximate === false && loc.fixAgeSeconds === null && loc.capturedAfterEventSeconds === null, loc);
  }

  // 3. an approximate fix: isApproximate=true + fixAgeSeconds
  {
    const { eventId } = await makeClockEvent();
    const loc = await prisma.clockEventLocation.create({ data: { clockEventId: eventId, latitude: 60.44, longitude: 22.21, isApproximate: true, fixAgeSeconds: 480 } });
    check('approximate ClockEventLocation with fixAgeSeconds inserts', loc.isApproximate && loc.fixAgeSeconds === 480);
  }

  // 4. a back-filled fix: capturedAfterEventSeconds
  {
    const { eventId } = await makeClockEvent();
    const loc = await prisma.clockEventLocation.create({ data: { clockEventId: eventId, latitude: 60.44, longitude: 22.21, isApproximate: true, capturedAfterEventSeconds: 1320 } });
    check('back-filled ClockEventLocation with capturedAfterEventSeconds inserts', loc.capturedAfterEventSeconds === 1320);
  }

  // 5. CHECK rejects: both age columns set
  {
    const { eventId } = await makeClockEvent();
    let threw = false;
    try {
      await prisma.clockEventLocation.create({ data: { clockEventId: eventId, latitude: 60.44, longitude: 22.21, isApproximate: true, fixAgeSeconds: 100, capturedAfterEventSeconds: 100 } });
    } catch (e) {
      threw = isCheckViolation(e);
    }
    check('CHECK rejects both fixAgeSeconds and capturedAfterEventSeconds set', threw);
  }

  // 6. an approximate fix with no knowable age (OS-cached position) — allowed (migration 20260829180000)
  {
    const { eventId } = await makeClockEvent();
    const loc = await prisma.clockEventLocation.create({ data: { clockEventId: eventId, latitude: 60.44, longitude: 22.21, isApproximate: true } });
    check('approximate ClockEventLocation with no age columns is allowed', loc.isApproximate === true && loc.fixAgeSeconds === null && loc.capturedAfterEventSeconds === null, loc);
  }

  // 6b. CHECK still rejects: an age column set on a NON-approximate fix
  {
    const { eventId } = await makeClockEvent();
    let threw = false;
    try {
      await prisma.clockEventLocation.create({ data: { clockEventId: eventId, latitude: 60.44, longitude: 22.21, isApproximate: false, fixAgeSeconds: 120 } });
    } catch (e) {
      threw = isCheckViolation(e);
    }
    check('CHECK rejects an age column on a non-approximate fix', threw);
  }

  // 7. CHECK rejects: negative age
  {
    const { eventId } = await makeClockEvent();
    let threw = false;
    try {
      await prisma.clockEventLocation.create({ data: { clockEventId: eventId, latitude: 60.44, longitude: 22.21, isApproximate: true, fixAgeSeconds: -5 } });
    } catch (e) {
      threw = isCheckViolation(e);
    }
    check('CHECK rejects a negative fixAgeSeconds', threw);
  }

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
