// R08 — lib/gps-archive.ts: key fail-closed, deterministic JSONL, AES-256-GCM pack/unpack,
// tamper detection, manifest carries no coordinates. Pure (no DB, no fs) — unit lane.
import {
  isGpsArchiveKeyConfigured,
  packArchive,
  unpackArchive,
  serializeGpsRecords,
  parseGpsRecords,
  sha256Hex,
  buildDayManifest,
  archiveRelativePath,
  GpsArchiveKeyConfigError,
  GpsArchiveFormatError,
  type GpsArchiveRecord
} from '../lib/gps-archive';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};
const threw = (fn: () => unknown, type?: new (...a: never[]) => Error): boolean => {
  try { fn(); return false; } catch (e) { return type ? e instanceof type : true; }
};

const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');

const RECS: GpsArchiveRecord[] = [
  {
    recordType: 'clock_location',
    clockEventId: '11111111-1111-1111-1111-111111111111',
    employeeId: '22222222-2222-2222-2222-222222222222',
    operationType: 'CHECK_IN',
    recordedAt: '2026-06-01T07:59:30.000Z',
    effectiveAt: '2026-06-01T08:00:00.000Z',
    serverReceivedAt: '2026-06-01T08:00:05.000Z',
    latitude: '60.169100',
    longitude: '24.938400',
    accuracyMeters: '12.5',
    isApproximate: false,
    fixAgeSeconds: null,
    capturedAfterEventSeconds: null,
    capturedOffline: false,
    channel: 'ONLINE',
    siteId: '33333333-3333-3333-3333-333333333333',
    assumedSiteId: null,
    geofenceVersionId: '44444444-4444-4444-4444-444444444444',
    gpsVerification: 'VERIFIED_INSIDE',
    gpsUnavailableReason: null,
    locationCreatedAt: '2026-06-01T08:00:05.100Z',
    archivedAt: '2026-06-04T02:00:00.000Z'
  },
  {
    recordType: 'presence_sample',
    sampleId: '55555555-5555-5555-5555-555555555555',
    clientSampleId: '66666666-6666-6666-6666-666666666666',
    employeeId: '22222222-2222-2222-2222-222222222222',
    recordedAt: '2026-06-01T11:30:00.000Z',
    serverReceivedAt: '2026-06-01T11:31:00.000Z',
    latitude: '60.169200',
    longitude: '24.938500',
    accuracyMeters: '8.0',
    capturedOffline: true,
    siteId: '33333333-3333-3333-3333-333333333333',
    openShiftId: '77777777-7777-7777-7777-777777777777',
    geofenceVersionId: null,
    insideGeofence: true,
    sampleCreatedAt: '2026-06-01T11:31:00.200Z',
    archivedAt: '2026-06-04T02:00:00.000Z'
  }
];

