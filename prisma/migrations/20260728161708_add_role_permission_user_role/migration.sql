-- Titanor Time — second migration: Role / Permission / RolePermission / UserRole
-- Generated from prisma/schema.prisma (offline: prisma migrate diff --from-schema-datamodel
-- <pre-change schema snapshot> --to-schema-datamodel prisma/schema.prisma), plus a small raw-SQL
-- addition (partial unique index) and fixed reference-data seed rows for the four roles defined in
-- docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §1. This is additive only — the first initial
-- migration (20260728012114_init_titanor_time_foundation) is not modified, and
-- docs/titanor-time/05_RAW_SQL_REGISTER.md (frozen, scoped to that first migration) is not touched.
--
-- Adds the entities described in docs/titanor-time/03_DATA_MODEL_ERD.md (Role, Permission,
-- RolePermission, UserRole) that were deliberately excluded from the foundation schema. Permission
-- and RolePermission are created empty here — populating the full permission-string matrix from
-- 02_ROLE_PERMISSION_MATRIX.md is deferred to the tasks that implement each corresponding endpoint,
-- to avoid transcribing ~50+ strings by hand disconnected from real authorization code.

-- ============================================================================
-- Section A — structural SQL matching prisma/schema.prisma (tables, indexes, foreign keys)
-- ============================================================================

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(32) NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "validFrom" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_code_key" ON "Permission"("code");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permissionId_key" ON "RolePermission"("roleId", "permissionId");

-- CreateIndex
CREATE INDEX "UserRole_userId_idx" ON "UserRole"("userId");

-- CreateIndex
CREATE INDEX "UserRole_roleId_idx" ON "UserRole"("roleId");

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Section B — raw SQL not expressible in Prisma schema syntax
-- ============================================================================

-- ex_user_role_active_unique
-- Prisma's @@unique cannot express a partial index. A plain full-table unique on
-- (userId, roleId) would incorrectly block a user from ever regaining a role after
-- a prior grant expired (validTo set). Only one ACTIVE (validTo IS NULL) grant of a
-- given role per user is allowed; expired/historical grants are unrestricted.
CREATE UNIQUE INDEX "ex_user_role_active_unique" ON "UserRole" ("userId", "roleId") WHERE "validTo" IS NULL;

-- ============================================================================
-- Section C — fixed reference-data seed: the four roles from
-- docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §1. These names are referenced by
-- code (login/role-guard), not free-form data — seeding them in the migration itself
-- (rather than a separate runtime seed step) keeps the schema and its required
-- reference rows in the same reviewable, versioned unit.
-- ============================================================================

INSERT INTO "Role" ("name", "description") VALUES
  ('SUPER_ADMIN', 'Технический владелец системы'),
  ('ADMIN', 'Начальник / офис-менеджер'),
  ('FOREMAN', 'Прораб на объекте'),
  ('WORKER', 'Работник');
