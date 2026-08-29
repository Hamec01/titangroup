-- Titanor Time — T15.2: seed worker.profession.manage.own.
--
-- Pure data (DML), no schema change. Idempotent (ON CONFLICT DO NOTHING), same pattern as
-- 20260829122000_seed_profession_manage_permission.
--
-- worker.profession.manage.own — a worker adds/removes their OWN professions from the worker app
-- (/worker/profile). Scoped ".own" and held by WORKER only; the ".all" side stays
-- worker.profession.manage (ADMIN/SUPER_ADMIN), so the admin keeps managing any worker's
-- professions. Listing the catalog from the worker app reuses no permission (any authenticated
-- worker may read it).

INSERT INTO "Permission" ("code", "description") VALUES
  ('worker.profession.manage.own', 'Add or remove one''s own professions from the worker app - docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by WORKER')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'WORKER'
  AND p.code = 'worker.profession.manage.own'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
