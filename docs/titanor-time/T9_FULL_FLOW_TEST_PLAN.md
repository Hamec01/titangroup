# Titanor Time — T9.4 Full End-to-End Flow Test Plan (2026-08-20)

Written BEFORE the test code, per this task's own design-checkpoint requirement. Base commit
`3f06f62 fix(time): harden setup lifecycle flows`. Revised before the first execution after the
owner clarified the business rule: a `FOREMAN` is an optional site-authorized reviewer, never a
mandatory link in the approval chain. Scope: prove the single, complete business workflow (admin
setup → worker clock + submit → admin fallback return → worker correct + resubmit → admin fallback
scope approval → admin final-approve → reports agree) end to end, through a real browser and real
PostgreSQL — not a new feature. T9.5 (restart), T9.6 (backup/restore), T9.7 (physical devices) are
explicitly out of scope for this document and this task.

## 1. Roles and users

One fixture run creates exactly:

- `SUPER_ADMIN` — bootstrap (the only accepted way to create the very first account; unchanged
  convention from T9.1–T9.3).
- One `ADMIN` — created the same way T9.1–T9.3's fixture created its test `ADMIN` (no
  `user.create.admin` route exists yet, documented gap, not this task's to fix).
- One optional `FOREMAN` (standalone) — created and activated only to prove that an unassigned
  site-authorized reviewer cannot see or act on the site's review scope. This account is deliberately
  **not** assigned to the fixture site and never participates in the happy path.
- One `WORKER` — created via `POST /api/admin/workers`, activated through the real worker
  activation flow (`GET /api/auth/activate` + `POST /api/auth/set-initial-password`).

No dual-role user, no second worker, no second site — T9.1–T9.3 already proved multi-entity/second-
record behavior; this slice proves the *single* real workflow end to end, so the fixture is
deliberately minimal (task's own instruction: don't reuse T9.1–T9.3's fixture, keep this run's data
isolated and repeatable).

## 2. Fixture and dates

Every business entity is created through real HTTP against the real API — the same primitives
T9.1–T9.3's `_test-t9-fixtures.ts` already established (`buildFixture`-style flow), but this task
gets its own smaller, dedicated fixture (`scripts/_test-t9-full-flow.ts` builds it inline — not
imported from T9.1–T9.3's module, since that module's shape (3 sites, 2 workers, dual-role) doesn't
match this task's single-worker/single-site scenario and forcing a shared abstraction across two
very different shapes would be premature).

- One `WorkSite` ("Flowsite <run>").
- One `WorkArea` on it ("Zone <run>").
- One `WorkSiteGeofenceVersion`, centered on a fixed coordinate pair that Playwright's
  `context.setGeolocation()` will report exactly (radius large enough that floating-point rounding
  can't push a same-point reading outside it — 150 m, the project's own established default).
- One `WorkScheduleTemplate` (standard Mon–Fri 09:00–17:00, 30 min break — content is irrelevant to
  this task's assertions since the worker's actual day is entered by hand through the editor, not
  auto-generated from the template).
- One `SiteAssignment`: WORKER → the site, `isPrimary: true`, `validFrom` fixed at a real past date
  (2020-01-01, open-ended) — established convention so `GET /attendance/context`'s real-"today"
  filter and the Check In flow both see a current assignment regardless of what payroll-period year
  is used.
- **No `ForemanAssignment` for the fixture site.** This is the key owner requirement: the company
  must complete the whole period without requiring a foreman account or foreman action.
