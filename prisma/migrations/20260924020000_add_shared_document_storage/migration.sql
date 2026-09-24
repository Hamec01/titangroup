-- Shared Titanor Documents storage. One 10 GiB space for all authorised admins.
CREATE TABLE "StorageSpace" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" VARCHAR(120) NOT NULL,
  "quotaBytes" BIGINT NOT NULL,
  "usedBytes" BIGINT NOT NULL DEFAULT 0,
  "reservedBytes" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StorageSpace_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_storage_space_bytes" CHECK ("quotaBytes" > 0 AND "usedBytes" >= 0 AND "reservedBytes" >= 0 AND "usedBytes" + "reservedBytes" <= "quotaBytes")
);
CREATE UNIQUE INDEX "StorageSpace_name_key" ON "StorageSpace"("name");

CREATE TABLE "DocumentFolder" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "storageSpaceId" UUID NOT NULL,
  "parentId" UUID,
  "name" VARCHAR(255) NOT NULL,
  "normalizedName" VARCHAR(255) NOT NULL,
  "createdByUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentFolder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DocumentFolder_storageSpaceId_parentId_name_idx" ON "DocumentFolder"("storageSpaceId", "parentId", "name");
CREATE INDEX "DocumentFolder_parentId_idx" ON "DocumentFolder"("parentId");
CREATE INDEX "DocumentFolder_createdByUserId_idx" ON "DocumentFolder"("createdByUserId");
CREATE UNIQUE INDEX "ux_document_folder_root_name" ON "DocumentFolder"("storageSpaceId", "normalizedName") WHERE "parentId" IS NULL;
CREATE UNIQUE INDEX "ux_document_folder_nested_name" ON "DocumentFolder"("storageSpaceId", "parentId", "normalizedName") WHERE "parentId" IS NOT NULL;

CREATE TABLE "DocumentFile" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "storageSpaceId" UUID NOT NULL,
  "folderId" UUID,
  "originalName" VARCHAR(255) NOT NULL,
  "displayName" VARCHAR(255) NOT NULL,
  "normalizedName" VARCHAR(255) NOT NULL,
  "extension" VARCHAR(32),
  "mimeType" VARCHAR(255) NOT NULL,
  "category" VARCHAR(24) NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "storageKey" VARCHAR(512) NOT NULL,
  "checksumSha256" CHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "createdByUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastDownloadedAt" TIMESTAMPTZ(6),
  CONSTRAINT "DocumentFile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_document_file_size" CHECK ("sizeBytes" >= 0),
  CONSTRAINT "ck_document_file_checksum" CHECK ("checksumSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ck_document_file_status" CHECK ("status" IN ('ACTIVE', 'DELETING'))
);
CREATE UNIQUE INDEX "DocumentFile_storageKey_key" ON "DocumentFile"("storageKey");
CREATE INDEX "DocumentFile_storageSpaceId_folderId_displayName_idx" ON "DocumentFile"("storageSpaceId", "folderId", "displayName");
CREATE INDEX "DocumentFile_storageSpaceId_category_idx" ON "DocumentFile"("storageSpaceId", "category");
CREATE INDEX "DocumentFile_createdByUserId_idx" ON "DocumentFile"("createdByUserId");
CREATE UNIQUE INDEX "ux_document_file_root_name" ON "DocumentFile"("storageSpaceId", "normalizedName") WHERE "folderId" IS NULL;
CREATE UNIQUE INDEX "ux_document_file_nested_name" ON "DocumentFile"("storageSpaceId", "folderId", "normalizedName") WHERE "folderId" IS NOT NULL;

CREATE TABLE "DocumentUploadReservation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "storageSpaceId" UUID NOT NULL,
  "createdByUserId" UUID NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentUploadReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_document_upload_reservation_size" CHECK ("sizeBytes" > 0)
);
CREATE INDEX "DocumentUploadReservation_storageSpaceId_expiresAt_idx" ON "DocumentUploadReservation"("storageSpaceId", "expiresAt");
CREATE INDEX "DocumentUploadReservation_createdByUserId_idx" ON "DocumentUploadReservation"("createdByUserId");

ALTER TABLE "DocumentFolder" ADD CONSTRAINT "DocumentFolder_storageSpaceId_fkey" FOREIGN KEY ("storageSpaceId") REFERENCES "StorageSpace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentFolder" ADD CONSTRAINT "DocumentFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DocumentFolder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentFolder" ADD CONSTRAINT "DocumentFolder_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentFile" ADD CONSTRAINT "DocumentFile_storageSpaceId_fkey" FOREIGN KEY ("storageSpaceId") REFERENCES "StorageSpace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentFile" ADD CONSTRAINT "DocumentFile_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "DocumentFolder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentFile" ADD CONSTRAINT "DocumentFile_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentUploadReservation" ADD CONSTRAINT "DocumentUploadReservation_storageSpaceId_fkey" FOREIGN KEY ("storageSpaceId") REFERENCES "StorageSpace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentUploadReservation" ADD CONSTRAINT "DocumentUploadReservation_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "StorageSpace" ("name", "quotaBytes") VALUES ('Titanor Documents', 10737418240);

INSERT INTO "Permission" ("code", "description") VALUES
 ('document.read', 'List and inspect the shared document storage'),
 ('document.upload', 'Upload files to the shared document storage'),
 ('document.create_folder', 'Create folders in the shared document storage'),
 ('document.rename', 'Rename files and folders in the shared document storage'),
 ('document.move', 'Move files and folders in the shared document storage'),
 ('document.delete', 'Delete files and folders from the shared document storage'),
 ('document.download', 'Download files from the shared document storage'),
 ('document.manage', 'Manage the shared document storage')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "Role" r CROSS JOIN "Permission" p
WHERE r."name" IN ('ADMIN', 'SUPER_ADMIN') AND p."code" LIKE 'document.%'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