function main() {
  // ---- key fail-closed ----
  delete process.env.GPS_ARCHIVE_ENCRYPTION_KEY;
  check('no key -> not configured', !isGpsArchiveKeyConfigured());
  check('no key -> packArchive throws GpsArchiveKeyConfigError', threw(() => packArchive('x'), GpsArchiveKeyConfigError));
  process.env.GPS_ARCHIVE_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64'); // 16 bytes, not 32
  check('16-byte key -> not configured', !isGpsArchiveKeyConfigured());
  process.env.GPS_ARCHIVE_ENCRYPTION_KEY = 'not!!base64!!!';
  check('garbage key -> not configured', !isGpsArchiveKeyConfigured());
  process.env.GPS_ARCHIVE_ENCRYPTION_KEY = KEY_A;
  check('valid 32-byte key -> configured', isGpsArchiveKeyConfigured());

  // ---- JSONL determinism ----
  const jsonl = serializeGpsRecords(RECS);
  check('serialize is deterministic', serializeGpsRecords(RECS) === jsonl);
  check('serialize sorts keys', jsonl.split('\n')[0].startsWith('{"accuracyMeters"'));
  check('one line per record + trailing newline', jsonl.split('\n').length === 3 && jsonl.endsWith('\n'));
  check('empty set -> empty string', serializeGpsRecords([]) === '');
  const back = parseGpsRecords(jsonl);
  check('parse round-trips record count', back.length === 2);
  check('parse round-trips a field', (back[0] as { latitude: string }).latitude === '60.169100');
  check('parse empty -> []', parseGpsRecords('').length === 0);
  check('parse rejects a non-JSON line', threw(() => parseGpsRecords('{"recordType":"x"}\nnope'), GpsArchiveFormatError));

  // ---- pack / unpack ----
  const blob1 = packArchive(jsonl);
  const blob2 = packArchive(jsonl);
  check('blob starts with TGPSA magic + version 1', blob1.subarray(0, 5).toString('ascii') === 'TGPSA' && blob1[5] === 1);
  check('two packs differ (random IV)', !blob1.equals(blob2));
  check('unpack(blob1) === original jsonl', unpackArchive(blob1) === jsonl);
  check('unpack(blob2) === original jsonl', unpackArchive(blob2) === jsonl);
  check('blob is meaningfully smaller than 2x plaintext (compressed)', blob1.length < Buffer.byteLength(jsonl) * 2);

  // ---- tamper / wrong key ----
  const tampered = Buffer.from(blob1);
  tampered[tampered.length - 1] ^= 0x01; // flip a bit in the auth tag
  check('tampered blob -> unpack throws', threw(() => unpackArchive(tampered)));
  const tampered2 = Buffer.from(blob1);
  tampered2[20] ^= 0x01; // flip a ciphertext bit
  check('tampered ciphertext -> unpack throws', threw(() => unpackArchive(tampered2)));
  const badMagic = Buffer.from(blob1); badMagic[0] = 0x00;
  check('bad magic -> GpsArchiveFormatError', threw(() => unpackArchive(badMagic), GpsArchiveFormatError));
  check('too-short blob -> GpsArchiveFormatError', threw(() => unpackArchive(Buffer.alloc(4)), GpsArchiveFormatError));
  process.env.GPS_ARCHIVE_ENCRYPTION_KEY = KEY_B;
  check('wrong key -> unpack throws', threw(() => unpackArchive(blob1)));
  process.env.GPS_ARCHIVE_ENCRYPTION_KEY = KEY_A;

  // ---- sha256 ----
  check('sha256Hex known value', sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  // ---- manifest carries counts + hashes, never coordinates ----
  const manifest = buildDayManifest({
    archiveDate: '2026-06-01',
    revision: 0,
    clockLocationCount: 1,
    presenceSampleCount: 1,
    coveredThroughCreatedAt: '2026-06-03T00:00:00.000Z',
    jsonl,
    blob: blob1,
    relativePath: archiveRelativePath('2026-06-01', 0)
  });
  check('manifest recordCount', manifest.recordCount === 2);
  check('manifest plaintextSha256 == sha256(jsonl)', manifest.plaintextSha256 === sha256Hex(jsonl));
  check('manifest ciphertextSha256 == sha256(blob)', manifest.ciphertextSha256 === sha256Hex(blob1));
  check('manifest ciphertextBytes == blob length', manifest.ciphertextBytes === blob1.length);
  const manifestJson = JSON.stringify(manifest);
  check('manifest JSON has no latitude value', !manifestJson.includes('60.169100') && !manifestJson.includes('24.938400'));
  check('manifest JSON has no employee id', !manifestJson.includes('22222222-2222-2222-2222-222222222222'));

  // ---- relative path ----
  check('relative path rev 0', archiveRelativePath('2026-06-01', 0) === 'gps-archive/2026/06/2026-06-01.jsonl.gz.enc');
  check('relative path rev 3 (amendment)', archiveRelativePath('2026-06-01', 3) === 'gps-archive/2026/06/2026-06-01.r03.jsonl.gz.enc');

  console.log(`\nPASS: ${pass}/${pass + fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
