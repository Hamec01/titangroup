CREATE TYPE "TimesheetV2CardStatus" AS ENUM ('ACTIVE', 'TRASHED', 'DELETED');

CREATE TABLE "TimesheetV2CardState" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "month" VARCHAR(7) NOT NULL,
    "customerKey" VARCHAR(80) NOT NULL,
    "siteId" UUID NOT NULL,
    "workAreaId" UUID,
    "displayName" VARCHAR(128),
    "status" "TimesheetV2CardStatus" NOT NULL DEFAULT 'ACTIVE',
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TimesheetV2CardState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_timesheet_v2_card_month" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT "ck_timesheet_v2_card_key" CHECK ("customerKey" = "siteId"::text || ':' || COALESCE("workAreaId"::text, 'none')),
    CONSTRAINT "ck_timesheet_v2_card_display_name" CHECK ("displayName" IS NULL OR (length(btrim("displayName")) BETWEEN 1 AND 128))
);

CREATE UNIQUE INDEX "TimesheetV2CardState_month_customerKey_key"
    ON "TimesheetV2CardState"("month", "customerKey");
CREATE INDEX "TimesheetV2CardState_month_status_idx"
    ON "TimesheetV2CardState"("month", "status");
CREATE INDEX "TimesheetV2CardState_siteId_workAreaId_idx"
    ON "TimesheetV2CardState"("siteId", "workAreaId");
CREATE INDEX "TimesheetV2CardState_updatedByUserId_idx"
    ON "TimesheetV2CardState"("updatedByUserId");

ALTER TABLE "TimesheetV2CardState"
    ADD CONSTRAINT "TimesheetV2CardState_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimesheetV2CardState"
    ADD CONSTRAINT "TimesheetV2CardState_workAreaId_fkey"
    FOREIGN KEY ("workAreaId") REFERENCES "WorkArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimesheetV2CardState"
    ADD CONSTRAINT "TimesheetV2CardState_updatedByUserId_fkey"
    FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
