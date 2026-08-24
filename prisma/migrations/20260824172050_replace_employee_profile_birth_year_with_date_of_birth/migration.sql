/*
  Warnings:

  - You are about to drop the column `birthYear` on the `EmployeeProfile` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "CompanyAttendancePolicy" ALTER COLUMN "cutoffTime" SET DEFAULT '23:59:00'::time;

-- AlterTable
ALTER TABLE "EmployeeProfile" DROP COLUMN "birthYear",
ADD COLUMN     "dateOfBirth" DATE;