- One `PayrollPeriod`, `OPEN`, **covering the real current Helsinki calendar day** (unlike T9.1–T9.3
  and older sessions' far-future-year convention) — this task's own scenario needs "today" to
  actually fall inside the period, since Check In/Out and the day editor both operate on real
  "today" throughout. Range: Helsinki-today through Helsinki-today+13 (a normal two-week period).
- Both accounts activated for real login before the browser scenario starts.

Usernames/site/template names are suffixed with a fresh `randomUUID().slice(0,6)` per run — no
fixed names reused across runs, matching the task's explicit isolation/repeatability requirement.

## 3. Full UI action order (what the browser actually does)

Three separate `browser.newContext()` instances (never one shared context) — ADMIN, WORKER and the
optional unassigned FOREMAN — so cookies/sessions never cross. Only ADMIN and WORKER participate in
the happy path.

**A. ADMIN setup** — via `/login`, then `POST` calls the ADMIN performs are exercised through real
UI forms exactly as T9.1–T9.3 already proved works (site/work-area/geofence/template/worker/
assignment/period creation, worker activation-code issuance) — this task does not
re-litigate "does the create form work", it reuses the already-proven UI paths to build the fixture,
then focuses its own new assertions on steps B–G below. Reload-durability and double-click-safety
for these forms were already proven exhaustively in T9.1–T9.3 (`_test-t9-setup-lifecycle.ts`
scenarios 3–13) — not re-proven here to avoid duplicating that suite; this task's fixture creation
IS itself a live re-exercise of those same code paths on fresh data, which is already meaningful
coverage without repeating every individual assertion.

**B. WORKER — first version.** Separate browser context, `/login` → `/worker`. Confirm the
assigned site appears in the check-in radio group. `context.grantPermissions(['geolocation'])` +
`context.setGeolocation()` set to the fixture's own geofence center *before* the check-in click —
Playwright's mocked `navigator.geolocation.getCurrentPosition` feeds `lib/worker-gps.ts`'s
`captureGpsSnapshot()` exactly like a real device would. Click **Check in** → this enqueues into the
offline outbox and syncs immediately (online) via `POST /api/worker/attendance/sync` — the actual
online endpoints `/check-in`/`/check-out` are bypassed by design (`WorkerClockPanel.tsx`'s own
header comment, T7A.7B) — DB assertions target `ClockEvent`/`EmployeeOpenShift` directly. Click
**Check out** shortly after → `ClockShift`/materialization. Then `/worker/periods/[periodId]/hours`,
click into **today's date**, enter one segment **08:00–16:00** with one **unpaid** break
**12:00–12:30** via the real `DayEditor` (`.wk-time-row`/`.wk-break-row` time inputs, `+ Add break`),
**Save**, reload, confirm persisted. Then `/worker/periods/[periodId]/submit`, **Submit timesheet**.

Expected worked time for this day, per the canonical formula (`lib/reporting/worked-time.ts`):
`gross = 16:00-08:00 = 480 min`, `unpaidBreakMs = 30 min`, **`workedMs = 450 min`**.

**C. ADMIN fallback — return.** The ADMIN context opens `/admin/review-scopes`, finds the SITE scope
without any `ForemanAssignment`, opens it and selects **Return to worker** with reason `"Break
duration needs correction <run>"`. This proves that foreman participation is optional in the real
UI, not merely possible via a hidden API.

**D. WORKER — correction.** Same worker context, reload `/worker/periods/[periodId]`, confirm
`RETURNED` + the exact reason text is visible. Open the same day again, change the break to
**12:00–13:00** (60 min), **Save**, reload, confirm. Resubmit.

Expected: `unpaidBreakMs = 60 min` → **`workedMs = 420 min`**.

**E. ADMIN fallback — scope approval.** Reload `/admin/review-scopes`, open the new V2 scope and
**Approve**. The stored technical status remains `FOREMAN_APPROVED` for schema compatibility, but
its business meaning is "all review scopes approved / ready for final approval"; it does not prove
or require that a user with the `FOREMAN` role performed the action.

**F. ADMIN — final approval.** `/admin/timesheets` (defaults to the `FOREMAN_APPROVED` queue), open
the row, **Final approve**.

**G. ADMIN — reports.** `/admin/reports` (worker), `/admin/reports/sites` (site), `/admin/reports/
periods` (period) — all filtered to this fixture's worker/site/period — plus `/admin` (operational
overview). CSV export is explicitly **not** exercised (T8.4 already proved it independently).

## 4. Expected Timesheet/TimesheetVersion/ReviewScope transitions

| Step | `Timesheet.status` | `currentVersionId` | `TimesheetReviewScope` |
|---|---|---|---|
| after B.13 (first submit) | `SUBMITTED` | → V1 (450 min) | one `SITE` scope, `PENDING`, `timesheetVersionId = V1` |
| after C.4 (ADMIN returns) | `RETURNED` | still V1 (immutable, untouched) | that scope → `RETURNED`; new mutable draft opened |
| after D.7 (resubmit) | `SUBMITTED` | → V2 (420 min) | **new** `SITE` scope, `PENDING`, `timesheetVersionId = V2`; the V1 scope stays `RETURNED`, never reused as current |
| after E.4 (ADMIN approves scope) | `FOREMAN_APPROVED` (legacy technical enum meaning review-complete; this is the only site, so the whole timesheet advances) | still V2 | the V2 scope → `APPROVED`, `reviewedByUserId` is the ADMIN |
| after F.6 (final approve) | `FINAL_APPROVED` | still V2 (final approve is a pure status transition, never creates a version) | unchanged |

V1 and V2 coexist in the DB permanently — `TimesheetVersion` rows are immutable and append-only
(`03_DATA_MODEL_ERD.md` §1). A repeated submit/approve/final-approve after each transition must be
rejected without creating a duplicate version/scope/`AuditEvent` (§10).

## 5. Audit/redaction assertions

