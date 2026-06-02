import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ServiceSection } from './service-sections';
import type { Locale } from '../app/i18n';

export type ServiceContentByLocale = Record<Locale, Record<ServiceSection, string>>;

const localeList: Locale[] = ['en', 'fi'];

const dataFilePath = join(process.cwd(), 'data', 'service-content.json');

export const defaultServiceContent: ServiceContentByLocale = {
  en: {
    shipbuilding: 'Construction, assembly and participation in shipbuilding projects.',
    steelStructures: 'Manufacturing and installation of metal structures for marine and industrial sectors.',
    welding: 'Welding, assembly and preparatory works.',
    repair: 'Repair, maintenance and restoration of vessel elements.',
    interior:
      'Marine interiors for cabins, public and crew areas: furniture installation, restaurant and bar refurbishment or new construction, ADA modifications, and floor finishing such as parquet, stone, tile, marble, vinyl and granite.'
  },
  fi: {
    shipbuilding: 'Rakentaminen, kokoonpano ja osallistuminen laivanrakennusprojekteihin.',
    steelStructures: 'Metallirakenteiden valmistus ja asennus meri- ja teollisuusalalle.',
    welding: 'Hitsaus-, asennus- ja esivalmistelutyöt.',
    repair: 'Aluksen osien korjaus, huolto ja kunnostus.',
    interior:
      'Laivojen sisätilojen kokonaistoteutukset hytteihin, yleisiin tiloihin ja miehistötiloihin: kalusteasennukset, ravintoloiden ja baarien saneeraus tai uudisrakentaminen, esteettömyysmuutokset sekä lattiafinissit kuten parketti, kivi, laatta, marmori, vinyyli ja graniitti.'
  }
};

function normalize(raw: unknown): ServiceContentByLocale {
  const normalized: ServiceContentByLocale = {
    en: { ...defaultServiceContent.en },
    fi: { ...defaultServiceContent.fi }
  };

  if (!raw || typeof raw !== 'object') {
    return normalized;
  }

  for (const locale of localeList) {
    const localeBlock = (raw as Record<string, unknown>)[locale];
    if (!localeBlock || typeof localeBlock !== 'object') {
      continue;
    }

    for (const section of Object.keys(defaultServiceContent.en) as ServiceSection[]) {
      const value = (localeBlock as Record<string, unknown>)[section];
      if (typeof value === 'string' && value.trim().length > 0) {
        normalized[locale][section] = value;
      }
    }
  }

  return normalized;
}

export async function getServiceContent(): Promise<ServiceContentByLocale> {
  try {
    const raw = await readFile(dataFilePath, 'utf8');
    return normalize(JSON.parse(raw));
  } catch {
    return normalize(null);
  }
}

export async function saveServiceContent(content: ServiceContentByLocale): Promise<void> {
  await mkdir(dirname(dataFilePath), { recursive: true });
  await writeFile(dataFilePath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}
