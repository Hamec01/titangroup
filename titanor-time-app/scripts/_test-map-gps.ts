import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { searchSiteAddress } from '../lib/site-geocoding';
import { getAdminWorkerGpsView } from '../lib/attendance-gps-admin';

let pass = 0;
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(`FAIL: ${label}`); pass += 1; }

async function main() {
  const query = 'Mannerheimintie 1 Helsinki';
  const normalized = query.toLocaleLowerCase('en-US');
  await prisma.addressGeocodeCache.create({
    data: {
      queryHash: createHash('sha256').update(normalized).digest('hex'),
      queryNormalized: query,
      results: [{ displayName: 'Mannerheimintie 1, Helsinki', latitude: '60.169900', longitude: '24.938400' }],
      fetchedAt: new Date()
    }
  });
  const cached = await searchSiteAddress(query);
  check(cached.ok && cached.cached && cached.items[0].latitude === '60.169900', 'sanitized geocoder cache hit');
  let invalidHashRejected = false;
  try {
    await prisma.$executeRaw`INSERT INTO "AddressGeocodeCache" ("queryHash", "queryNormalized", "results", "fetchedAt") VALUES ('NOT-A-SHA256', 'invalid', '[]'::jsonb, now())`;
  } catch (error) {
    invalidHashRejected = String(error).includes('ck_address_geocode_cache_query_hash');
  }
  check(invalidHashRejected, 'geocoder cache rejects a malformed query hash');
  await prisma.geocodingProviderState.upsert({ where: { provider: 'NOMINATIM' }, create: { provider: 'NOMINATIM', lastRequestAt: new Date() }, update: { lastRequestAt: new Date() } });
  const limited = await searchSiteAddress('A completely uncached test address');
  check(!limited.ok && limited.code === 'RATE_LIMITED', 'cross-process provider rate gate');

  const actor = await prisma.user.create({ data: { username: `gps-admin-${randomUUID()}`, status: 'ACTIVE', locale: 'EN' } });
  const employee = await prisma.employee.create({ data: { employeeNumber: `GPS-${randomUUID()}`, firstName: 'Gps', lastName: 'Worker' } });
  const site = await prisma.workSite.create({ data: { name: `GPS Site ${randomUUID()}` } });
  const eventId = randomUUID();
  await prisma.clockEvent.create({
    data: {
      id: eventId,
      employeeId: employee.id,
      operationType: 'CHECK_IN',
      siteId: site.id,
      clientCapturedAt: new Date(),
      capturedOffline: false,
      effectiveAt: new Date(),
      gpsAccuracyMeters: '12.3',
      gpsVerification: 'VERIFIED_INSIDE',
      processingState: 'ACCEPTED',
      channel: 'ONLINE',
      payloadHash: 'a'.repeat(64),
      requestId: randomUUID(),
      location: { create: { latitude: '60.170000', longitude: '24.940000' } }
    }
  });
  const view = await getAdminWorkerGpsView({ employeeId: employee.id, actorUserId: actor.id, requestId: randomUUID(), from: new Date(Date.now() - 86_400_000), toExclusive: new Date(Date.now() + 86_400_000) });
  check(view?.items.length === 1 && view.items[0].longitude === '24.940000', 'raw GPS returned only by explicit privileged service');
  const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: 'ATTENDANCE_RAW_GPS_VIEWED', entityId: employee.id }, orderBy: { createdAt: 'desc' } });
  const auditText = JSON.stringify(audit);
  check(!auditText.includes('60.170000') && !auditText.includes('24.940000') && !auditText.includes('latitude') && !auditText.includes('longitude'), 'GPS audit is coordinate-free');
  const grants = await prisma.rolePermission.findMany({ where: { permission: { code: 'attendance.gps.read.raw' } }, include: { role: true } });
  check(grants.length === 2 && grants.every((grant) => ['ADMIN', 'SUPER_ADMIN'].includes(grant.role.name)), 'raw GPS permission has exactly two admin grants');
  console.log(`PASS: ${pass}/${pass} map/GPS integration checks`);
}

main().finally(() => prisma.$disconnect());
