// UT5-B — lib/customer-hours-confirmation-token.ts (sign/verify, TTL/expiry, tamper detection,
// malformed/oversized input, missing/malformed secret) plus a light pure check of
// lib/reporting/weekly-approval.ts's snapshot builders (schemaVersion shape, fingerprint fidelity).
// Pure — no database, no network.
export {}; // forces module scope (every import below is dynamic, to control secret-read timing)

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}

async function main() {
  // ---------------------------------------------------------------------------------------------
  // 1. Missing secret — sign() throws a clear error; verify() never throws, returns INVALID.
  //    Run FIRST, before any valid secret is set (confirmationTokenHmacKey() memoizes).
  // ---------------------------------------------------------------------------------------------
  {
    delete process.env.CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY;
    const { signConfirmationToken, verifyConfirmationToken } = await import('../lib/customer-hours-confirmation-token');
    let threw = false;
    try {
      signConfirmationToken({ actorUserId: 'a', employeeId: 'e', itemKey: { timesheetId: 't', siteId: 's', workAreaId: null, weekStart: '2026-09-21' }, expectedFingerprint: '0'.repeat(64) });
    } catch (err) {
      threw = err instanceof Error && err.message.includes('CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY');
    }
    check('1: sign() throws a clear error when the secret is unset', threw);

    const verified = verifyConfirmationToken('anything.here');
    check('1b: verify() never throws even with no secret configured, returns INVALID', !verified.ok && verified.reason === 'INVALID', verified);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Malformed secret shape — sign() throws. Must run BEFORE any valid secret is set: the key is
  //    memoized only on its first SUCCESSFUL read (lib/customer-hours-confirmation-token.ts never
  //    caches a throw), so this and block 1 above can share the same module instance as long as
  //    neither one ever succeeds before this point.
  // ---------------------------------------------------------------------------------------------
  {
    process.env.CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY = 'not-base64-32-bytes';
    const { signConfirmationToken: signWithBadSecret } = await import('../lib/customer-hours-confirmation-token');
    let threw = false;
    try {
      signWithBadSecret({ actorUserId: 'a', employeeId: 'e', itemKey: { timesheetId: 't', siteId: 's', workAreaId: null, weekStart: '2026-09-21' }, expectedFingerprint: '0'.repeat(64) });
    } catch (err) {
      threw = err instanceof Error && err.message.includes('canonical base64');
    }
    check('2: sign() throws a clear error for a malformed (non-32-byte-base64) secret', threw);
  }

  // Now set a real, valid 32-byte base64 secret for every subsequent check.
  const { randomBytes } = await import('node:crypto');
  process.env.CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY = randomBytes(32).toString('base64');
  const { signConfirmationToken, verifyConfirmationToken, confirmationItemKeyEquals, CONFIRMATION_TOKEN_TTL_MS } = await import('../lib/customer-hours-confirmation-token');

  const itemKey = { timesheetId: '11111111-1111-1111-1111-111111111111', siteId: '22222222-2222-2222-2222-222222222222', workAreaId: '33333333-3333-3333-3333-333333333333', weekStart: '2026-09-21' };
  const fingerprint = 'a'.repeat(64);

  // ---------------------------------------------------------------------------------------------
  // 3. Valid round-trip.
  // ---------------------------------------------------------------------------------------------
  {
    const now = new Date('2026-09-22T10:00:00.000Z');
    const { token, expiresAt } = signConfirmationToken({ actorUserId: 'admin-1', employeeId: 'emp-1', itemKey, expectedFingerprint: fingerprint, now });
    check('3: token has the dot-separated payload.signature shape', token.includes('.') && token.split('.').length === 2, token);
    check('3b: expiresAt is exactly TTL after issuedAt', new Date(expiresAt).getTime() === now.getTime() + CONFIRMATION_TOKEN_TTL_MS, { expiresAt, now: now.toISOString() });

    const verified = verifyConfirmationToken(token, new Date(now.getTime() + 1000));
    check('3c: verify succeeds just after issuance', verified.ok, verified);
    if (verified.ok) {
      check('3d: payload carries the exact actorUserId', verified.payload.actorUserId === 'admin-1', verified.payload);
      check('3e: payload carries the exact employeeId', verified.payload.employeeId === 'emp-1', verified.payload);
      check('3f: payload carries the exact itemKey', confirmationItemKeyEquals(verified.payload.itemKey, itemKey), verified.payload.itemKey);
      check('3g: payload carries the exact expectedFingerprint', verified.payload.expectedFingerprint === fingerprint, verified.payload);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Expiry — verified exactly at/after expiresAt is EXPIRED, just before is still ok.
  // ---------------------------------------------------------------------------------------------
  {
    const now = new Date('2026-09-22T10:00:00.000Z');
    const { token, expiresAt } = signConfirmationToken({ actorUserId: 'admin-1', employeeId: 'emp-1', itemKey, expectedFingerprint: fingerprint, now });
    const justBefore = verifyConfirmationToken(token, new Date(new Date(expiresAt).getTime() - 1));
    check('4: still valid 1ms before expiresAt', justBefore.ok, justBefore);
    const atExpiry = verifyConfirmationToken(token, new Date(expiresAt));
    check('4b: EXPIRED exactly at expiresAt', !atExpiry.ok && atExpiry.reason === 'EXPIRED', atExpiry);
    const wellAfter = verifyConfirmationToken(token, new Date(new Date(expiresAt).getTime() + CONFIRMATION_TOKEN_TTL_MS));
    check('4c: EXPIRED well after expiresAt', !wellAfter.ok && wellAfter.reason === 'EXPIRED', wellAfter);
  }

  // ---------------------------------------------------------------------------------------------
  // 4d. issuedAt in the future (relative to the verifier's clock) -> INVALID, never honored just
  //     because it hasn't expired yet by its own (untrustworthy) clock. UT5-B-fixup #2.
  // ---------------------------------------------------------------------------------------------
  {
    const future = new Date('2026-09-22T10:00:00.000Z');
    const { token } = signConfirmationToken({ actorUserId: 'admin-1', employeeId: 'emp-1', itemKey, expectedFingerprint: fingerprint, now: future });
    const verifiedBeforeIssuance = verifyConfirmationToken(token, new Date(future.getTime() - 1000));
    check('4d: a token with issuedAt in the future (by the verifier clock) is rejected as INVALID BAD_SHAPE, not honored', !verifiedBeforeIssuance.ok && verifiedBeforeIssuance.reason === 'INVALID' && verifiedBeforeIssuance.detail === 'BAD_SHAPE', verifiedBeforeIssuance);
    const verifiedExactlyAtIssuance = verifyConfirmationToken(token, future);
    check('4e: verifying exactly AT issuedAt is still valid (boundary, not rejected)', verifiedExactlyAtIssuance.ok, verifiedExactlyAtIssuance);
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Tampered payload — flip one character in the payload segment.
  // ---------------------------------------------------------------------------------------------
  {
    const { token } = signConfirmationToken({ actorUserId: 'admin-1', employeeId: 'emp-1', itemKey, expectedFingerprint: fingerprint });
    const [payloadB64, sig] = token.split('.');
    const flipped = payloadB64.slice(0, -1) + (payloadB64.at(-1) === 'A' ? 'B' : 'A');
    const tampered = `${flipped}.${sig}`;
    const verified = verifyConfirmationToken(tampered);
    check('5: tampered payload -> INVALID BAD_SIGNATURE', !verified.ok && verified.reason === 'INVALID' && verified.detail === 'BAD_SIGNATURE', verified);
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Tampered signature — flip one character in the signature segment.
  // ---------------------------------------------------------------------------------------------
  {
    const { token } = signConfirmationToken({ actorUserId: 'admin-1', employeeId: 'emp-1', itemKey, expectedFingerprint: fingerprint });
    const [payloadB64, sig] = token.split('.');
    const flippedSig = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A');
    const verified = verifyConfirmationToken(`${payloadB64}.${flippedSig}`);
    check('6: tampered signature -> INVALID BAD_SIGNATURE', !verified.ok && verified.reason === 'INVALID' && verified.detail === 'BAD_SIGNATURE', verified);
  }

  // ---------------------------------------------------------------------------------------------
  // 7. Wrong actor / wrong item / wrong fingerprint — token itself verifies (it's genuinely valid),
  //    contextual binding is the CALLER's job; this proves the payload carries enough to detect it.
  // ---------------------------------------------------------------------------------------------
  {
    const { token } = signConfirmationToken({ actorUserId: 'admin-1', employeeId: 'emp-1', itemKey, expectedFingerprint: fingerprint });
    const verified = verifyConfirmationToken(token);
    check('7: token verifies (signature/shape valid)', verified.ok, verified);
    if (verified.ok) {
      check('7b: caller detects a wrong actor', verified.payload.actorUserId !== 'someone-else', verified.payload.actorUserId);
      check('7c: caller detects a wrong item key', !confirmationItemKeyEquals(verified.payload.itemKey, { ...itemKey, weekStart: '2026-09-28' }), verified.payload.itemKey);
      check('7d: caller detects a wrong fingerprint', verified.payload.expectedFingerprint !== 'b'.repeat(64), verified.payload.expectedFingerprint);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 8. Malformed tokens — never throw, always INVALID with a specific detail.
  // ---------------------------------------------------------------------------------------------
  {
    check('8: empty string -> INVALID', !verifyConfirmationToken('').ok);
    check('8b: no dot separator -> INVALID MALFORMED', (() => { const v = verifyConfirmationToken('nodothere'); return !v.ok && v.reason === 'INVALID' && v.detail === 'MALFORMED'; })());
    check('8c: two dots -> INVALID MALFORMED', (() => { const v = verifyConfirmationToken('a.b.c'); return !v.ok && v.reason === 'INVALID' && v.detail === 'MALFORMED'; })());
    check('8d: trailing dot with empty signature -> INVALID MALFORMED', (() => { const v = verifyConfirmationToken('abc.'); return !v.ok && v.reason === 'INVALID' && v.detail === 'MALFORMED'; })());
    check('8e: leading dot with empty payload -> INVALID MALFORMED', (() => { const v = verifyConfirmationToken('.abc'); return !v.ok && v.reason === 'INVALID' && v.detail === 'MALFORMED'; })());
    // Valid base64url + valid HMAC over garbage JSON -> signature matches (since we sign whatever
    // string we're given) but JSON.parse/shape-check fails -> MALFORMED, never a throw.
    const garbagePayload = Buffer.from('not json', 'utf8').toString('base64url');
    const { createHmac } = await import('node:crypto');
    const key = Buffer.from(process.env.CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY as string, 'base64');
    const garbageSig = createHmac('sha256', key).update(garbagePayload).digest('base64url');
    const garbageVerified = verifyConfirmationToken(`${garbagePayload}.${garbageSig}`);
    check('8f: correctly-signed non-JSON payload -> INVALID MALFORMED, never throws', !garbageVerified.ok && garbageVerified.reason === 'INVALID' && garbageVerified.detail === 'MALFORMED', garbageVerified);

    // Correctly-signed JSON that is missing required fields -> BAD_SHAPE.
    const badShapePayloadObj = { v: 1, actorUserId: 'a' }; // missing employeeId/itemKey/expectedFingerprint/issuedAt/expiresAt
    const badShapePayloadB64 = Buffer.from(JSON.stringify(badShapePayloadObj), 'utf8').toString('base64url');
    const badShapeSig = createHmac('sha256', key).update(badShapePayloadB64).digest('base64url');
    const badShapeVerified = verifyConfirmationToken(`${badShapePayloadB64}.${badShapeSig}`);
    check('8g: correctly-signed but incomplete payload -> INVALID BAD_SHAPE', !badShapeVerified.ok && badShapeVerified.reason === 'INVALID' && badShapeVerified.detail === 'BAD_SHAPE', badShapeVerified);

    // Correctly-signed JSON with a wrong version number -> BAD_SHAPE.
    const wrongVersionObj = { v: 2, actorUserId: 'a', employeeId: 'e', itemKey, expectedFingerprint: fingerprint, issuedAt: Date.now(), expiresAt: Date.now() + 60000 };
    const wrongVersionB64 = Buffer.from(JSON.stringify(wrongVersionObj), 'utf8').toString('base64url');
    const wrongVersionSig = createHmac('sha256', key).update(wrongVersionB64).digest('base64url');
    const wrongVersionVerified = verifyConfirmationToken(`${wrongVersionB64}.${wrongVersionSig}`);
    check('8h: wrong schema version -> INVALID BAD_SHAPE', !wrongVersionVerified.ok && wrongVersionVerified.reason === 'INVALID' && wrongVersionVerified.detail === 'BAD_SHAPE', wrongVersionVerified);
  }

  // ---------------------------------------------------------------------------------------------
  // 9. Oversized token -> INVALID TOO_LARGE, rejected before any JSON.parse attempt.
  // ---------------------------------------------------------------------------------------------
  {
    const huge = `${'a'.repeat(5000)}.sig`;
    const verified = verifyConfirmationToken(huge);
    check('9: oversized token -> INVALID TOO_LARGE', !verified.ok && verified.reason === 'INVALID' && verified.detail === 'TOO_LARGE', verified);
  }

  // ---------------------------------------------------------------------------------------------
  // 10. Snapshot builders (lib/reporting/weekly-approval.ts) — pure, schema shape + fingerprint
  //     fidelity. Not a DB test; constructs a minimal WeeklyApprovalPreparationOk-shaped object by
  //     hand.
  // ---------------------------------------------------------------------------------------------
  {
    const { buildSelectionSnapshotV1, buildApprovalItemSnapshotV1 } = await import('../lib/reporting/weekly-approval');
    const selection = buildSelectionSnapshotV1([itemKey]);
    check('10: selectionSnapshot has schemaVersion 1 and mode SINGLE', selection.schemaVersion === 1 && selection.mode === 'SINGLE', selection);
    check('10b: selectionSnapshot.itemKeys carries the exact item key', selection.itemKeys.length === 1 && confirmationItemKeyEquals(selection.itemKeys[0], itemKey), selection);

    const fakePrepared = {
      ok: true as const,
      employeeId: 'emp-1',
      employeeName: 'Worker One',
      employeeNumber: 'W-001',
      siteName: 'Site A',
      workAreaName: 'Customer X',
      slice: {
        logicalKey: { employeeId: 'emp-1', timesheetId: itemKey.timesheetId, siteId: itemKey.siteId, workAreaId: itemKey.workAreaId, weekStart: itemKey.weekStart, weekEnd: '2026-09-27' },
        payload: { schemaVersion: 1 as const, employeeId: 'emp-1', siteId: itemKey.siteId, workAreaId: itemKey.workAreaId, weekStart: itemKey.weekStart, weekEnd: '2026-09-27', days: [] },
        fingerprint,
        workedMinutes: 480,
        grossMinutes: 510,
        breakMinutes: 30,
        dayTotals: []
      },
      canonicalSource: { dataSource: 'CURRENT_VERSION' as const, sourceId: 'ver-1', sourceKind: 'VERSION' as const, sourceRevision: null, versionNumber: 1, submissionSource: 'MANUAL' as const },
      submissionState: 'SUBMITTED' as const,
      existingCurrentItem: null,
      supersededFingerprintMatch: false,
      blockers: [],
      warnings: [],
      eligibility: { canApprove: true }
    };
    const itemSnapshot = buildApprovalItemSnapshotV1(fakePrepared);
    check('10c: itemSnapshot has schemaVersion 1', itemSnapshot.schemaVersion === 1, itemSnapshot);
    check('10d: itemSnapshot.fingerprint matches the slice fingerprint exactly (not re-derived)', itemSnapshot.fingerprint === fingerprint, itemSnapshot);
    check('10e: itemSnapshot.canonicalPayload is the exact slice.payload object (same fingerprint input)', itemSnapshot.canonicalPayload === fakePrepared.slice.payload, itemSnapshot);
    check('10f: itemSnapshot.workedMinutes/grossMinutes/breakMinutes match the slice exactly', itemSnapshot.workedMinutes === 480 && itemSnapshot.grossMinutes === 510 && itemSnapshot.breakMinutes === 30, itemSnapshot);
    check(
      '10g: itemSnapshot never leaks GPS/token/session/full-User fields (only the documented keys)',
      Object.keys(itemSnapshot).sort().join(',') === ['schemaVersion', 'logicalKey', 'canonicalSource', 'fingerprint', 'workedMinutes', 'grossMinutes', 'breakMinutes', 'canonicalPayload', 'displayMetadata'].sort().join(','),
      Object.keys(itemSnapshot)
    );
    check('10h: displayMetadata carries only name fields, no ids/secrets', Object.keys(itemSnapshot.displayMetadata).sort().join(',') === ['employeeName', 'employeeNumber', 'siteName', 'workAreaName'].sort().join(','), itemSnapshot.displayMetadata);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
