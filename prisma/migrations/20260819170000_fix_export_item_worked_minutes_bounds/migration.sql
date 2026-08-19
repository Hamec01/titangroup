-- Titanor Time — T8.4A FOLLOW-UP: align ExportItem with canonical worked-time semantics
--
-- Corrective migration. Does NOT edit 20260819150000_add_export_batch_schema (already committed —
-- this project's convention is additive-only, never editing a past migration). Design per
-- docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4A FOLLOW-UP".
--
-- Root cause: 20260819150000's ck_export_item_worked_minutes_formula (CK-43) required
-- workedMinutes = GREATEST(0, grossMinutes - paidBreakMinutes - unpaidBreakMinutes). That is wrong
-- on two independent counts:
--
--   1. Semantically wrong. lib/reporting/worked-time.ts's canonical formula is
--      workedMs = grossMs - unpaidBreakMs — paid breaks stay INSIDE worked time, they are never
--      subtracted. T8.1/T8.2/T8.3 all already report worked time this way. CK-43 instead subtracted
--      paidBreakMinutes too, which would have made ExportItem.workedMinutes disagree with every
--      other T8 report for any bucket that has a paid break (gross=60, paid=15, unpaid=0: canonical
--      worked=60, CK-43's formula gave 45).
--
--   2. Even the corrected formula (workedMinutes = grossMinutes - unpaidBreakMinutes, without the
--      paid term) is not a valid DB-level arithmetic invariant, because grossMinutes/
--      unpaidBreakMinutes/workedMinutes are each independently rounded from their own millisecond
--      value (msToMinutes = Math.round(ms / 60000)) at the SAME (employeeId, siteId, date) bucket,
--      not derived from each other post-rounding. Independent rounding does not commute with
--      subtraction. Concrete counterexample: grossMs=31000 (31s) -> grossMinutes=round(31000/60000)
--      = 1; unpaidBreakMs=29000 (29s) -> unpaidBreakMinutes=round(29000/60000)=0; workedMs=2000 (2s)
--      -> workedMinutes=round(2000/60000)=0. But grossMinutes - unpaidBreakMinutes = 1 - 0 = 1,
--      not 0. No CHECK expressible purely in terms of the three already-rounded integer columns can
--      hold in general — the true relationship only exists at the millisecond level, before
--      rounding, which a CHECK constraint on the rounded columns cannot see.
--
-- Fix: drop the arithmetic-equality CHECK entirely and replace it with the strictly weaker, but
-- always-true regardless of rounding, bounds every canonical bucket must still satisfy: worked,
-- paid break, and unpaid break can never individually exceed gross. T8.4B must populate
-- ExportItem.workedMinutes with the literal canonical daily-bucket workedMinutes — computeSegmentMs()
-- -> sum within (employeeId, siteId, date) -> msToMinutes(workedMs) — the same value T8.1/T8.2/T8.3
-- already compute and display; it must not re-derive workedMinutes from the other two rounded
-- integer columns.
--
-- Registered docs/titanor-time/05_RAW_SQL_REGISTER.md §12 (CK-43 marked REMOVED, new CK-44 added).

-- CK-43 ck_export_item_worked_minutes_formula — REMOVED (see header comment above; wrong formula,
-- and not expressible as an arithmetic equality after independent per-column rounding).
ALTER TABLE "ExportItem" DROP CONSTRAINT "ck_export_item_worked_minutes_formula";

-- CK-44 ck_export_item_minute_bounds
-- Each of worked/paid-break/unpaid-break minutes can never exceed gross minutes on the same bucket
-- row. True regardless of independent per-column rounding (unlike an arithmetic equality between
-- them) — a bucket's worked/paid/unpaid time is always bounded by its own gross time.
ALTER TABLE "ExportItem" ADD CONSTRAINT "ck_export_item_minute_bounds" CHECK (
  "workedMinutes" <= "grossMinutes" AND
  "paidBreakMinutes" <= "grossMinutes" AND
  "unpaidBreakMinutes" <= "grossMinutes"
);
