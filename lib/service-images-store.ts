import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { serviceSections, type ServiceSection } from './service-sections';

export type StoredServiceImage = {
  url: string;
  publicId: string | null;
};

export type StoredServiceImages = Record<ServiceSection, StoredServiceImage[]>;

export const defaultServiceImageUrls: Record<ServiceSection, string[]> = {
  shipbuilding: [
    '/assets/industry/hero-shipyard.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/3/37/Meyer_Werft_Dockhalle_6.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/5/59/Shipyard_Gdansk_2009.jpg'
  ],
  steelStructures: [
    'https://images.unsplash.com/photo-1504307651254-35680f356dfd?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1581092580497-e0d23cbdf1dc?auto=format&fit=crop&w=1200&q=80'
  ],
  welding: [
    '/assets/industry/service-welding.jpg',
    'https://images.unsplash.com/photo-1565431183833-1c9f3a414f00?auto=format&fit=crop&w=1200&q=80'
  ],
  repair: [
    '/assets/industry/service-repair.jpg',
    'https://images.unsplash.com/photo-1489515217757-5fd1be406fef?auto=format&fit=crop&w=1200&q=80'
  ],
  interior: [
    'https://upload.wikimedia.org/wikipedia/commons/4/4c/Color_Line_Magic_Interior.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/1/16/MS_Crown_Seaways_cabin.jpg'
  ]
};

export const defaultStoredServiceImages: StoredServiceImages = {
  shipbuilding: defaultServiceImageUrls.shipbuilding.map((url) => ({ url, publicId: null })),
  steelStructures: defaultServiceImageUrls.steelStructures.map((url) => ({ url, publicId: null })),
  welding: defaultServiceImageUrls.welding.map((url) => ({ url, publicId: null })),
  repair: defaultServiceImageUrls.repair.map((url) => ({ url, publicId: null })),
  interior: defaultServiceImageUrls.interior.map((url) => ({ url, publicId: null }))
};

const dataFilePath = join(process.cwd(), 'data', 'service-images.json');

function isSection(value: string): value is ServiceSection {
  return serviceSections.includes(value as ServiceSection);
}

function normalizeImages(value: unknown): StoredServiceImage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry): StoredServiceImage | null => {
      if (typeof entry === 'string') {
        return { url: entry, publicId: null };
      }

      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const maybeUrl = (entry as { url?: unknown }).url;
      const maybePublicId = (entry as { publicId?: unknown }).publicId;

      if (typeof maybeUrl !== 'string' || maybeUrl.trim().length === 0) {
        return null;
      }

      return {
        url: maybeUrl,
        publicId: typeof maybePublicId === 'string' && maybePublicId.length > 0 ? maybePublicId : null
      };
    })
    .filter((entry): entry is StoredServiceImage => entry !== null);
}

function normalizeStoredImages(raw: unknown): StoredServiceImages {
  const normalized: StoredServiceImages = {
    shipbuilding: [...defaultStoredServiceImages.shipbuilding],
    steelStructures: [...defaultStoredServiceImages.steelStructures],
    welding: [...defaultStoredServiceImages.welding],
    repair: [...defaultStoredServiceImages.repair],
    interior: [...defaultStoredServiceImages.interior]
  };

  if (!raw || typeof raw !== 'object') {
    return normalized;
  }

  for (const [key, value] of Object.entries(raw)) {
    if (!isSection(key)) {
      continue;
    }

    const parsed = normalizeImages(value);
    if (parsed.length > 0) {
      normalized[key] = parsed;
    }
  }

  return normalized;
}

export async function getStoredServiceImages(): Promise<StoredServiceImages> {
  try {
    const raw = await readFile(dataFilePath, 'utf8');
    return normalizeStoredImages(JSON.parse(raw));
  } catch {
    return normalizeStoredImages(null);
  }
}

export async function saveStoredServiceImages(images: StoredServiceImages): Promise<void> {
  await mkdir(dirname(dataFilePath), { recursive: true });
  await writeFile(dataFilePath, `${JSON.stringify(images, null, 2)}\n`, 'utf8');
}

export async function getServiceImageUrls(): Promise<Record<ServiceSection, string[]>> {
  const images = await getStoredServiceImages();

  return {
    shipbuilding: images.shipbuilding.map((item) => item.url),
    steelStructures: images.steelStructures.map((item) => item.url),
    welding: images.welding.map((item) => item.url),
    repair: images.repair.map((item) => item.url),
    interior: images.interior.map((item) => item.url)
  };
}

export async function addServiceImage(section: ServiceSection, image: StoredServiceImage): Promise<StoredServiceImages> {
  const images = await getStoredServiceImages();
  images[section] = [...images[section], image];
  await saveStoredServiceImages(images);
  return images;
}

export async function removeServiceImage(
  section: ServiceSection,
  params: { publicId?: string; url?: string }
): Promise<StoredServiceImages> {
  const images = await getStoredServiceImages();

  images[section] = images[section].filter((image) => {
    if (params.publicId && image.publicId === params.publicId) {
      return false;
    }

    if (params.url && image.url === params.url) {
      return false;
    }

    return true;
  });

  await saveStoredServiceImages(images);
  return images;
}

export function isServiceSection(value: string): value is ServiceSection {
  return isSection(value);
}
