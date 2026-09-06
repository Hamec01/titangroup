CREATE TABLE "ReportFile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "periodId" UUID,
    "reportType" VARCHAR(32) NOT NULL,
    "format" VARCHAR(8) NOT NULL,
    "fileName" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(80) NOT NULL,
    "fileHash" VARCHAR(64) NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "rowCount" INTEGER,
    "content" BYTEA NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReportFile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReportFile_periodId_createdAt_id_idx" ON "ReportFile"("periodId", "createdAt" DESC, "id" DESC);
CREATE INDEX "ReportFile_createdAt_id_idx" ON "ReportFile"("createdAt" DESC, "id" DESC);
