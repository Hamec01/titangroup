# Titanor Time — T9.1–T9.3 Internal Test Plan (2026-08-20)

Written BEFORE code, per this task's own STOP-GATE/design-checkpoint requirement. Base commit
`ff50c7d feat(time): add account-bound offline worker views`. Scope: T9.1 (test users), T9.2 (test
sites), T9.3 (role/permission checklist) — plus the owner's three reported Setup/lifecycle defects
and the same class of audit across the rest of `/admin/setup`. T9.4 (full end-to-end scenario) is
explicitly out of scope for this document.

## 1. Lifecycle matrix

Filled from the actual schema (`prisma/schema.prisma`), `02_ROLE_PERMISSION_MATRIX.md`, and the
actual DB triggers in `05_RAW_SQL_REGISTER.md` — not invented. "Physical delete" is evaluated per
entity against real FK/audit/history dependents and real DB constraints, not assumed absent.

| Entity | Create | List/read | Edit | Завершение жизненного цикла | Physical delete |
|---|---|---|---|---|---|
| City | `POST /api/admin/cities` | `GET /api/admin/cities` | `PATCH` (name only) | — (no lifecycle concept; City is optional metadata) | Not implemented — `WorkSite.cityId` is a live FK; no delete route exists. Correct: a City with sites attached cannot safely disappear, and there is no `active` flag to retire one. **Gap, not a bug** — no reported blocker. |
| Employee/Worker | `POST /api/admin/workers` (+ `Employment`+`User` in one transaction) | `GET /api/admin/workers`, `GET .../:employeeId` | `PATCH /api/admin/workers/:employeeId` (firstName/lastName/phone, optimistic `version`) | `POST .../:employeeId/deactivate` → `Employment.active=false`, `User.status → OFFBOARDING\|DEACTIVATED` per `03_...` §4.2. Does **not** retract `SiteAssignment` rows — documented, intentional (`lib/workers.ts` comment) | Not implemented — correct: `Timesheet`/`ClockEvent`/`AuditEvent` history references `Employee`, deletion would orphan payroll history. `worker.deactivate` is the approved terminal action. |
| User (system: FOREMAN/ADMIN/SUPER_ADMIN) | `POST /api/admin/users` (`STANDALONE` or `EXISTING_EMPLOYEE` dual-role) | `GET /api/admin/users` | Not implemented (username/email edit) | `user.deactivate`/`role.assign` — **permission rows exist in `02_...` §2.12, but zero route and zero UI exist.** `04_ADMIN_FIRST_API_CONTRACTS.md` §14 explicitly says so: *"ADMIN/SUPER_ADMIN-создание, role.assign, деактивация — не входят, зарезервированы 01_SCREEN_MAP.md (/admin/users)."* This is a **documented future phase, not a regression** — worker.deactivate already handles the WORKER+FOREMAN dual-role case via the linked Employee. | Not implemented, same reasoning as Employee. |
| WorkSite | `POST /api/admin/sites` | `GET /api/admin/sites`, `GET .../:siteId` | `PATCH /api/admin/sites/:siteId` | `active` boolean in the same `PATCH` ("Close" — `SiteEditForm`'s own checkbox, "uncheck to close this site") | Not implemented — correct: `SiteAssignment`/`WorkArea`/`WorkSiteGeofenceVersion`/`Timesheet` all reference it. `active=false` is the approved terminal action. |
| WorkArea | `POST /api/admin/sites/:siteId/work-areas` | embedded in site detail (`SiteDetail.workAreas`) | `PATCH .../work-areas/:workAreaId` (name, `active`) | `active` boolean, same PATCH (`ToggleActiveButton` — "Deactivate"/"Activate") | Not implemented — correct: `SiteAssignment.workAreaId` references it. |
| ScheduleTemplate | `POST /api/admin/templates` (creates parent + version 1) | `GET /api/admin/templates`, `GET .../:templateId` | `PATCH /api/admin/templates/:templateId` — **creates a new immutable version**, never rewrites an old one (snapshot semantics, `02_...` §2.6) | `active` field is read-only in this slice per the doc ("deactivate/reactivate шаблона — нет утверждённого контракта") | Not implemented — correct: old `WorkScheduleTemplateVersion` rows are referenced by `SiteAssignment.templateVersionId`, immutable by design. |
| SiteAssignment | `POST /api/admin/assignments` | `GET /api/admin/assignments` (admin list), embedded in worker/site detail | `PATCH /api/admin/assignments/:assignmentId` (only `isPrimary`/`endedReason` once started — `400 ASSIGNMENT_ALREADY_STARTED` for site/workArea/template changes, use `assignment.split`) | `POST .../:assignmentId/end` (`assignment.end` — sets `validTo`, requires `reason` if earlier than planned) — **fully implemented backend, confirmed zero UI anywhere calls it** (see §3, defect D3) | Not implemented — correct: `WorkSegment`/`TimesheetPlannedShift` composite-FK reference `SiteAssignment` via `sourceAssignmentId` (`02_...` §3 invariants table). `assignment.end` is the approved terminal action. |
| ForemanAssignment | `POST /api/admin/foreman-assignments` | embedded in site detail (`SiteDetail.foremanAssignments`) | Not implemented (no PATCH route) | `POST .../:foremanAssignmentId/end` (`foreman_assignment.end`) — **fully implemented backend, confirmed zero UI anywhere calls it** (see §3, defect D4) | Not implemented — correct, same reasoning as SiteAssignment. |
| PayrollPeriod | `POST /api/admin/periods` | `GET /api/admin/periods`, `GET .../:periodId`, `GET .../current` | Not implemented (no PATCH — periods don't have editable fields beyond status transitions) | `period.lock` (`LockPeriodAction.tsx`, requires `FINAL_APPROVED` on every `expected=true` participant) → `period.export` (`/admin/export`, T8.4C) | Not implemented — correct: `Timesheet`/`ExportBatch`/`AuditEvent` all reference it; `lock`→`export` is the approved terminal sequence. |
| GeofenceVersion | `POST /api/admin/sites/:siteId/geofence-versions` (append-only — `current` in response, never edits history) | `GET /api/admin/sites/:siteId/geofence-versions` | **Immutable** — DB trigger `trg_geofence_version_immutable` (TRG-17/FN-13, `05_RAW_SQL_REGISTER.md`) unconditionally bans `UPDATE`/`DELETE`, not just app-level convention | Superseded automatically — a new version becomes `current`, the old one stays in history, read-only | **Forbidden at the DB level**, confirmed by trigger. UI correctly has zero delete action (`GeofenceSection.tsx`). |

## 2. Critical DELETE decision

Per the task's own instruction, physical DELETE was **not** added anywhere. Every entity above
already has an approved terminal-lifecycle action (deactivate/end/close/lock+export/immutable-
supersession) that is either fully implemented end-to-end, or fully implemented on the backend with
only the UI missing. Two entities (City, User) have no terminal action implemented at all — both are
pre-existing, documented scope gaps (City never had one; User's is explicitly deferred in
`04_ADMIN_FIRST_API_CONTRACTS.md` §14), not something this task invents from scratch without a
proven blocker. No inactive/ended row is hidden without explanation — active-only filters (worker
list's "Active"/"Inactive" column, site list's "Active"/"Closed" column, work area's "(inactive)"
suffix) all show status inline rather than silently omitting rows.

## 3. Confirmed defects (static code read, to be proven live before fixing)

Root-caused by reading `app/admin/**`, `app/api/admin/**`, and `lib/**` directly against the
lifecycle matrix above — matches the owner's three reported symptoms plus the same class of gap
found in two more Setup sections.

- **D1 — `/admin/workers` list page has no link to `/admin/workers/new`.** `app/admin/workers/page.tsx`'s
  header renders only `{totalItems} workers` — no "create new"/"Add worker" link, unlike
  `/admin/templates` ("Create template"), `/admin/users` ("Add foreman"), `/admin/periods` ("open new
  period"). The Setup checklist's own "Create" action (`/admin/setup`) only appears while
  `hasWorker=false`; once any worker exists it switches to "Manage" → `/admin/workers`, which then has
  no path onward to `/new`. **This is the owner's reported "после создания одного работника невозможно
  создать второго."** The backend (`POST /api/admin/workers`, `reserveWorkerUsername`'s
  `pg_advisory_xact_lock`) has no singleton assumption — confirmed by reading the full create
  transaction; it is a pure navigation gap, not a data-layer bug.
- **D2 — `/admin/sites` list page has the identical gap.** `app/admin/sites/page.tsx` has no
  "create new" link either — same missing-link class as D1, on the entity right next to Worker in the
  Setup checklist. Not yet reported by the owner but structurally identical, so covered proactively
  per the task's "похожие проблемы возможны в остальных Setup-разделах" instruction.
  `/admin/templates`, `/admin/users`, `/admin/periods` were checked and are fine (all three already
  have a working link).
  `/admin/assignments` was checked and is fine (`Link href="/admin/assignments/new"`, confirmed
  present).
- **D3 — `SiteAssignment` has no "End" UI anywhere.** `POST /api/admin/assignments/:assignmentId/end`
  is fully implemented (validation, `reason`-required-if-early rule, audit event, correct 400/404
  handling) — but `AssignmentPrimaryToggle.tsx` only exposes `isPrimary` toggling, with its own
  comment admitting the gap: *"endedReason editing needs a real assignment detail page (not built
  yet)."* No other file references this endpoint. **This is the likely mechanism behind the owner's
  "старого работника невозможно убрать из активной работы"**: `worker.deactivate` intentionally does
  not retract assignments (by design, per §1), so the *only* approved way to actually remove someone
  from a site's active-assignment list is `assignment.end` — which has no UI path at all.
- **D4 — `ForemanAssignment` has the identical gap.** `POST /api/admin/foreman-assignments/:id/end`
  exists; `ForemanAssignmentSection.tsx` only has a create form, no per-row "End" action. Same defect
  class as D3, same fix shape.

No defect was found in: worker/site PATCH (edit) — both use correct optimistic-concurrency CAS,
confirmed by reading the full transaction; worker deactivate — correct, matches documented
Employment/User state-machine; WorkArea create-second/toggle — confirmed no singleton assumption,
supports arbitrarily many; Template/Period create-second — both already have working "create new"
links, no gap found; GeofenceVersion — correctly append-only both in UI and DB trigger.

## 4. Fix decision

D1/D2/D3/D4 are UI-only gaps in front of an already-correct, already-tested backend contract — per
the task's own DELETE-decision guidance ("Если у сущности действительно предусмотрен безопасный
delete-контракт, но отсутствует UI — можно добавить UI после документирования"), the same reasoning
applies to the `end`-contracts here. Fix is additive UI only:

1. `/admin/workers` list header — add a "create new" link, matching the exact wording/placement
   pattern already used by `/admin/templates`/`/admin/periods`.
2. `/admin/sites` list header — same.
3. `/admin/assignments` list — add an "End" action per row (own small client component, same shape as
   `AssignmentPrimaryToggle.tsx`: reason + end-date fields, calls the existing endpoint, no new
   backend code).
4. `ForemanAssignmentSection.tsx` — add an "End" action per row, same shape, calls the existing
   endpoint.

City and User terminal-lifecycle gaps are **not** fixed — no reported blocker, and inventing a new
backend contract (`user.deactivate`/`role.assign` have zero implementation, not just zero UI) would be
exactly the kind of unrequested feature expansion this task explicitly forbids. Documented as a known
gap in `IMPLEMENTATION_STATUS.md` instead.

## 5. Test fixture (T9.1/T9.2)

Created only through real API/UI calls against a disposable PostgreSQL 16, except the one
bootstrap SUPER_ADMIN (`bootstrapSuperAdmin()` from `scripts/bootstrap-super-admin.ts`, the
project's existing, already-approved convention for the very first account — everything after that
is created through real HTTP the same way an admin would).

- SUPER_ADMIN — bootstrap.
- ADMIN — `POST /api/admin/users`... **not available** (`user.create.admin` has no route, §1) — created
  directly as a second bootstrap-shaped row is not the intended path either. Resolution: `ADMIN` test
  account created the same way `bootstrapSuperAdmin` creates `SUPER_ADMIN` (same underlying primitive,
  `Role.name='ADMIN'`), acceptable because this is the identical "no other path exists yet" situation
  already accepted for SUPER_ADMIN itself, not a new gap introduced by this task.
- FOREMAN (standalone) — `POST /api/admin/users {mode: STANDALONE}` → real activation
  (`GET /api/auth/activate`, `POST /api/auth/set-initial-password`) — real HTTP, real password.
- WORKER A, WORKER B — `POST /api/admin/workers` → real activation, same flow.
- dual-role user (FOREMAN+WORKER) — a third worker created via `POST /api/admin/workers`, activated,
  then `POST /api/admin/users {mode: EXISTING_EMPLOYEE, employeeId}` grants FOREMAN — exercises the
  real dual-role grant path, used only for role-isolation checks (§C of the role checklist).
- Site Alpha, Site Beta — `POST /api/admin/sites`.
- One work area per site — `POST /api/admin/sites/:id/work-areas`.
- One geofence version per site — `POST /api/admin/sites/:id/geofence-versions`.
- One ScheduleTemplate — `POST /api/admin/templates`.
- Worker A → Alpha (primary), Worker B → Beta (primary) — `POST /api/admin/assignments`, `validFrom`
  fixed at a real past date (2020-01-01, open-ended `validTo: null`) so `GET .../attendance/context`'s
  "today" filter and any future period always sees a current assignment — established convention from
  the T7A/T8 test scripts in this session.
- FOREMAN assigned to both Alpha and Beta — `POST /api/admin/foreman-assignments` × 2 (exercises
  both scope-isolation and no-cross-site-leak checks together).
- One OPEN `PayrollPeriod` covering today — `POST /api/admin/periods`; both workers auto-become
  `expected=true` participants (`period.create`'s own auto-participant-detection).

Usernames are fixture-run-unique (`randomUUID().slice(0,6)` suffix, lowercased — case-sensitivity
lesson from this session's T8.8 work applies identically here). Passwords: `randomUUID()`-derived,
≥16 chars, generated per-run, never logged, never committed — printed nowhere, not even to the
script's own stdout beyond a redacted confirmation.

## 6. Role/permission checklist (T9.3) — what gets checked, both UI and HTTP

- **SUPER_ADMIN**: full Setup CRUD/lifecycle (create+edit+lifecycle-action for every entity in §1),
  reports/export/attendance-policy read+update.
- **ADMIN**: same operational actions as SUPER_ADMIN except nothing SUPER_ADMIN-only exists in the
  currently-implemented surface (`user.create.admin`/`role.assign` have no route to probe — recorded
  as untestable-by-absence, not skipped silently).
- **FOREMAN**: `/foreman/**` only; `/admin/**` → in-page "Access denied" (not a redirect, per the
  existing layout gate) and every `/api/admin/**` route → `403`; only Alpha/Beta-scoped data visible
  (no third, unassigned site created in the fixture — cross-site isolation is proven by using Worker
  A/B's own two sites, both of which the FOREMAN IS assigned to, plus a negative probe against a
  fixture-created third site the FOREMAN is deliberately NOT assigned to for the isolation check
  itself).
- **WORKER**: `/worker/**` own data only; `/admin/**`/`/foreman/**` → denied; own `employeeId`
  cannot be substituted for another worker's on any `.own`-scoped endpoint.
- **Dual-role** (FOREMAN+WORKER): self-review-exclusion (`reviewer.employeeId != Timesheet.employeeId`)
  still holds; permission set is the union of both roles, no implicit extra grant.
- **Cross-cutting**: 401 with no session; 403 on missing permission; CSRF rejection (missing/incorrect
  `X-Requested-With`); permission revocation takes effect on the very next request (custom-role
  grant/revoke pattern already established in T8.1/T8.2A/T8.3A tests); malformed UUID → `400`/safe
  `404`, never `500`; foreign vs. nonexistent id → identical response (no oracle); `GET` never writes
  an `AuditEvent`; role/permission denial happens before body validation on mutation routes.

## 7. Explicitly out of scope for this task

Redesign of any screen, full localization pass, performance work, building `user.deactivate`/
`role.assign`/City lifecycle from scratch, T9.4's full end-to-end scenario (admin→worker→foreman→
admin), T9.5 (restart), T9.6 (backup/restore), T9.7 (physical devices).

## 8. Results (2026-08-20, after implementation)

All four §3 defects (D1-D4) were reproduced live in a real Chromium session against the disposable
fixture BEFORE any fix, confirming the static-read hypothesis was correct — then fixed exactly per
§4, then re-verified live after the fix (both in the dedicated reproduction pass and permanently in
`scripts/_test-t9-setup-ui.ts`'s final-confirmation checks).

One additional defect class was found *while writing* the regression tests, not by static reading:
`GET /api/admin/workers/:employeeId` with a non-UUID path segment threw an uncaught
`PrismaClientKnownRequestError(P2023)` (Prisma cannot cast a malformed string into a `uuid` column),
surfacing as a `500` instead of the documented `404`. A codebase-wide check of the same route family
found the same gap in 9 files total (`workers/[employeeId]/route.ts` GET+PATCH,
`workers/[employeeId]/deactivate/route.ts`, `assignments/[assignmentId]/route.ts`,
`.../end/route.ts`, `.../promote/route.ts`, `.../split/route.ts` (path param only — its own
`UUID_PATTERN` already existed for a body field), `sites/[siteId]/work-areas/route.ts` (GET+POST),
`sites/[siteId]/work-areas/[workAreaId]/route.ts`, `periods/[periodId]/route.ts`,
`periods/[periodId]/lock/route.ts`, `foreman-assignments/[foremanAssignmentId]/end/route.ts`) —
while sibling routes for the exact same entities (`workers/[employeeId]/activation/route.ts`,
`.../regenerate-username/route.ts`) already had the guard. Fixed uniformly: the same
`UUID_PATTERN` regex, checked immediately after `await params`, before any DB call, returning the
same 404 code the route already used for "genuinely not found" (no oracle). This sweep was scoped
to the Setup-domain routes this task actually touches — the same check was **not** extended to
unrelated domains (corrections, timesheets, review-scopes, attendance exceptions), which are out of
this task's scope and were exhaustively hardened in prior sessions.

Final counts: 97/97 across the three permanent scripts (`_test-t9-setup-lifecycle.ts` 50/50,
`_test-t9-role-matrix.ts` 32/32, `_test-t9-setup-ui.ts` 15/15). Regression: `_test-activation.ts`,
`_test-corrections.ts`, `_test-overview.ts`, `_test-period-time-report.ts` (110/110),
`_test-csv-export.ts` (201/201), `_test-pilot-pair-orphan.ts`, `_test-warm-cache.ts` (2/2) — all
green, unchanged. `git diff --stat` confirms the changed files are exactly the Setup-domain surface
this task targeted — offline outbox/clock, timesheet edit/submit, foreman review, attendance
exceptions, reports, CSV export generation, and PWA/offline logic were not touched by a single line,
so their own large suites (`_test-offline-views.ts` 71/71, `_test-pwa-install.ts` 59/59, etc.) were
not re-run in full — the same zero-diff-adjacent reasoning already established in this session's
T8.7/T8.4C work.

T9.1/T9.2/T9.3 are complete. T9.4 (the full end-to-end scenario) has not been started.
