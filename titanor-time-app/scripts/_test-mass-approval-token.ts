// UT6-B — lib/customer-hours-confirmation-token.ts's mass-selection token (signMassConfirmationToken/
// verifyMassConfirmationToken: TTL/expiry, future-issuedAt rejection, tamper detection, malformed/
// oversized input, and — critically — that it is NEVER interchangeable with the single-item token),
// plus a light pure check of lib/reporting/weekly-approval.ts's selection helpers (canonical sort,
// selectionHash stability, duplicate/limit rejection) — the same "pure check of weekly-approval.ts"
// scope _test-weekly-approval-token.ts already covers for the single-item side. Pure — no database,
// no network.
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
  // 1. Missing secret — sign() throws, verify() never throws. Run FIRST, before any valid secret is
  //    set (confirmationTokenHmacKey() memoizes only on a successful read).
  // ---------------------------------------------------------------------------------------------
  {
    delete process.env.CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY;
    const { signMassConfirmationToken, verifyMassConfirmationToken } = await import('../lib/customer-hours-confirmation-token');
    let threw = false;
    try {
      signMassConfirmationToken({ actorUserId: 'a', selectionHash: '0'.repeat(64), itemCount: 3 });
    } catch (err) {
      threw = err instanceof Error && err.message.includes('CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY');
    }
    check('1: sign() throws a clear error when the secret is unset', threw);
    const verified = verifyMassConfirmationToken('anything.here');
    check('1b: verify() never throws even with no secret configured, returns INVALID', !verified.ok && verified.reason === 'INVALID', verified);
  }

  const { randomBytes } = await import('node:crypto');
  process.env.CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY = randomBytes(32).toString('base64');
  const { signConfirmationToken, verifyConfirmationToken, signMassConfirmationToken, verifyMassConfirmationToken, CONFIRMATION_TOKEN_TTL_MS } = await import('../lib/customer-hours-confirmation-token');

  const selectionHash = 'b'.repeat(64);

  // ---------------------------------------------------------------------------------------------
  // 2. Valid round-trip.
  // ---------------------------------------------------------------------------------------------
  {
    const now = new Date('2026-09-22T10:00:00.000Z');
    const { token, expiresAt } = signMassConfirmationToken({ actorUserId: 'admin-1', selectionHash, itemCount: 5, now });
    check('2: token has the dot-separated payload.signature shape', token.includes('.') && token.split('.').length === 2, token);
    check('2b: expiresAt is exactly TTL after issuedAt', new Date(expiresAt).getTime() === now.getTime() + CONFIRMATION_TOKEN_TTL_MS, { expiresAt, now: now.toISOString() });

    const verified = verifyMassConfirmationToken(token, new Date(now.getTime() + 1000));
    check('2c: verify succeeds just after issuance', verified.ok, verified);
    if (verified.ok) {
      check('2d: payload carries kind MASS', verified.payload.kind === 'MASS', verified.payload);
      check('2e: payload carries the exact actorUserId', verified.payload.actorUserId === 'admin-1', verified.payload);
      check('2f: payload carries the exact selectionHash', verified.payload.selectionHash === selectionHash, verified.payload);
      check('2g: payload carries the exact itemCount', verified.payload.itemCount === 5, verified.payload);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Expiry.
  // ---------------------------------------------------------------------------------------------
  {
    const now = new Date('2026-09-22T10:00:00.000Z');
    const { token, expiresAt } = signMassConfirmationToken({ actorUserId: 'admin-1', selectionHash, itemCount: 2, now });
    const justBefore = verifyMassConfirmationToken(token, new Date(new Date(expiresAt).getTime() - 1));
    check('3: still valid 1ms before expiresAt', justBefore.ok, justBefore);
    const atExpiry = verifyMassConfirmationToken(token, new Date(expiresAt));
    check('3b: EXPIRED exactly at expiresAt', !atExpiry.ok && atExpiry.reason === 'EXPIRED', atExpiry);
  }

  // ---------------------------------------------------------------------------------------------
  // 4. issuedAt in the future -> INVALID BAD_SHAPE, mirroring the single-item token's UT5-B-fixup #2
  //    fix (shared checkTemporalValidity, never a second copy of this bounds check).
  // ---------------------------------------------------------------------------------------------
  {
    const future = new Date('2026-09-22T10:00:00.000Z');
    const { token } = signMassConfirmationToken({ actorUserId: 'admin-1', selectionHash, itemCount: 1, now: future });
    const verifiedBeforeIssuance = verifyMassConfirmationToken(token, new Date(future.getTime() - 1000));
    check('4: a token with issuedAt in the future is rejected as INVALID BAD_SHAPE', !verifiedBeforeIssuance.ok && verifiedBeforeIssuance.reason === 'INVALID' && verifiedBeforeIssuance.detail === 'BAD_SHAPE', verifiedBeforeIssuance);
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Tampered payload.
  // ---------------------------------------------------------------------------------------------
  {
    const { token } = signMassConfirmationToken({ actorUserId: 'admin-1', selectionHash, itemCount: 1 });
    const [payloadB64, sig] = token.split('.');
    const flipped = payloadB64.slice(0, -1) + (payloadB64.at(-1) === 'A' ? 'B' : 'A');
    const verified = verifyMassConfirmationToken(`${flipped}.${sig}`);
    check('5: tampered payload -> INVALID BAD_SIGNATURE', !verified.ok && verified.reason === 'INVALID' && verified.detail === 'BAD_SIGNATURE', verified);
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Oversized / malformed input never throws.
  // ---------------------------------------------------------------------------------------------
  {
    const oversized = 'a'.repeat(5000) + '.sig';
    const r1 = verifyMassConfirmationToken(oversized);
    check('6: oversized token -> INVALID TOO_LARGE', !r1.ok && r1.reason === 'INVALID' && r1.detail === 'TOO_LARGE', r1);
    const r2 = verifyMassConfirmationToken('no-dot-here');
    check('6b: malformed (no dot) -> INVALID MALFORMED', !r2.ok && r2.reason === 'INVALID' && r2.detail === 'MALFORMED', r2);
  }

  // ---------------------------------------------------------------------------------------------
  // 7. Single- and mass-token cross-incompatibility (UT6-A-R1 §10 explicit requirement).
  // ---------------------------------------------------------------------------------------------
  {
    const itemKey = { timesheetId: '11111111-1111-1111-1111-111111111111', siteId: '22222222-2222-2222-2222-222222222222', workAreaId: null, weekStart: '2026-09-21' };
    const { token: singleToken } = signConfirmationToken({ actorUserId: 'admin-1', employeeId: 'emp-1', itemKey, expectedFingerprint: 'a'.repeat(64) });
    const massVerifyOfSingle = verifyMassConfirmationToken(singleToken);
    check('7: a single-item token is rejected by verifyMassConfirmationToken (BAD_SHAPE)', !massVerifyOfSingle.ok && massVerifyOfSingle.reason === 'INVALID' && massVerifyOfSingle.detail === 'BAD_SHAPE', massVerifyOfSingle);

    const { token: massToken } = signMassConfirmationToken({ actorUserId: 'admin-1', selectionHash, itemCount: 1 });
    const singleVerifyOfMass = verifyConfirmationToken(massToken);
    check('7b: a mass token is rejected by verifyConfirmationToken (BAD_SHAPE)', !singleVerifyOfMass.ok && singleVerifyOfMass.reason === 'INVALID' && singleVerifyOfMass.detail === 'BAD_SHAPE', singleVerifyOfMass);
  }

  // ---------------------------------------------------------------------------------------------
  // 8. itemCount must be a positive integer — a forged/corrupted payload with itemCount=0 or
  //    negative is rejected even with a valid signature (shape guard, not just crypto).
  // ---------------------------------------------------------------------------------------------
  {
    // Build a payload shape directly (bypassing the sign() convenience) to exercise isMassPayloadShape
    // with a bad itemCount but an otherwise well-formed, correctly-signed token.
    const { createHmac } = await import('node:crypto');
    const now = Date.now();
    const badPayload = { v: 1, kind: 'MASS', actorUserId: 'admin-1', selectionHash, itemCount: 0, issuedAt: now, expiresAt: now + CONFIRMATION_TOKEN_TTL_MS };
    const payloadB64 = Buffer.from(JSON.stringify(badPayload), 'utf8').toString('base64url');
    const key = Buffer.from(process.env.CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY as string, 'base64');
    const sig = createHmac('sha256', key).update(payloadB64).digest('base64url');
    const forged = `${payloadB64}.${sig}`;
    const verified = verifyMassConfirmationToken(forged);
    check('8: itemCount=0 with an otherwise valid signature -> INVALID BAD_SHAPE', !verified.ok && verified.reason === 'INVALID' && verified.detail === 'BAD_SHAPE', verified);
  }

  // ---------------------------------------------------------------------------------------------
  // 9. lib/reporting/weekly-approval.ts's selection helpers — pure functions, no DB round-trip even
  //    though the module also exports DB-touching functions (same "light pure check" scope as
  //    _test-weekly-approval-token.ts's own snapshot-builder checks).
  // ---------------------------------------------------------------------------------------------
  {
    const { computeSelectionHash, sortSelectionCanonically, validateMassSelection, MAX_MASS_SELECTION_ITEMS } = await import('../lib/reporting/weekly-approval');

    const a = { itemKey: { timesheetId: '11111111-1111-1111-1111-111111111111', siteId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', workAreaId: null, weekStart: '2026-09-21' }, expectedFingerprint: '1'.repeat(64) };
    const b = { itemKey: { timesheetId: '22222222-2222-2222-2222-222222222222', siteId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', workAreaId: null, weekStart: '2026-09-21' }, expectedFingerprint: '2'.repeat(64) };
    const c = { itemKey: { timesheetId: '33333333-3333-3333-3333-333333333333', siteId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', workAreaId: null, weekStart: '2026-09-14' }, expectedFingerprint: '3'.repeat(64) };

    const hashForward = computeSelectionHash([a, b, c]);
    const hashReversed = computeSelectionHash([c, b, a]);
    const hashShuffled = computeSelectionHash([b, a, c]);
    check('9: selectionHash is stable regardless of input array order', hashForward === hashReversed && hashForward === hashShuffled, { hashForward, hashReversed, hashShuffled });

    const sorted = sortSelectionCanonically([c, a, b]);
    check('9b: sortSelectionCanonically orders by weekStart within one (siteId, workAreaId)', sorted[0] === c && sorted[1] === a && sorted[2] === b, sorted.map((s) => s.itemKey.weekStart));

    const differentContent = computeSelectionHash([a, b]);
    check('9c: a different selection produces a different hash', differentContent !== hashForward, { differentContent, hashForward });

    const dup = validateMassSelection([a, b, { ...a }]);
    check('10: a duplicate logical key is rejected', !dup.ok && dup.error.code === 'DUPLICATE_SELECTION_ITEM', dup);

    const empty = validateMassSelection([]);
    check('11: an empty selection is rejected', !empty.ok && empty.error.code === 'EMPTY_SELECTION', empty);

    const tooMany = Array.from({ length: MAX_MASS_SELECTION_ITEMS + 1 }, (_, i) => ({
      itemKey: { timesheetId: `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`, siteId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', workAreaId: null, weekStart: '2026-09-21' },
      expectedFingerprint: '4'.repeat(64)
    }));
    const overLimit = validateMassSelection(tooMany);
    check('12: exceeding MAX_MASS_SELECTION_ITEMS is rejected as SELECTION_TOO_LARGE, never silently truncated', !overLimit.ok && overLimit.error.code === 'SELECTION_TOO_LARGE', overLimit.ok ? overLimit.value.length : overLimit.error);

    const mixed = validateMassSelection([a, { ...b, itemKey: { ...b.itemKey, siteId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' } }]);
    check('13: a mixed-customer selection is rejected as MIXED_CUSTOMER_SELECTION', !mixed.ok && mixed.error.code === 'MIXED_CUSTOMER_SELECTION', mixed);

    const unknownField = validateMassSelection([{ ...a, extra: 'nope' }]);
    check('14: an unknown field on a selection item is rejected, never silently ignored', !unknownField.ok && unknownField.error.code === 'VALIDATION_ERROR', unknownField);

    const ok = validateMassSelection([a, b]);
    check('15: a valid, single-customer, duplicate-free selection is accepted', ok.ok && ok.value.length === 2, ok);
  }

  // ---------------------------------------------------------------------------------------------
  // 16. UT6-B-fixup #3/#2 — findFirstMassApprovalProblem (mass-approvals/route.ts) AND
  //     buildMassPreviewItemResult (mass-approval-preview/route.ts) must agree on every item: both
  //     now delegate entirely to lib/reporting/weekly-approval.ts's classifyMassApprovalItemProblem,
  //     the ONE shared classification. classifyIssues() never produces a non-empty blockers array
  //     today (UT6-A-R1 §1 reclassified self-approval/open-shift/open-correction to warnings), so
  //     this exercises a hand-built WeeklyApprovalBatchItemResult[] — no DB, no real blocker fixture
  //     needed — proving the defensive check AND its preview-side consistency, independent of
  //     whether any current code path can actually produce a non-empty blockers array.
  // ---------------------------------------------------------------------------------------------
  {
    const { findFirstMassApprovalProblem } = await import('../app/api/admin/time-ledger/mass-approvals/route');
    const { buildMassPreviewItemResult } = await import('../app/api/admin/time-ledger/mass-approval-preview/route');
    const { classifyMassApprovalItemProblem } = await import('../lib/reporting/weekly-approval');

    const fingerprint = 'c'.repeat(64);
    const itemKey1 = { timesheetId: '11111111-1111-1111-1111-111111111111', siteId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', workAreaId: null, weekStart: '2026-09-21' };
    const itemKey2 = { timesheetId: '22222222-2222-2222-2222-222222222222', siteId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', workAreaId: null, weekStart: '2026-09-21' };
    const baseOkItem = (itemKey: typeof itemKey1, blockers: { code: string; message: string }[], warnings: { code: string; message: string }[] = []) => ({
      itemKey,
      expectedFingerprint: fingerprint,
      ok: true as const,
      matchesExpectedFingerprint: true,
      employeeId: 'emp-1',
      employeeName: 'Worker One',
      employeeNumber: 'W-001',
      siteName: 'Site A',
      workAreaName: null,
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
      blockers,
      warnings,
      eligibility: { canApprove: blockers.length === 0 }
    });

    const allClean = [baseOkItem(itemKey1, []), baseOkItem(itemKey2, [])];
    check('16: no problem found when every item is clean (ok, matching, no blockers)', findFirstMassApprovalProblem(allClean) === undefined, allClean);

    const blockedItem = baseOkItem(itemKey2, [{ code: 'FUTURE_BLOCKER', message: 'A hypothetical future real blocker.' }]);
    const withFutureBlocker = [baseOkItem(itemKey1, []), blockedItem];
    const found = findFirstMassApprovalProblem(withFutureBlocker);
    check('16b: a non-empty blockers array on ANY item is caught even though ok=true and fingerprint matches', found !== undefined && found === withFutureBlocker[1], found);
    check('16c: the caught problem carries the real blocker for the route to report', found !== undefined && 'ok' in found && found.ok && found.blockers[0]?.code === 'FUTURE_BLOCKER', found);

    const withStaleOnly = [baseOkItem(itemKey1, []), { ...baseOkItem(itemKey2, []), matchesExpectedFingerprint: false }];
    const foundStale = findFirstMassApprovalProblem(withStaleOnly);
    check('16d: a stale (non-matching) item is still caught alongside the blocker check, not shadowed by it', foundStale === withStaleOnly[1], foundStale);

    const withNotOk = [baseOkItem(itemKey1, []), { itemKey: itemKey2, expectedFingerprint: fingerprint, ok: false as const, reason: 'SOURCE_ERROR' as const }];
    const foundNotOk = findFirstMassApprovalProblem(withNotOk);
    check('16e: a technical (!ok) problem is still caught first, unaffected by the new blocker check', foundNotOk === withNotOk[1], foundNotOk);

    // -------------------------------------------------------------------------------------------
    // UT6-B-fixup #2 — preview must agree with commit on the SAME blocked item: no token
    // eligibility, outcome TECHNICALLY_BLOCKED, technicalBlocker carries the real blocker. This is
    // the exact bug this fixup closes (preview used to show WILL_APPROVE + issue a token here).
    // -------------------------------------------------------------------------------------------
    check('16f: classifyMassApprovalItemProblem itself reports BLOCKED for the same item commit rejects', classifyMassApprovalItemProblem(blockedItem)?.kind === 'BLOCKED', classifyMassApprovalItemProblem(blockedItem));

    const previewDtoBlocked = buildMassPreviewItemResult(blockedItem);
    check('16g: preview outcome is TECHNICALLY_BLOCKED for a real blocker (not WILL_APPROVE)', previewDtoBlocked.outcome === 'TECHNICALLY_BLOCKED', previewDtoBlocked);
    check('16h: preview technicalBlocker carries the real blocker\'s code/message', previewDtoBlocked.technicalBlocker?.code === 'FUTURE_BLOCKER', previewDtoBlocked.technicalBlocker);
    check('16i: preview and commit agree — the same item that fails findFirstMassApprovalProblem also gets outcome TECHNICALLY_BLOCKED in preview', findFirstMassApprovalProblem([blockedItem]) !== undefined && previewDtoBlocked.outcome === 'TECHNICALLY_BLOCKED', { found: findFirstMassApprovalProblem([blockedItem]), previewOutcome: previewDtoBlocked.outcome });

    // A token-eligibility check exactly as the preview route computes it (`results.every(r =>
    // classifyMassApprovalItemProblem(r) === null)`) must be false whenever ANY item is blocked.
    const wouldIssueTokenWithBlocker = withFutureBlocker.every((r) => classifyMassApprovalItemProblem(r) === null);
    check('16j: token eligibility is false when any item has a real blocker (no token would be issued)', wouldIssueTokenWithBlocker === false, wouldIssueTokenWithBlocker);

    // -------------------------------------------------------------------------------------------
    // A WARNING (not a blocker) must still allow a token and a normal APPROVE outcome — the fix
    // must not have accidentally turned warnings into blockers too.
    // -------------------------------------------------------------------------------------------
    const warningItem = baseOkItem(itemKey1, [], [{ code: 'SELF_APPROVAL_FORBIDDEN', message: 'An admin is approving their own hours.' }]);
    check('16k: classifyMassApprovalItemProblem returns null for a warning-only item (never BLOCKED)', classifyMassApprovalItemProblem(warningItem) === null, classifyMassApprovalItemProblem(warningItem));
    const previewDtoWarning = buildMassPreviewItemResult(warningItem);
    check('16l: preview outcome for a warning-only item is WILL_APPROVE, not TECHNICALLY_BLOCKED', previewDtoWarning.outcome === 'WILL_APPROVE', previewDtoWarning);
    check('16m: preview technicalBlocker is null for a warning-only item', previewDtoWarning.technicalBlocker === null, previewDtoWarning);
    check('16n: preview still surfaces the warning itself in warnings[]', previewDtoWarning.warnings.some((w) => w.code === 'SELF_APPROVAL_FORBIDDEN'), previewDtoWarning.warnings);
    const wouldIssueTokenWithWarningOnly = [warningItem].every((r) => classifyMassApprovalItemProblem(r) === null);
    check('16o: token eligibility stays true for a warning-only selection', wouldIssueTokenWithWarningOnly === true, wouldIssueTokenWithWarningOnly);
    check('16p: commit-side findFirstMassApprovalProblem never catches a warning-only item', findFirstMassApprovalProblem([warningItem]) === undefined, findFirstMassApprovalProblem([warningItem]));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
