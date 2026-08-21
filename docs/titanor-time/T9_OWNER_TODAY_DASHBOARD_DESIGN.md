# T9 Owner Today Dashboard — design before code

Date: 2026-08-21. Route: `/admin`.

## Owner job to be done

The first screen is not a payroll report. In a few seconds the owner must answer:

1. Who is working now?
2. Where are they working and when did they start?
3. Who has finished or has not started today?
4. How much recorded time does each worker have today?
5. Who needs attention?

Period/version/review/conflict detail remains available, but must not dominate the default screen.

## Information hierarchy

1. Compact `Today` header with Helsinki date, `asOf`, manual refresh and existing 30-minute
   authoritative refresh.
2. One search field (`name`, employee number, Site or Work Area) plus Site filter.
3. Five quick counters: all active workers, working now, finished today, not started today, needs
   attention.
4. Dense but readable worker rows. Desktop uses columns; mobile uses stacked cards. Each row has
   exactly one primary action: open the worker page.
5. Period/state/page-size filters, payroll-state counters and technical conflicts live in collapsed
   secondary sections.

## Worker row contract

- identity: employee name and number;
- today's primary state: `WORKING`, `FINISHED`, or `NOT_STARTED`;
- current/relevant Site and optional Work Area;
- latest Check In and Check Out times for today;
- live recorded minutes today (closed shifts clamped to the Helsinki day plus the current open
  shift through one fixed request `asOf`);
- concise issue signal; no raw GPS coordinates;
- current timesheet status;
- link to `/admin/workers/:employeeId`, where configuration, assignments, full time report,
  timesheet and audited GPS drill-down remain available.

`todayWorkedMinutes` is operational recorded time, not a payroll/export amount. Raw events and the
canonical rounded timesheet remain unchanged.

## Population and search

Default `/admin` lists every currently active Employee, including workers not yet assigned to a
period or Site. An explicit `periodId` retains the historical participant population. Search is
server-side, case-insensitive, URL-backed and applied before pagination. It matches the allowlisted
fields above only.

## Performance and safety

- keep the existing one `REPEATABLE READ` snapshot;
- add one set-based current-assignment query, never a per-worker query;
- no periodic database writes: live duration is display-only;
- no coordinates/device identifiers/payloads in the DTO or HTML;
- preserve ADMIN permissions, foreman scope and existing API fields additively.

## Implemented verification

- permanent service test `scripts/_test-owner-today-dashboard.ts`: 25/25;
- query-count instrumentation: 50/200 workers = 26/26 SQL statements;
- production build and browser verification: desktop + 390×844, search by Work Area, full-row
  drill-down and Back to Today, no page overflow or application console errors;
- native empty select values are treated as absent filters; malformed non-empty UUIDs still fail.
