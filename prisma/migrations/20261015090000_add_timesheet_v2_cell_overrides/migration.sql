-- Табель v2 — values typed into the customer month grid ("Редактировать табель"). Additive only.
-- CreateTable
CREATE TABLE "TimesheetV2CellOverride" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employeeId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workAreaId" UUID,
    "date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "off" BOOLEAN NOT NULL DEFAULT false,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TimesheetV2CellOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimesheetV2CellOverride_siteId_workAreaId_date_idx" ON "TimesheetV2CellOverride"("siteId", "workAreaId", "date");

-- CreateIndex
CREATE INDEX "TimesheetV2CellOverride_employeeId_date_idx" ON "TimesheetV2CellOverride"("employeeId", "date");

-- CreateIndex
CREATE INDEX "TimesheetV2CellOverride_updatedByUserId_idx" ON "TimesheetV2CellOverride"("updatedByUserId");

-- AddForeignKey
ALTER TABLE "TimesheetV2CellOverride" ADD CONSTRAINT "TimesheetV2CellOverride_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetV2CellOverride" ADD CONSTRAINT "TimesheetV2CellOverride_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetV2CellOverride" ADD CONSTRAINT "TimesheetV2CellOverride_workAreaId_fkey" FOREIGN KEY ("workAreaId") REFERENCES "WorkArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetV2CellOverride" ADD CONSTRAINT "TimesheetV2CellOverride_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One value per (employee, site, work area, day); "no customer" (NULL work area) counts as one key.
CREATE UNIQUE INDEX "ux_timesheet_v2_cell_override" ON "TimesheetV2CellOverride"("employeeId", "siteId", "workAreaId", "date") NULLS NOT DISTINCT;

ALTER TABLE "TimesheetV2CellOverride" ADD CONSTRAINT "ck_timesheet_v2_cell_override_minutes" CHECK ("minutes" >= 0 AND "minutes" <= 1440);
ALTER TABLE "TimesheetV2CellOverride" ADD CONSTRAINT "ck_timesheet_v2_cell_override_off" CHECK (NOT "off" OR "minutes" = 0);
