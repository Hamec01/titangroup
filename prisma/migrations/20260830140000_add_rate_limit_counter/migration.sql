-- R07-A — shared restart-safe rate limiting (lib/rate-limit.ts).
CREATE TABLE "RateLimitCounter" (
    "key" VARCHAR(200) NOT NULL,
    "count" INTEGER NOT NULL,
    "windowExpiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "RateLimitCounter_windowExpiresAt_idx" ON "RateLimitCounter"("windowExpiresAt");