For every `AuditEvent` created by this scenario (`CLOCK_CHECK_IN`, `CLOCK_CHECK_OUT`, whatever
submit/return/approve/final-approve event types the code actually uses — read, don't assume, at
test-write time), the JSON-serialized `beforeValue`/`afterValue` must contain none of: `latitude`,
`longitude`, `gps`, `password`, `passwordHash`, `cookie`, `token`, `payloadHash`, `requestId`,
`deviceSequence` (case-insensitive substring scan, same convention as T9.1–T9.3's audit-content
check). `GET` requests must never create an `AuditEvent` (count before/after around a batch of
report-page loads).

## 6. PASS criteria

Every numbered browser step in §3 completes without an unhandled exception or a genuine `5xx`; the
fixture site has zero `ForemanAssignment` rows; the unassigned FOREMAN sees zero review items and
cannot act on the scope; every
DB assertion in §4 and the invariants in the task's own "Обязательные инварианты БД" section holds;
final worked-minutes shown in **all three** reports (T8.1 worker, T8.2 site, T8.3 period) and the
operational overview's `reportedMinutes` all equal **420** for this worker/site/period; zero
`AuditEvent`/redaction violations; zero role/security violations from the task's own checklist.

## 7. Defect-handling rule

If a step fails: first determine whether the failure is this test's own fixture/selector mistake or
a genuine product defect (re-read the actual route/component source, not just the test's
assumption). A genuine product defect gets a minimal, targeted fix — no redesign, no unrelated
cleanup — then the *entire* T9.4 scenario is re-run from a clean disposable DB, not just the
previously-failing step, since a fix earlier in the chain can change downstream state.

**Confirmed and fixed during the live run:** `app/worker/periods/[periodId]/hours/page.tsx`, `app/worker/periods/[periodId]/submit/
page.tsx`, `app/foreman/review/[timesheetId]/page.tsx`, `app/admin/timesheets/[timesheetId]/
page.tsx`, `app/admin/review-scopes/[reviewScopeId]/page.tsx`, and `app/admin/corrections/
[correctionRequestId]/page.tsx` each define their **own** local `segmentMinutes()` helper that sums
raw `endAt - startAt` per segment and does **not** subtract unpaid break time — unlike
`lib/reporting/worked-time.ts`'s canonical `computeSegmentMs`, which the reports (T8.1/T8.2/T8.3)
and `lib/attendance-overview.ts` correctly use instead. The live scenario reproduced **480** gross
where the canonical values were **450**/**420**. The fix introduced the pure ISO-DTO adapter
`workedMinutesFromIsoSegments()` in `lib/reporting/report-format.ts` and switched all six consumers
to it; no stored data or report formula changed.

The run also confirmed a second defect in the worker day editor: the backend has correctly required
an audit reason for any edit/removal of a clock-origin segment since T7A, but
`getWorkerTimesheetDraft()` did not expose `originClockShiftFragmentId` and `DayEditor` therefore
could neither echo provenance nor send `clockAdjustmentReasons`. A worker who used Check In/Out
could not save the resulting day through the normal UI. The minimal fix exposes the existing origin
id in the DTO, preserves it in the editor, displays one reason field, blocks a changed/removed
clock-origin interval without a reason, and sends the existing API contract. The test first proves
the client-side block causes no partial adjustment, then saves with a reason and proves one durable
`ClockShiftAdjustment(REMOVED)`.

## 8. Explicitly out of scope

T9.5 (restart survival), T9.6 (backup/restore), T9.7 (physical devices), tokenized external review
links for foremen (possible future feature, not authorized in this slice), CSV export (T8.4, already
proven), redesign of any screen, adding `NON_SITE`/`EMPTY_FALLBACK` review-scope coverage (this
fixture has exactly one site, so only a `SITE` scope is ever produced — if a `NON_SITE` scope
appears unexpectedly, that itself is investigated as a defect, not worked around).

## 9. Executed result

Final clean run against the production standalone build and a newly migrated disposable PostgreSQL
16 database: **84 passed, 0 failed**. The assertions include real browser Check In/Out with mocked
device geolocation, materialization, the reason-backed clock-origin edit, V1=450 minutes,
ADMIN return, V2=420 minutes, ADMIN scope approval, ADMIN final approval, all three report views,
overview reconciliation, immutable versions, audit redaction and GET-with-zero-mutations.

The fixture site had exactly **zero `ForemanAssignment` rows**. The optional unassigned FOREMAN saw
no matching review item; the V1 return and V2 approval both stored the ADMIN as reviewer. Therefore
the clarified business rule is empirically proven: a FOREMAN is not a required link between worker
submission and ADMIN final approval.

Independent regressions after the fix: T9 setup lifecycle **50/50**, role/permission matrix
**32/32**, setup UI **15/15**, report rounding **105/105**, period report **110/110**, plus clean
activation, corrections and operational-overview scripts.
