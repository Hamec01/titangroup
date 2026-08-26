-- AlterTable
ALTER TABLE "CompanyAttendancePolicy" ALTER COLUMN "cutoffTime" SET DEFAULT '23:59:00'::time;

-- AlterTable
ALTER TABLE "EmployeeProfile" ADD COLUMN     "addressCity" VARCHAR(120),
ADD COLUMN     "addressCountry" VARCHAR(120),
ADD COLUMN     "addressPostalCode" VARCHAR(32),
ADD COLUMN     "addressStreet" VARCHAR(255),
ADD COLUMN     "contactEmail" VARCHAR(255),
ADD COLUMN     "personalIdentityCodeEncrypted" TEXT,
ADD COLUMN     "personalIdentityCodeLast4" VARCHAR(4);
