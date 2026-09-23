// UI-fix (2026-09-24) — the light admin theme's mass-approve bar, customer-filter combobox,
// mobile filter drawer, and warning/success status text all used colours picked for the dark
// canvas (a hardcoded #0e1420 panel background, --accent-light-as-button-background paired with a
// fixed dark text colour, and #fcd34d/#86efac/#34d399 status text) and had very poor contrast once
// rendered against the default light shell (dark-navy body text on a hardcoded dark panel, or pale
// amber/green text on a near-white surface). Fixed in app/globals.css using the theme's own tokens
// (var(--card)/var(--accent)/var(--white)) plus a [data-theme='light']-scoped override for the
// status-text family, never touching dark-theme colours or app/API/DB behaviour. This is a real
// Chromium check (not just a computed-value probe) that the fix holds — and stays held — across all
// four themes (light, titan-dark, graphite, ocean) and both desktop and mobile, using the actual
// WCAG contrast-ratio formula rather than eyeballing screenshots.
//
// Needs a standalone server (TEST_BASE_URL) started with TIMESHEETS_LEDGER_UI_ENABLED=1, against a
// disposable PostgreSQL 16.

import { randomUUID } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import argon2 from 'argon2';
import { prisma } from '../lib/prisma';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3941';
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const PASSWORD = 'ThemeContrastPassw0rd!23';
const CSRF = 'titanor-time';
const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}

// --- WCAG 2.x relative luminance / contrast ratio, straight from the spec formula. ---
function relLuminance([r, g, b]: [number, number, number]): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relLuminance(a) + 0.05;
  const lb = relLuminance(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}
function parseRgb(css: string | null): [number, number, number] | null {
  if (!css) return null;
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const at = (day: Date, h: number, m = 0) => new Date(day.getTime() + h * 3600_000 + m * 60_000);
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function login(base: string, identifier: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
    body: JSON.stringify({ identifier, password })
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie');
  const match = setCookie?.match(/tt_session=([^;]+)/);
  if (!match) throw new Error('no session cookie');
  return match[1];
}

let adminUserId = '';

async function seed() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const admin = await prisma.user.create({ data: { username: `themecontrast-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'RU', passwordHash, userRoles: { create: { roleId: role.id } } } });
  adminUserId = admin.id;

  const siteA = await prisma.workSite.create({ data: { name: `Contrast-A-${randomUUID().slice(0, 5)}` } });
  const waA = await prisma.workArea.create({ data: { siteId: siteA.id, name: `Contrast-WA-A-${randomUUID().slice(0, 4)}` } });

  async function mkWorker(tag: string) {
    const emp = await prisma.employee.create({ data: { employeeNumber: `CONTRAST-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
    await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
    return emp;
  }
  async function mkAssignment(employeeId: string, siteId: string, workAreaId: string | null) {
    return prisma.siteAssignment.create({ data: { employeeId, siteId, workAreaId, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: admin.id } });
  }

  const monday = new Date(Date.UTC(2041, 0, 6)); // a Monday, far from any other test's fixed calendar slot
  const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: admin.id } });

  const w1 = await mkWorker('Ivan');
  const asg1 = await mkAssignment(w1.id, siteA.id, waA.id);
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: w1.id, expected: true } });
  const ts1 = await prisma.timesheet.create({ data: { employeeId: w1.id, periodId: period.id, status: 'DRAFT' } });
  const draft1 = await prisma.timesheetDraft.create({ data: { timesheetId: ts1.id, employeeId: w1.id } });
  const day1 = await prisma.timesheetDraftDay.create({ data: { draftId: draft1.id, date: monday, dayType: 'WORK', confirmedZero: false } });
  // Plan differs from actual (a "warning" row) so the amber warning-text family actually renders.
  await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft1.id, employeeId: w1.id, date: monday, siteId: siteA.id, sourceAssignmentId: asg1.id, plannedStartAt: at(monday, 7), plannedEndAt: at(monday, 15), plannedBreakMinutes: 30 } });
  await prisma.timesheetDraftSegment.create({ data: { draftDayId: day1.id, draftId: draft1.id, employeeId: w1.id, date: monday, startAt: at(monday, 6, 55), endAt: at(monday, 18, 10), siteId: siteA.id, workAreaId: waA.id, sourceAssignmentId: asg1.id } });

  const { submitWorkerTimesheetCore } = await import('../lib/worker-timesheets');
  const { SubmissionSource } = await import('@prisma/client');
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${w1.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts1.id}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, w1.id, ts1.id, admin.id, randomUUID(), SubmissionSource.MANUAL);
  });

  return { admin, period };
}

