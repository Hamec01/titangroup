-- Titanor Time — fourth migration: seed the first real Permission/RolePermission rows
--
-- Pure data (DML), no schema change — Permission/RolePermission table structure is
-- unchanged since the second migration (20260728161708_add_role_permission_user_role),
-- which deliberately left both tables empty and deferred populating the full
-- ~50+ permission-string matrix (docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md) to the
-- tasks that implement each corresponding endpoint. This is the first such task:
-- GET /api/admin/cities (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §2), the first
-- real admin endpoint, requires exactly one permission code — city.read.all — per
-- 02_ROLE_PERMISSION_MATRIX.md §2.4, held by ADMIN and SUPER_ADMIN.
--
-- POST /api/admin/cities (city.create) is deliberately not seeded here — that endpoint's
-- contract also requires an audit event (CITY_CREATED) and Idempotency-Key support, both
-- of which need their own not-yet-designed schema (AuditEvent, an idempotency-record
-- table) and are out of scope for this task.

INSERT INTO "Permission" ("code", "description") VALUES
  ('city.read.all', 'Read all cities — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.4, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'city.read.all';
