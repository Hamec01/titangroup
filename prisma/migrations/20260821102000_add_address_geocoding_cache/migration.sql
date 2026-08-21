-- Server-side cache and cross-process rate gate for deliberate, button-triggered Nominatim
-- searches. Site addresses are operational data, never worker GPS data.
CREATE TABLE "AddressGeocodeCache" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "queryHash" char(64) NOT NULL,
  "queryNormalized" varchar(200) NOT NULL,
  "results" jsonb NOT NULL,
  "fetchedAt" timestamptz(6) NOT NULL,
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AddressGeocodeCache_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_address_geocode_cache_query_hash" CHECK ("queryHash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "AddressGeocodeCache_queryHash_key" ON "AddressGeocodeCache"("queryHash");
CREATE INDEX "AddressGeocodeCache_fetchedAt_idx" ON "AddressGeocodeCache"("fetchedAt");

CREATE TABLE "GeocodingProviderState" (
  "provider" varchar(32) NOT NULL,
  "lastRequestAt" timestamptz(6) NOT NULL,
  CONSTRAINT "GeocodingProviderState_pkey" PRIMARY KEY ("provider")
);
