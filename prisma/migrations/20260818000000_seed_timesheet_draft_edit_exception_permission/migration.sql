-- Titanor Time — seed timesheet.draft.edit.exception permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260817000000_seed_attendance_exception_base_resolution_permissions.
-- docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §11/§12.1/§12.4 — gates T7A.8B.4B's
-- REASON_EDIT action, the sixth and last of the §11 resolution-action matrix.
--
--   POST /api/admin/attendance/exceptions/:exceptionId/edit    -- timesheet.draft.edit.exception
--                                                                  (+ .read.all + .resolve.all)
--   POST /api/foreman/attendance/exceptions/:exceptionId/edit  -- v1: not granted at all (§12.4
--                                                                  "FOREMAN не получает
--                                                                  timesheet.draft.edit.exception
--                                                                  в первом релизе") — this
--                                                                  migration deliberately does NOT
--                                                                  grant FOREMAN anything; the
--                                                                  route fails closed regardless.
--
-- This permission does NOT grant any access to PATCH /api/worker/timesheets/*/days/* — that route
-- remains gated exclusively by timesheet.draft.edit.own against the caller's own employeeId, with
-- no special-casing for any other role, unchanged by this migration.
--
-- SYSTEM never gets a role (ck_user_system_shape/ux_user_single_system guarantee that
-- structurally), so it is not addressed here — same reasoning as every prior attendance.* seed.

INSERT INTO "Permission" ("code", "description") VALUES
  ('timesheet.draft.edit.exception', 'Apply a reason-backed edit to a clock-origin TimesheetDraftSegment while resolving the linked AttendanceException (REASON_EDIT, T7A.8B.4B) — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §10.2/§12.4, held by ADMIN and SUPER_ADMIN only. Grants no access whatsoever to the worker''s own PATCH /api/worker/timesheets/*/days/* route.');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'timesheet.draft.edit.exception';
