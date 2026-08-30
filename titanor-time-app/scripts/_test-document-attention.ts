// R09.5 — getDocumentAttentionSummary: counts ACTIVE workers whose qualifications are
// EXPIRED / CRITICAL / MISSING required expiry (needsAttention) vs EXPIRING_SOON (soon), a worker
// counted once, "needs attention" outranks "soon", inactive employees excluded. db lane.
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { getDocumentAttentionSummary } from '../lib/document-attention';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

const TODAY = new Date(Date.UTC(2026, 5, 15)); // 2026-06-15
const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

// `covering` = the [startDate, endDate] window covers TODAY. A non-covering (but active) window
// is the simplest way to model "not a current employee" without the inactive-metadata CHECK.
async function worker(tag: string, covering: boolean) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `DA-${tag}-${randomUUID().slice(0, 6)}`, firstName: tag, lastName: 'W' } });
  await prisma.employment.create({
    data: {
      employeeId: emp.id,
      active: true,
      startDate: d(2020, 1, 1),
      endDate: covering ? null : d(2025, 1, 1)
    }
  });
  return emp.id;
}

async function qual(employeeId: string, code: string, expiresOn: Date | null) {
  const def = await prisma.qualificationDefinition.findUniqueOrThrow({ where: { code } });
  await prisma.employeeQualification.create({
    data: { employeeId, definitionId: def.id, name: code, expiresOn }
  });
}

async function main() {
  const A = await worker('A', true); await qual(A, 'IWE_EWE', d(2026, 6, 10)); // EXPIRED (days -5)
  const B = await worker('B', true); await qual(B, 'IWE_EWE', d(2026, 6, 20)); // CRITICAL (days 5)
  const C = await worker('C', true); await qual(C, 'IWE_EWE', d(2026, 7, 30)); // EXPIRING_SOON (days 45)
  const D = await worker('D', true); await qual(D, 'OCCUPATIONAL_SAFETY_CARD', null); // MISSING_EXPIRY (REQUIRED)
  const E = await worker('E', true); await qual(E, 'IWE_EWE', d(2027, 6, 15)); // VALID (days 365)
  const F = await worker('F', false); await qual(F, 'IWE_EWE', d(2026, 6, 10)); // EXPIRED but inactive -> excluded
  const G = await worker('G', true); await qual(G, 'IWE_EWE', d(2026, 6, 1)); await qual(G, 'IWE_EWE', d(2026, 7, 20)); // EXPIRED + SOON -> needsAttention only
  const H = await worker('H', true); await qual(H, 'EN_1090', null); // NONE + no expiry -> VALID, ignored

  const s = await getDocumentAttentionSummary(TODAY);
  check('needsAttention counts A, B, D, G (= 4)', s.workersNeedingAttention === 4, s);
  check('expiringSoon counts C only (= 1)', s.workersExpiringSoon === 1, s);
  void [E, F, H];

  // remove the flagged workers' quals -> both counts drop to 0
  await prisma.employeeQualification.deleteMany({ where: { employeeId: { in: [A, B, C, D, G] } } });
  const s2 = await getDocumentAttentionSummary(TODAY);
  check('after cleanup: both 0', s2.workersNeedingAttention === 0 && s2.workersExpiringSoon === 0, s2);

  console.log(`\nPASS: ${pass}/${pass + fail}`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