type ThemeValue = 'light' | 'titan-dark' | 'graphite' | 'ocean';

async function switchTheme(page: Page, theme: ThemeValue): Promise<void> {
  await page.locator('.admin-theme-trigger').click();
  await page.waitForTimeout(120);
  await page.locator(`[data-theme-option="${theme}"]`).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(250);
  const attr = await page.locator('.admin-modern-shell').getAttribute('data-theme');
  check(`theme switch: data-theme attribute is "${theme}" after choosing it`, attr === theme, attr);
}

async function ensureMassBarPopulated(page: Page): Promise<void> {
  if ((await page.locator('.ledger-mass-bar').count()) > 0) return;
  await page.locator('.ledger-row-summary').first().click().catch(() => {});
  await page.waitForTimeout(200);
  const wwBtn = page.locator('button', { hasText: /Принять всю неделю|Confirm whole week/ }).first();
  if ((await wwBtn.count()) > 0) {
    await wwBtn.click().catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function checkMassBarContrast(page: Page, label: string, minRatio: number): Promise<void> {
  await ensureMassBarPopulated(page);
  const info = await page.evaluate(() => {
    const el = document.querySelector('.ledger-mass-bar');
    if (!el) return null;
    const strong = el.querySelector('strong');
    return { bg: getComputedStyle(el).backgroundColor, text: strong ? getComputedStyle(strong).color : null };
  });
  check(`${label}: .ledger-mass-bar is present with a selection`, info !== null, info);
  if (!info) return;
  const bg = parseRgb(info.bg);
  const text = parseRgb(info.text);
  check(`${label}: mass-bar bg/text colours parsed`, !!bg && !!text, info);
  if (bg && text) {
    const ratio = contrastRatio(bg, text);
    check(`${label}: mass-bar "Выбрано" text vs bar background contrast >= ${minRatio} (got ${ratio.toFixed(2)})`, ratio >= minRatio, { bg, text, ratio });
  }
}

async function checkApproveButtonContrast(page: Page, label: string, minRatio: number): Promise<void> {
  const btn = page.locator('.ledger-approve-button').first();
  if ((await btn.count()) === 0) {
    check(`${label}: at least one .ledger-approve-button present`, false);
    return;
  }
  const info = await btn.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color }));
  const bg = parseRgb(info.bg);
  const text = parseRgb(info.text);
  if (bg && text) {
    const ratio = contrastRatio(bg, text);
    check(`${label}: approve-button text vs background contrast >= ${minRatio} (got ${ratio.toFixed(2)})`, ratio >= minRatio, { bg, text, ratio });
  } else {
    check(`${label}: approve-button colours parsed`, false, info);
  }
}

async function checkComboboxContrast(page: Page, label: string, minRatio: number, viewportWidth: number): Promise<void> {
  if (viewportWidth < 768) {
    const toggle = page.locator('.ledger-filters-toggle');
    if ((await toggle.count()) > 0 && (await toggle.isVisible())) await toggle.click().catch(() => {});
    await page.waitForTimeout(200);
  }
  const input = page.locator('.ledger-combobox input').first();
  await input.click().catch(() => {});
  await input.fill('Contrast').catch(() => {});
  await page.waitForTimeout(300);
  const list = page.locator('.ledger-combobox-list');
  check(`${label}: combobox dropdown opens`, (await list.count()) > 0);
  const info = await page.evaluate(() => {
    const listEl = document.querySelector('.ledger-combobox-list');
    if (!listEl) return null;
    const item = listEl.querySelector('li button');
    return { bg: getComputedStyle(listEl).backgroundColor, text: item ? getComputedStyle(item).color : null };
  });
  const bg = parseRgb(info?.bg ?? null);
  const text = parseRgb(info?.text ?? null);
  if (bg && text) {
    const ratio = contrastRatio(bg, text);
    check(`${label}: combobox item text vs dropdown background contrast >= ${minRatio} (got ${ratio.toFixed(2)})`, ratio >= minRatio, { bg, text, ratio });
  } else {
    check(`${label}: combobox colours parsed`, false, info);
  }
  await input.fill('').catch(() => {});
  if (viewportWidth < 768) {
    const close = page.locator('.ledger-filter-panel-head button').first();
    if ((await close.count()) > 0) await close.click().catch(() => {});
    await page.waitForTimeout(150);
  }
}

