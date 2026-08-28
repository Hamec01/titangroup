-- Titanor Time — T13.1: Professions.
--
-- docs/titanor-time/T13_PROFESSIONS_WORKFORCE_REPORTS_TES_DESIGN.md §4-§6.
--
-- A profession is a trade / work speciality (Welder, Pipe fitter, Carpenter). It is NOT a
-- certificate, NOT a qualification, does NOT grant a system role or any permission, does NOT by
-- itself authorise site work, and does NOT replace EmployeeQualification.
--
-- Additive only. Existing rows are untouched. EmployeeProfile.specialty (the free-text legacy
-- field) is deliberately NOT dropped here — the backfill is a manual, admin-assisted mapping
-- (T13.3), not an automatic string match.
--
-- Model shape mirrors QualificationDefinition + EmployeeQualification exactly. The CHECK and the
-- two partial unique indexes are raw SQL because Prisma's schema DSL cannot express a WHERE index
-- (same reason ux_admin_notification_active_dedup and dozens of others in this schema are hand-
-- added into a generated migration — see docs/titanor-time/05_RAW_SQL_REGISTER.md).

-- CreateEnum
CREATE TYPE "ProfessionCategory" AS ENUM ('SHIPBUILDING', 'CONSTRUCTION');

-- CreateTable: ProfessionDefinition (catalog)
CREATE TABLE "ProfessionDefinition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "category" "ProfessionCategory" NOT NULL,
    "nameEn" VARCHAR(120) NOT NULL,
    "nameRu" VARCHAR(120) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ProfessionDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable: EmployeeProfession (worker x profession)
CREATE TABLE "EmployeeProfession" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employeeId" UUID NOT NULL,
    "definitionId" UUID,
    "customName" VARCHAR(120),
    "customNameNormalized" VARCHAR(120),
    "customCategory" "ProfessionCategory",
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "EmployeeProfession_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "ProfessionDefinition_code_key" ON "ProfessionDefinition"("code");
CREATE INDEX "ProfessionDefinition_category_isActive_sortOrder_idx" ON "ProfessionDefinition"("category", "isActive", "sortOrder");
CREATE INDEX "EmployeeProfession_employeeId_idx" ON "EmployeeProfession"("employeeId");
CREATE INDEX "EmployeeProfession_definitionId_idx" ON "EmployeeProfession"("definitionId");

-- Foreign keys
ALTER TABLE "EmployeeProfession"
    ADD CONSTRAINT "EmployeeProfession_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmployeeProfession"
    ADD CONSTRAINT "EmployeeProfession_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "ProfessionDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeProfession"
    ADD CONSTRAINT "EmployeeProfession_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Raw SQL: catalog XOR custom, and duplicate prevention (Prisma DSL cannot express these).
-- ---------------------------------------------------------------------------------------------

-- CK — exactly one of (definitionId) / (customName + customNameNormalized + customCategory).
ALTER TABLE "EmployeeProfession"
    ADD CONSTRAINT "ck_employee_profession_catalog_xor_custom" CHECK (
        ("definitionId" IS NOT NULL
            AND "customName" IS NULL
            AND "customNameNormalized" IS NULL
            AND "customCategory" IS NULL)
        OR
        ("definitionId" IS NULL
            AND "customName" IS NOT NULL
            AND "customNameNormalized" IS NOT NULL
            AND "customCategory" IS NOT NULL)
    );

-- A catalog profession cannot be added to one worker twice.
CREATE UNIQUE INDEX "ux_employee_profession_catalog"
    ON "EmployeeProfession" ("employeeId", "definitionId")
    WHERE "definitionId" IS NOT NULL;

-- A custom profession cannot be re-added to one worker differing only in case / whitespace
-- (customNameNormalized is the lower/trim/collapse-whitespace form, set by lib/professions.ts).
CREATE UNIQUE INDEX "ux_employee_profession_custom"
    ON "EmployeeProfession" ("employeeId", "customNameNormalized")
    WHERE "definitionId" IS NULL;
