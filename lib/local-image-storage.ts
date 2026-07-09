import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { ServiceSection } from './service-sections';

const uploadRoot = (process.env.UPLOAD_DIR || '/app/public/uploads').replace(/\/+$/, '');

const allowedMimeTypes: Record<string, { extension: string }> = {
  'image/jpeg': { extension: 'jpg' },
  'image/png': { extension: 'png' },
  'image/webp': { extension: 'webp' },
  'image/gif': { extension: 'gif' }
};

const contentTypesByExtension: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif'
};

const maxUploadBytes = Number.parseInt(
  process.env.IMAGE_UPLOAD_MAX_BYTES || String(8 * 1024 * 1024),
  10
);

function isSafeSegment(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}

function buildSafeUploadPath(pathParts: string[]): string | null {
  if (
    pathParts.length !== 3 ||
    pathParts[0] !== 'services' ||
    pathParts.some((part) => !isSafeSegment(part))
  ) {
    return null;
  }

  return `${uploadRoot}/${pathParts.join('/')}`;
}

function getContentType(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase() || '';
  return contentTypesByExtension[extension] || 'application/octet-stream';
}

export async function saveLocalServiceImage(
  section: ServiceSection,
  file: File
): Promise<{ url: string; publicId: string }> {
  const mimeType = file.type.toLowerCase();
  const allowedType = allowedMimeTypes[mimeType];

  if (!allowedType) {
    throw new Error('Only JPEG, PNG, WebP and GIF images are allowed');
  }

  const arrayBuffer = await file.arrayBuffer();

  if (arrayBuffer.byteLength <= 0) {
    throw new Error('Image file is empty');
  }

  if (arrayBuffer.byteLength > maxUploadBytes) {
    throw new Error(`Image file is too large. Maximum size is ${maxUploadBytes} bytes`);
  }

  const filename = `${Date.now()}-${randomUUID()}.${allowedType.extension}`;
  const relativePathParts = ['services', section, filename];
  const destinationPath = buildSafeUploadPath(relativePathParts);

  if (!destinationPath) {
    throw new Error('Invalid image path');
  }

  await mkdir(`${uploadRoot}/services/${section}`, { recursive: true });
  await writeFile(destinationPath, Buffer.from(arrayBuffer), { mode: 0o600 });

  const relativePath = relativePathParts.join('/');

  return {
    url: `/uploads/${relativePath}`,
    publicId: `local:${relativePath}`
  };
}

export async function deleteLocalServiceImage(publicId: string): Promise<void> {
  if (!publicId.startsWith('local:')) {
    return;
  }

  const relativePath = publicId.slice('local:'.length);
  const pathParts = relativePath.split('/');

  const filePath = buildSafeUploadPath(pathParts);

  if (!filePath) {
    return;
  }

  await rm(filePath, { force: true });
}

export async function readLocalServiceImage(
  pathParts: string[]
): Promise<{ body: Uint8Array; contentType: string; etag: string } | null> {
  const filePath = buildSafeUploadPath(pathParts);

  if (!filePath) {
    return null;
  }

  try {
    const [metadata, body] = await Promise.all([
      stat(filePath),
      readFile(filePath)
    ]);

    if (!metadata.isFile()) {
      return null;
    }

    return {
      body: new Uint8Array(body),
      contentType: getContentType(filePath),
      etag: `"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}"`
    };
  } catch {
    return null;
  }
}