async function checkWarningTextContrast(page: Page, label: string, minRatio: number): Promise<void> {
  const warn = page.locator('.ledger-issue-warning').first();
  if ((await warn.count()) === 0) {
    check(`${label}: at least one .ledger-issue-warning present (plan-differs row seeded)`, false);
    return;
  }
  const info = await warn.evaluate((el) => {
    // Several ledger surfaces use a near-transparent rgba(255,255,255,0.0X) "subtle raise" overlay
    // rather than a solid fill — visually it just tints whatever's behind it, so a naive "first
    // non-transparent background" walk stops there and misreads it as opaque. Only stop at a
    // background whose own alpha is high enough to actually BE the effective colour.
    let bgEl: Element | null = el;
    let bg = 'rgb(255, 255, 255)'; // falls back to the page's own base surface if nothing opaque is found
    while (bgEl) {
      const c = getComputedStyle(bgEl).backgroundColor;
      const m = c.match(/rgba?\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+(?:,\s*([\d.]+))?\)/);
      const alpha = m ? (m[1] === undefined ? 1 : Number(m[1])) : 0;
      if (alpha >= 0.5) {
        bg = c;
        break;
      }
      bgEl = bgEl.parentElement;
    }
    return { bg, text: getComputedStyle(el).color };
  });
  const bg = parseRgb(info.bg);
  const text = parseRgb(info.text);
  if (bg && text) {
    const ratio = contrastRatio(bg, text);
    check(`${label}: warning text vs its effective background contrast >= ${minRatio} (got ${ratio.toFixed(2)})`, ratio >= minRatio, { bg, text, ratio });
  } else {
    check(`${label}: warning-text colours parsed`, false, info);
  }
}

async function main(): Promise<void> {
  const fx = await seed();
  const cookie = await login(BASE, (await prisma.user.findUniqueOrThrow({ where: { id: adminUserId } })).username, PASSWORD);

  const browser = await chromium.launch({ headless: true });

  for (const [label, viewport] of [
    ['desktop', DESKTOP],
    ['mobile', MOBILE]
  ] as const) {
    const context = await browser.newContext({ viewport });
    await context.addCookies([{ name: 'tt_session', value: cookie, url: BASE }]);
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto(`${BASE}/admin/timesheets?startDate=${isoDate(fx.period.startDate)}&endDate=${isoDate(fx.period.endDate)}`, { waitUntil: 'networkidle' });

    const initialTheme = await page.locator('.admin-modern-shell').getAttribute('data-theme');
    check(`${label}: default theme is "light" (AdminModernShell always renders a literal data-theme attribute)`, initialTheme === 'light', initialTheme);

    // ---- Light theme — the actually-reported bug (dark bar, invisible text). ----
    await checkMassBarContrast(page, `${label}/light`, AA_NORMAL);
    await checkApproveButtonContrast(page, `${label}/light`, AA_NORMAL);
    await checkComboboxContrast(page, `${label}/light`, AA_NORMAL, viewport.width);
    await checkWarningTextContrast(page, `${label}/light`, AA_LARGE);

    // ---- Every dark theme — must still pass AA, and must not have regressed. ----
    for (const theme of ['titan-dark', 'graphite', 'ocean'] as const) {
      await switchTheme(page, theme);
      await checkMassBarContrast(page, `${label}/${theme}`, AA_NORMAL);
      await checkApproveButtonContrast(page, `${label}/${theme}`, AA_NORMAL);
      await checkComboboxContrast(page, `${label}/${theme}`, AA_NORMAL, viewport.width);
      await checkWarningTextContrast(page, `${label}/${theme}`, AA_LARGE);
    }

    // Back to light for the Summary tab check.
    await switchTheme(page, 'light');
    await page.goto(`${BASE}/admin/timesheets?view=summary&startDate=${isoDate(fx.period.startDate)}&endDate=${isoDate(fx.period.endDate)}`, { waitUntil: 'networkidle' });
    const summaryVisible = await page.locator('.ledger-summary-tab').isVisible().catch(() => false);
    check(`${label}: Сводка tab renders in light theme`, summaryVisible);
    const summaryInfo = await page.evaluate(() => {
      const stat = document.querySelector('.ledger-summary-stat');
      if (!stat) return null;
      return { bg: getComputedStyle(stat).backgroundColor, text: getComputedStyle(stat).color };
    });
    check(`${label}/light: summary stat card readable (has a resolvable text colour)`, summaryInfo !== null && summaryInfo.text.length > 0, summaryInfo);

    check(`${label}: zero console errors across every theme + tab switch above`, consoleErrors.length === 0, consoleErrors.slice(0, 5));

    await context.close();
  }

  await browser.close();

  console.log(JSON.stringify({ pass, fail }));
}

main()
  .then(() => {
    if (fail > 0) process.exit(1);
  })
  .catch((error) => {
    console.error('SCRIPT ERROR', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
