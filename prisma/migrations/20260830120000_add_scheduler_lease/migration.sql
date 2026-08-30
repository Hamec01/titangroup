-- Titanor Time — R06-A: single-writer lease for the attendance scheduler.
--
-- The scheduler is a single sequential process, so it never overlaps itself. This table catches
-- the misconfiguration case — two scheduler containers running at once. Each iteration the process
-- acquires-or-renews the lease; if another live holder has it, the process records an overlap in
-- its heartbeat and skips that iteration's work instead of double-running ticks. A leased row
-- (not a session advisory lock) because Prisma's connection pool makes session locks unreliable.

CREATE TABLE "SchedulerLease" (
  "name"       VARCHAR(64)    NOT NULL,
  "holderId"   VARCHAR(64)    NOT NULL,
  "acquiredAt" TIMESTAMPTZ(6) NOT NULL,
  "renewedAt"  TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "SchedulerLease_pkey" PRIMARY KEY ("name")
);
