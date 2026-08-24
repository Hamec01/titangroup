-- Titanor Time — migration: seed worker.profile.read/update.own/all permissions
--
-- Pure data (DML), no schema change. Worker Profile feature (2026-08-24 plan): optional
-- self-service worker info (photo, specialty, skills, qualification cards) plus an
-- admin-attached contract, on the new EmployeeProfile/EmployeeQualification tables. Symmetric
-- with the existing worker.read.own/worker.read.all pair. Verified by direct SQL against a
-- disposable database before writing this migration: none of the four codes existed (zero
-- Permission rows, zero RolePermission grants).
--
-- worker.profile.read.own / worker.profile.update.own — WORKER only (their own profile).
-- worker.profile.read.all / worker.profile.update.all — ADMIN and SUPER_ADMIN only (any
-- worker's profile, including the contract). FOREMAN gets zero grants here.

INSERT INTO "Permission" ("code", "description") VALUES
  ('worker.profile.read.own', 'Read own EmployeeProfile/EmployeeQualification rows — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by WORKER only'),
  ('worker.profile.update.own', 'Update own EmployeeProfile fields/photo and own EmployeeQualification cards — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by WORKER only'),
  ('worker.profile.read.all', 'Read any worker''s EmployeeProfile/EmployeeQualification rows, including the contract — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN'),
  ('worker.profile.update.all', 'Update any worker''s EmployeeProfile fields/photo/qualifications and attach/replace the contract — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'WORKER'
  AND p.code IN ('worker.profile.read.own', 'worker.profile.update.own');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code IN ('worker.profile.read.all', 'worker.profile.update.all');
