-- Titanor Time — seed attendance.conflict.read permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260818000000_seed_timesheet_draft_edit_exception_permission.
-- docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §16 п.9 (owner decision 2026-08-12) / addendum
-- "T7A.9A Attendance Operational Overview Read Foundation" — gates the ADMIN-only conflict section
-- of:
--
--   GET /api/admin/overview  -- timesheet.read.all + attendance.exception.read.all +
--                                attendance.conflict.read (all three required)
--
-- This permission gates reading ClockEventIdConflict, DeviceEventReceipt(outcome=REJECTED_TERMINAL)
-- and AuditEvent(eventType=FIFO_LEDGER_INCONSISTENT) rows. It deliberately does NOT grant FOREMAN
-- or WORKER anything — FOREMAN never receives raw conflict/receipt/FIFO data in any overview
-- response (design checkpoint, §16 п.9, reaffirmed by the T7A.9A addendum), and the foreman
-- overview route never queries these three tables regardless of role/permission.
--
-- SYSTEM never gets a role (ck_user_system_shape/ux_user_single_system guarantee that
-- structurally), so it is not addressed here — same reasoning as every prior attendance.* seed.

INSERT INTO "Permission" ("code", "description") VALUES
  ('attendance.conflict.read', 'Read the minimal ADMIN/SUPER_ADMIN-only conflict/anomaly section of the attendance operational overview (ClockEventIdConflict, DeviceEventReceipt REJECTED_TERMINAL, AuditEvent FIFO_LEDGER_INCONSISTENT) — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §16 п.9, held by ADMIN and SUPER_ADMIN only. Grants no access to raw GPS coordinates (attendance.gps.read.raw) or any other attendance.* permission.');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'attendance.conflict.read';
