import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PROVIDER_INTERVAL_MS = 1_100;

export interface AddressSearchResult {
  displayName: string;
  latitude: string;
  longitude: string;
}

type SearchOutcome = { ok: true; items: AddressSearchResult[]; cached: boolean } | { ok: false; code: 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' };

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').slice(0, 200);
}

function validCoordinate(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return number.toFixed(6);
}

export async function searchSiteAddress(query: string): Promise<SearchOutcome> {
  const normalized = normalizeQuery(query);
  const queryHash = createHash('sha256').update(normalized.toLocaleLowerCase('en-US')).digest('hex');
  const cached = await prisma.addressGeocodeCache.findUnique({ where: { queryHash } });
  if (cached && Date.now() - cached.fetchedAt.getTime() <= CACHE_MAX_AGE_MS) {
    return { ok: true, items: cached.results as unknown as AddressSearchResult[], cached: true };
  }

  const reserved = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('titanor-time:nominatim'))`;
    const state = await tx.geocodingProviderState.findUnique({ where: { provider: 'NOMINATIM' } });
    const now = new Date();
    if (state && now.getTime() - state.lastRequestAt.getTime() < MIN_PROVIDER_INTERVAL_MS) return false;
    await tx.geocodingProviderState.upsert({
      where: { provider: 'NOMINATIM' },
      create: { provider: 'NOMINATIM', lastRequestAt: now },
      update: { lastRequestAt: now }
    });
    return true;
  });
  if (!reserved) return { ok: false, code: 'RATE_LIMITED' };

  try {
    const endpoint = process.env.NOMINATIM_SEARCH_URL ?? 'https://nominatim.openstreetmap.org/search';
    const url = new URL(endpoint);
    url.searchParams.set('q', normalized);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '5');
    url.searchParams.set('addressdetails', '0');
    const response = await fetch(url, {
      headers: {
        'User-Agent': process.env.NOMINATIM_USER_AGENT ?? 'TitanorTime/1.0 (https://titanorgroup.fi; site geofence search)',
        'Accept-Language': 'en,fi;q=0.9,ru;q=0.8'
      },
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store'
    });
    if (!response.ok) return { ok: false, code: 'PROVIDER_UNAVAILABLE' };
    const raw = await response.json() as unknown;
    if (!Array.isArray(raw)) return { ok: false, code: 'PROVIDER_UNAVAILABLE' };
    const items: AddressSearchResult[] = raw.slice(0, 5).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      const latitude = validCoordinate(row.lat, -90, 90);
      const longitude = validCoordinate(row.lon, -180, 180);
      if (!latitude || !longitude || typeof row.display_name !== 'string') return [];
      return [{ displayName: row.display_name.slice(0, 300), latitude, longitude }];
    });
    await prisma.addressGeocodeCache.upsert({
      where: { queryHash },
      create: { queryHash, queryNormalized: normalized, results: items as unknown as Prisma.InputJsonValue, fetchedAt: new Date() },
      update: { queryNormalized: normalized, results: items as unknown as Prisma.InputJsonValue, fetchedAt: new Date() }
    });
    return { ok: true, items, cached: false };
  } catch {
    return { ok: false, code: 'PROVIDER_UNAVAILABLE' };
  }
}
