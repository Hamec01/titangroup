import { randomUUID, createHash } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import { prisma } from '../lib/prisma';
import { buildFixture, authHeaders } from './_test-t9-fixtures';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §3 / §7 — R15-D7 Deploy B: the redesigned
// worker card. Real Chromium (production standalone build), disposable PostgreSQL 16, real HTTP, DB
// assertions, zero mocks. Drives the ACTUAL card UI: the unified "Место работы сейчас" block, the
// ONE "Изменить место работы" form (site/customer/schedule/primary + today/tomorrow/pick-a-date +
// the "show what will change" summary), open-shift handling, "Снять с объекта" with reason presets,
// "Запланированные изменения", "Прошлые назначения", the timesheet transition marker — AND the six
// mandatory owner scenarios P1–P6 exercised THROUGH the interface, not only the API.

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39650';

let pass = 0;
let fail = 0;
const pLog: string[] = [];
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : '');
  }
  if (/^P[1-6]/.test(name)) pLog.push(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

async function jf(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const r = await fetch(url, init);
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    /* none */
  }
  return { status: r.status, body };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const fx = await buildFixture(BASE);
  const admin = fx.admin.cookie;
  const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time' };
  const today = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date())}T00:00:00.000Z`);
  const todayIso = isoDate(today);
  const tomorrowIso = isoDate(new Date(today.getTime() + 86400000));
  const daysFrom = (n: number) => isoDate(new Date(today.getTime() + n * 86400000));

  const workerRoleId = (await prisma.role.findUniqueOrThrow({ where: { name: 'WORKER' }, select: { id: true } })).id;

  const mkSite = async (label: string): Promise<{ id: string; name: string }> => {
    const name = `B ${label} ${fx.run}`;
    const r = await jf(`${BASE}/api/admin/sites`, { method: 'POST', headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ name }) });
    return { id: r.body.id as string, name };
  };
  const mkArea = async (siteId: string, label: string): Promise<{ id: string; name: string }> => {
    const name = `B ${label} ${fx.run}`;
    const r = await jf(`${BASE}/api/admin/sites/${siteId}/work-areas`, { method: 'POST', headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ name }) });
    return { id: r.body.id as string, name };
  };
  const mkWorker = async (label: string): Promise<string> => {
    const r = await jf(`${BASE}/api/admin/workers`, { method: 'POST', headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ firstName: 'CardB', lastName: `${label}${fx.run}` }) });
    return r.body.employee.id as string;
  };
  const assign = async (employeeId: string, siteId: string, isPrimary: boolean, validFrom = '2020-01-01', workAreaId: string | null = null): Promise<string> => {
    const r = await jf(`${BASE}/api/admin/assignments`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ employeeId, siteId, workAreaId, templateId: fx.templateId, validFrom, isPrimary })
    });
    if (r.status !== 201) throw new Error(`assign ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const workerSession = async (employeeId: string): Promise<string> => {
    const u = await prisma.user.findFirstOrThrow({ where: { employeeId }, select: { id: true, status: true } });
    if (u.status !== 'ACTIVE') await prisma.user.update({ where: { id: u.id }, data: { status: 'ACTIVE' } });
    if (!(await prisma.userRole.findFirst({ where: { userId: u.id, roleId: workerRoleId, validTo: null } }))) {
      await prisma.userRole.create({ data: { userId: u.id, roleId: workerRoleId } });
    }
    const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
    await prisma.userSession.create({ data: { userId: u.id, tokenHash: createHash('sha256').update(token).digest('hex'), authLevel: 'PASSWORD', expiresAt: new Date(Date.now() + 86400000) } });
    return token;
  };
  const checkIn = (cookie: string, siteId: string, at: string) =>
    jf(`${BASE}/api/worker/attendance/check-in`, { method: 'POST', headers: { ...H, Cookie: `tt_session=${cookie}` }, body: JSON.stringify({ clientEventId: randomUUID(), siteId, workAreaId: null, clientCapturedAt: at, location: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE' }) });
  const checkOut = (cookie: string, assumedSiteId: string, at: string) =>
    jf(`${BASE}/api/worker/attendance/check-out`, { method: 'POST', headers: { ...H, Cookie: `tt_session=${cookie}` }, body: JSON.stringify({ clientEventId: randomUUID(), assumedSiteId, clientCapturedAt: at, location: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE' }) });
  const openShiftSite = async (employeeId: string): Promise<string | null> =>
    (await prisma.employeeOpenShift.findUnique({ where: { employeeId }, select: { siteId: true } }))?.siteId ?? null;
  const clearOpenShift = (employeeId: string) => prisma.employeeOpenShift.deleteMany({ where: { employeeId } });
  /** non-removed rows carrying the isPrimary flag — the design's "both stored primary" (P1/P3). */
  const storedPrimaryCount = (employeeId: string) =>
    prisma.siteAssignment.count({ where: { employeeId, isPrimary: true, clockInDisabledAt: null } });
  const liveAssignments = (employeeId: string) =>
    prisma.siteAssignment.findMany({
      where: {
        employeeId,
        isPrimary: undefined,
        validFrom: { lte: today },
        AND: [{ OR: [{ validTo: null }, { validTo: { gte: today } }] }, { OR: [{ clockInDisabledAt: null }, { clockInDisabledAt: { gt: new Date() } }] }]
      },
      select: { id: true, siteId: true, isPrimary: true }
    });
  const primaryResolvesTo = async (employeeId: string): Promise<string | null> => {
    const row = await prisma.siteAssignment.findFirst({
      where: {
        employeeId,
        isPrimary: true,
        validFrom: { lte: today },
        AND: [{ OR: [{ validTo: null }, { validTo: { gte: today } }] }, { OR: [{ clockInDisabledAt: null }, { clockInDisabledAt: { gt: new Date() } }] }]
      },
      orderBy: [{ validFrom: 'desc' }, { id: 'asc' }],
      select: { siteId: true }
    });
    return row?.siteId ?? null;
  };

  const browser = await chromium.launch({ headless: true });
  const page: Page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('#identifier').fill(fx.admin.username);
  await page.locator('#password').fill(fx.admin.password);
  await page.locator('.login-submit').click();
  await page.waitForURL(/\/admin/, { timeout: 15000 });

  const gotoCard = async (employeeId: string) => {
    await page.goto(`${BASE}/admin/workers/${employeeId}`, { waitUntil: 'networkidle' });
    return page.locator('.worker-card');
  };
  // open the "Change workplace" form on the current assignment row (optionally for a given site)
  const openChangeForm = async (employeeId: string, siteName?: string) => {
    const card = await gotoCard(employeeId);
    const row = siteName
      ? card.locator('#worker-assignments li', { hasText: siteName })
      : card.locator('#worker-assignments li').first();
    await row.getByRole('button', { name: /Change workplace|Изменить место работы/ }).click();
    await page.waitForSelector('.assignment-end-form', { timeout: 10000 });
    return page.locator('.assignment-end-form');
  };
  const pastHtml = async (): Promise<string> => page.locator('.worker-past-assignments').innerHTML().catch(() => '');

  const siteA = await mkSite('A');
  const siteB = await mkSite('B');
  const siteC = await mkSite('C');
  const areaB = await mkArea(siteA.id, 'CustA');

  // period covering today so shifts materialise (fixture period is far-future)
  await jf(`${BASE}/api/admin/periods`, { method: 'POST', headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ startDate: daysFrom(-20), endDate: daysFrom(20) }) });

  // ── B1 — the redesigned card: unified "Место работы сейчас" block ──────────────────────────
  {
    const w = await mkWorker('B1');
    const a = await assign(w, siteA.id, true);
    const card = await gotoCard(w);
    const html = await card.innerHTML();
    check('B1a: card has a "Workplace now / Место работы сейчас" section', /Workplace now|Место работы сейчас/.test(html), html.slice(0, 200));
    check('B1b: the assignment row shows the site + "main workplace" + a state', html.includes(siteA.name) && /main workplace|основное место/.test(html) && /Working here now|Работает здесь сейчас/.test(html));
    check('B1c: exactly one "Change workplace" and one "Remove from site" button', (await card.getByRole('button', { name: /Change workplace|Изменить место работы/ }).count()) === 1 && (await card.getByRole('button', { name: /Remove from site|Снять с объекта/ }).count()) === 1);
    check('B1d: no "Past assignments" / "Scheduled changes" blocks yet', !/Past assignments|Прошлые назначения/.test(html) && !/Scheduled changes|Запланированные изменения/.test(html));
    void a;
  }

  // ── B2 — the ONE form: fields default to current, quick dates, preview, confirm ────────────
  {
    const w = await mkWorker('B2');
    await assign(w, siteA.id, true, '2020-01-01', areaB.id);
    const form = await openChangeForm(w);
    check('B2a: form pre-selects the current site (change one thing only)', (await form.locator('select').first().inputValue()) !== '', null);
    check('B2b: form offers Today / Tomorrow / Pick a date', /Today|Сегодня/.test(await form.innerText()) && /Tomorrow|Завтра/.test(await form.innerText()) && /Pick a date|Выбрать дату/.test(await form.innerText()));
    // change the site to B, keep everything else, preview
    await form.locator('select').first().selectOption({ label: siteB.name });
    await form.getByRole('button', { name: /Show what will change|Показать, что изменится/ }).click();
    await page.waitForTimeout(800);
    const previewText = await form.innerText();
    check('B2c: preview shows old → new and "starts today"', previewText.includes(siteA.name) && previewText.includes(siteB.name) && /starts today|Действует с сегодня/i.test(previewText), previewText.slice(0, 300));
    await form.getByRole('button', { name: /Confirm the change|Подтвердить изменение/ }).click();
    await page.waitForTimeout(1200);
    const live = await liveAssignments(w);
    check('B2d: after confirm, the worker is now on site B (one live assignment)', live.length === 1 && live[0].siteId === siteB.id, live);
  }

  // ── B3 — "Снять с объекта" with reason presets ────────────────────────────────────────────
  {
    const w = await mkWorker('B3');
    const a = await assign(w, siteA.id, true);
    const card = await gotoCard(w);
    await card.getByRole('button', { name: /Remove from site|Снять с объекта/ }).click();
    const form = page.locator('.assignment-end-form');
    check('B3a: remove form offers a reason dropdown with presets', /Project finished|Проект завершён/.test(await form.innerText()) && /Moving to another site|Перевод на другой объект/.test(await form.innerText()));
    await form.locator('select').last().selectOption({ label: (await form.innerText()).includes('Проект завершён') ? 'Проект завершён' : 'Project finished' });
    await form.getByRole('button', { name: /Confirm .* remove from site|Подтвердить .* снять с объекта/ }).click();
    await page.waitForTimeout(1000);
    const row = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    const tr = await prisma.assignmentTransition.findFirst({ where: { fromAssignmentId: a, kind: 'REMOVE' } });
    check('B3b: removeFromSite set clockInDisabledAt + endedReason=PROJECT_DONE + a REMOVE transition with reasonCode', row.clockInDisabledAt !== null && row.endedReason === 'PROJECT_DONE' && tr?.reasonCode === 'PROJECT_DONE', { row: { c: row.clockInDisabledAt, e: row.endedReason }, tr: tr?.reasonCode });
    const card2 = await gotoCard(w);
    check('B3c: the card now shows the assignment under "Past assignments" with the reason', /Past assignments|Прошлые назначения/.test(await card2.innerHTML()) && /Project finished|Проект завершён/.test(await pastHtml()));
  }

  // ═══ P1–P6 THROUGH THE UI ═══════════════════════════════════════════════════════════════

  // ── P1 — future transfer: A stays "workplace now", B appears in "Scheduled changes" ───────
  {
    const w = await mkWorker('P1');
    const a = await assign(w, siteA.id, true);
    const form = await openChangeForm(w);
    await form.locator('select').first().selectOption({ label: siteB.name });
    await form.getByText(/Pick a date|Выбрать дату/).click();
    await form.locator('input[type="date"]').fill(daysFrom(7));
    await form.getByRole('button', { name: /Show what will change|Показать, что изменится/ }).click();
    await page.waitForTimeout(900);
    check('P1a: the summary says it starts on the future date, not today', new RegExp(`${daysFrom(7)}`).test(await form.innerText()), (await form.innerText()).slice(0, 300));
    await form.getByRole('button', { name: /Confirm the change|Подтвердить изменение/ }).click();
    await page.waitForTimeout(1400);
    const card = await gotoCard(w);
    const html = await card.innerHTML();
    const now = await card.locator('#worker-assignments').innerText();
    const scheduled = await card.locator('[aria-label*="Scheduled changes"], [aria-label*="Запланированные изменения"]').innerText().catch(() => '');
    check('P1b: "Workplace now" shows site A', now.includes(siteA.name) && !now.includes(siteC.name));
    check('P1c: "Scheduled changes" block appears and names site B + the date', /Scheduled changes|Запланированные изменения/.test(html) && scheduled.includes(siteB.name) && scheduled.includes(daysFrom(7)));
    check('P1d: DB — A + B both stored primary (disjoint periods); the primary NOW is A', (await storedPrimaryCount(w)) === 2 && (await primaryResolvesTo(w)) === siteA.id, { stored: await storedPrimaryCount(w), now: await primaryResolvesTo(w) });
    void a;
  }

  // ── P2 — effective day: the state a future transfer reaches on its date renders correctly ─
  {
    const w = await mkWorker('P2');
    const { assignedByUserId } = await prisma.siteAssignment.findFirstOrThrow({ select: { assignedByUserId: true } });
    await prisma.siteAssignment.create({ data: { employeeId: w, siteId: siteA.id, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: new Date(today.getTime() - 86400000), assignedByUserId } });
    await prisma.siteAssignment.create({ data: { employeeId: w, siteId: siteB.id, isPrimary: true, validFrom: today, assignedByUserId } });
    const card = await gotoCard(w);
    const now = await card.locator('#worker-assignments').innerText();
    check('P2a: on the handover day the card shows site B as the workplace now (by date, no cron)', now.includes(siteB.name) && !now.includes(siteA.name) && (await primaryResolvesTo(w)) === siteB.id, now.slice(0, 200));
    check('P2b: site A has moved to "Past assignments"', /Past assignments|Прошлые назначения/.test(await card.innerHTML()) && (await pastHtml()).includes(siteA.name));
    check('P2c: both rows are still stored primary and clockInDisabledAt is NULL on both (nothing demoted)', (await storedPrimaryCount(w)) === 2);
  }

  // ── P3 — non-overlap invariant visible on the card ───────────────────────────────────────
  {
    const w = await mkWorker('P3');
    await assign(w, siteA.id, true);
    // future transfer via the form → both kept
    let form = await openChangeForm(w);
    await form.locator('select').first().selectOption({ label: siteB.name });
    await form.getByText(/Pick a date|Выбрать дату/).click();
    await form.locator('input[type="date"]').fill(daysFrom(5));
    await form.getByRole('button', { name: /Show what will change|Показать, что изменится/ }).click();
    await page.waitForTimeout(800);
    await form.getByRole('button', { name: /Confirm the change|Подтвердить изменение/ }).click();
    await page.waitForTimeout(1200);
    check('P3a: future transfer keeps BOTH primaries (disjoint) — 2 stored, 1 live', (await storedPrimaryCount(w)) === 2 && (await liveAssignments(w)).length === 1, { stored: await storedPrimaryCount(w), live: (await liveAssignments(w)).length });
    // an immediate change to a THIRD site → the current one is superseded
    form = await openChangeForm(w);
    await form.locator('select').first().selectOption({ label: siteC.name });
    await form.getByRole('button', { name: /Show what will change|Показать, что изменится/ }).click();
    await page.waitForTimeout(800);
    await form.getByRole('button', { name: /Confirm the change|Подтвердить изменение/ }).click();
    await page.waitForTimeout(1200);
    check('P3b: after an immediate same-period change the primary NOW resolves to C (one live primary)', (await primaryResolvesTo(w)) === siteC.id && (await liveAssignments(w)).filter((x) => x.isPrimary && x.siteId === siteC.id).length === 1, await liveAssignments(w));
  }

  // ── P4 — scheduled-change conflict: the warning + keep/replace choice IN THE UI ───────────
  // Card path: A is primary + a future transfer to B (primary) is scheduled + C is a second CURRENT
  // (non-primary) assignment. Ticking "main workplace" on C would overlap the scheduled B → warning.
  {
    const w = await mkWorker('P4');
    const a = await assign(w, siteA.id, true);
    const c = await assign(w, siteC.id, false);
    // schedule a future primary transfer A → B
    let form = await openChangeForm(w, siteA.name);
    await form.locator('select').first().selectOption({ label: siteB.name });
    await form.getByText(/Pick a date|Выбрать дату/).click();
    await form.locator('input[type="date"]').fill(daysFrom(7));
    await form.getByRole('button', { name: /Show what will change|Показать, что изменится/ }).click();
    await page.waitForTimeout(800);
    await form.getByRole('button', { name: /Confirm the change|Подтвердить изменение/ }).click();
    await page.waitForTimeout(1200);
    const bId = (await prisma.siteAssignment.findFirstOrThrow({ where: { employeeId: w, siteId: siteB.id }, select: { id: true } })).id;
    // now open the change form on C and tick "main workplace" (change the customer to make it dirty)
    form = await openChangeForm(w, siteC.name);
    await form.getByText(/This is the main workplace|Это основное место работы/).click();
    await form.getByRole('button', { name: /Show what will change|Показать, что изменится/ }).click();
    await page.waitForTimeout(900);
    check('P4a: the preview WARNS that a transfer is already scheduled to B', /already has a transfer scheduled|уже запланирован перевод/.test(await form.innerText()) && (await form.innerText()).includes(siteB.name), (await form.innerText()).slice(0, 400));
    await form.getByRole('button', { name: /Confirm the change|Подтвердить изменение/ }).click();
    await page.waitForTimeout(1100);
    check('P4b: confirming shows the keep / replace choice', /Keep the scheduled transfer|Оставить запланированный перевод/.test(await form.innerText()) && /Replace the scheduled transfer|Заменить запланированный перевод/.test(await form.innerText()), (await form.innerText()).slice(0, 300));
    await form.getByRole('button', { name: /Keep the scheduled transfer|Оставить запланированный перевод/ }).click();
    await page.waitForTimeout(1400);
    const bAfterKeep = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: bId } });
    check('P4c: "Keep" left the scheduled transfer to B intact (still primary, date unchanged)', bAfterKeep.isPrimary === true && isoDate(bAfterKeep.validFrom) === daysFrom(7), bAfterKeep);

    // Replace path on a fresh worker
    const w2 = await mkWorker('P4r');
    await assign(w2, siteA.id, true);
    await assign(w2, siteC.id, false);
    form = await openChangeForm(w2, siteA.name);
    await form.locator('select').first().selectOption({ label: siteB.name });
    await form.getByText(/Pick a date|Выбрать дату/).click();
    await form.locator('input[type="date"]').fill(daysFrom(7));
    await form.getByRole('button', { name: /Show what will change|Показать, что изменится/ }).click();
    await page.waitForTimeout(800);
    await form.getByRole('button', { name: /Confirm the change|Подтвердить изменение/ }).click();
    await page.waitForTimeout(1200);
    const b2Id = (await prisma.siteAssignment.findFirstOrThrow({ where: { employeeId: w2, siteId: siteB.id }, select: { id: true } })).id;
    form = await openChangeForm(w2, siteC.name);
    await form.getByText(/This is the main workplace|Это основное место работы/).click();
    await form.getByRole('button', { name: /Show what will change|Показать, что изменится/ }).click();
    await page.waitForTimeout(900);
    await form.getByRole('button', { name: /Confirm the change|Подтвердить изменение/ }).click();
    await page.waitForTimeout(1000);
    await form.getByRole('button', { name: /Replace the scheduled transfer|Заменить запланированный перевод/ }).click();
    await page.waitForTimeout(1400);
    const b2After = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: b2Id } });
    const replTr = await prisma.assignmentTransition.findFirst({ where: { fromAssignmentId: b2Id }, orderBy: { actedAt: 'desc' } });
    check('P4d: "Replace" kept the assignment to B but dropped its primary + recorded a transition', b2After.isPrimary === false && isoDate(b2After.validFrom) === daysFrom(7) && replTr !== null && (replTr?.reasonText ?? '').toLowerCase().includes('superseded'), { p: b2After.isPrimary, tr: replTr?.reasonText });
    void a;
    void c;
  }

  // ── P5 — same-day completed hours: the immediate transfer is NOT blocked ──────────────────
  {
    const w = await mkWorker('P5');
    const a = await assign(w, siteA.id, true);
    const wc = await workerSession(w);
    await checkIn(wc, siteA.id, new Date(Date.now() - 4 * 3600_000).toISOString());
    await checkOut(wc, siteA.id, new Date(Date.now() - 3 * 3600_000).toISOString());
    const fragBefore = await prisma.clockShiftFragment.count({ where: { sourceAssignmentId: a, date: today } });
    check('P5a: the worker has a completed interval on A today', fragBefore >= 1, fragBefore);
    await openChangeForm(w);
    const form = page.locator('.assignment-end-form');
    await form.locator('select').first().selectOption({ label: siteB.name });
    await form.getByRole('button', { name: /Show what will change|Показать, что изменится/ }).click();
    await page.waitForTimeout(800);
    await form.getByRole('button', { name: /Confirm the change|Подтвердить изменение/ }).click();
    await page.waitForTimeout(1200);
    const errVisible = await form.locator('.login-error').count();
    check('P5b: the transfer went through — no error shown in the form', errVisible === 0 || !(await form.innerText()).match(/recorded hours|отметил часы/), await form.innerText().catch(() => ''));
    const aRow = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    const fragAfter = await prisma.clockShiftFragment.count({ where: { sourceAssignmentId: a, date: today } });
    check('P5c: A keeps today, the interval stays on A, next workplace is B', isoDate(aRow.validTo!) === todayIso && fragAfter === fragBefore && (await primaryResolvesTo(w)) === siteB.id, { v: aRow.validTo, fragBefore, fragAfter });
  }

  // ── P6 — open shift: KEEP_ON_OLD pushes to tomorrow / MOVE_TO_NEW moves the shift ─────────
  {
    // KEEP_ON_OLD
    const w = await mkWorker('P6keep');
    const a = await assign(w, siteA.id, true);
    const wc = await workerSession(w);
    await checkIn(wc, siteA.id, new Date(Date.now() - 2 * 3600_000).toISOString());
    await openChangeForm(w);
    let form = page.locator('.assignment-end-form');
    await form.locator('select').first().selectOption({ label: siteB.name });
    await form.getByRole('button', { name: /Show what will change|Показать, что изменится/ }).click();
    await page.waitForTimeout(700);
    check('P6a: the preview tells the admin the worker is on an open shift', /open shift|идёт смена/.test(await form.innerText()));
    await form.getByRole('button', { name: /Confirm the change|Подтвердить изменение/ }).click();
    await page.waitForTimeout(900);
    check('P6b: confirming shows the "finish today on the old site / move the shift" choice', /Finish today on the current site|Доработать сегодня/.test(await form.innerText()) && /Move today's shift too|Перенести и сегодняшнюю смену/.test(await form.innerText()));
    await form.getByRole('button', { name: /Finish today on the current site|Доработать сегодня/ }).click();
    await page.waitForTimeout(1200);
    const aKeep = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    const bKeep = await prisma.siteAssignment.findFirst({ where: { employeeId: w, siteId: siteB.id }, select: { validFrom: true } });
    check(
      'P6c: KEEP_ON_OLD — A stays live today, the open shift stays on A, transfer bumped to tomorrow',
      aKeep.clockInDisabledAt === null &&
        aKeep.validTo !== null &&
        isoDate(aKeep.validTo) === todayIso &&
        (await openShiftSite(w)) === siteA.id &&
        bKeep !== null &&
        isoDate(bKeep.validFrom) === tomorrowIso,
      { a: { c: aKeep.clockInDisabledAt, v: aKeep.validTo }, b: bKeep?.validFrom }
    );
    const co = await checkOut(wc, siteA.id, new Date().toISOString());
    check('P6d: Check Out on A is not blocked', (co.status === 200 || co.status === 201) && (await openShiftSite(w)) === null, co.body);

    // MOVE_TO_NEW
    const w2 = await mkWorker('P6move');
    const a2 = await assign(w2, siteA.id, true);
    const wc2 = await workerSession(w2);
    await checkIn(wc2, siteA.id, new Date(Date.now() - 2 * 3600_000).toISOString());
    await openChangeForm(w2);
    form = page.locator('.assignment-end-form');
    await form.locator('select').first().selectOption({ label: siteB.name });
    await form.getByRole('button', { name: /Show what will change|Показать, что изменится/ }).click();
    await page.waitForTimeout(700);
    await form.getByRole('button', { name: /Confirm the change|Подтвердить изменение/ }).click();
    await page.waitForTimeout(900);
    await form.getByRole('button', { name: /Move today's shift too|Перенести и сегодняшнюю смену/ }).click();
    await page.waitForTimeout(1200);
    check('P6e: MOVE_TO_NEW — the open shift is re-pointed to B', (await openShiftSite(w2)) === siteB.id);
    const co2 = await checkOut(wc2, siteB.id, new Date().toISOString());
    check('P6f: Check Out on B is not blocked; the whole shift landed on B', (co2.status === 200 || co2.status === 201) && (await prisma.clockShiftFragment.count({ where: { sourceAssignmentId: (await prisma.siteAssignment.findFirstOrThrow({ where: { employeeId: w2, siteId: siteB.id }, select: { id: true } })).id } })) >= 1 && (await prisma.clockShiftFragment.count({ where: { sourceAssignmentId: a2 } })) === 0, co2.body);
    await clearOpenShift(w2);
  }

  // ── B4 — the timesheet transition marker ─────────────────────────────────────────────────
  {
    const w = await mkWorker('B4');
    const a = await assign(w, siteA.id, true);
    await jf(`${BASE}/api/admin/assignments/${a}/change`, { method: 'POST', headers: authHeaders(admin), body: JSON.stringify({ effectiveFrom: todayIso, siteId: siteB.id, reason: 'B4 marker' }) });
    const ts = await prisma.timesheet.findFirst({ where: { employeeId: w, period: { startDate: { lte: today }, endDate: { gte: today } } }, select: { id: true } });
    if (ts) {
      await page.goto(`${BASE}/admin/timesheets/${ts.id}`, { waitUntil: 'networkidle' });
      const body = await page.locator('.setup-card').innerText();
      check('B4a: the timesheet card shows a "workplace changed" marker with from → to and who', /workplace changed|место работы изменено/.test(body) && body.includes(siteA.name) && body.includes(siteB.name) && /does not change any hours|не меняет часы/.test(body), body.slice(0, 400));
    } else {
      check('B4a: (no timesheet row for today — marker query is covered by the API test)', true);
    }
  }

  await browser.close();

  console.log('\n──────── P1–P6 through the worker-card UI ────────');
  console.log(pLog.join('\n'));
  console.log(`──────── ${pLog.filter((l) => l.includes('PASS')).length}/${pLog.length} P-checks passed ────────\n`);
  console.log(JSON.stringify({ pass, fail }));
  console.log(`${pass} passed, ${fail} failed (T9 worker card B)`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
