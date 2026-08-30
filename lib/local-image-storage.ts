import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import sharp from 'sharp';
import type { ServiceSection } from './service-sections';

const uploadRoot = (process.env.UPLOAD_DIR || '/app/public/uploads').replace(/\/+$/, '');

// R07-B — approved raster formats only. GIF is rejected outright (animation / polyglot surface,
// and the site has no use for it). Format is decided by the file's magic bytes, never by the
// client-supplied Content-Type.
type ApprovedFormat = 'jpeg' | 'png' | 'webp';

const extensionByFormat: Record<ApprovedFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp'
};

const contentTypesByExtension: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
};

const maxUploadBytes = Number.parseInt(
  process.env.IMAGE_UPLOAD_MAX_BYTES || String(8 * 1024 * 1024),
  10
);

// Largest edge we keep. Normal photos pass through untouched; only absurd inputs are shrunk.
const MAX_IMAGE_EDGE = 4096;

/**
 * R07-B — identify a raster image from its leading bytes. Returns an approved format, `'gif'`
 * (recognised only so the caller can reject it explicitly), or `null` for anything unrecognised.
 */
export function sniffImageFormat(bytes: Uint8Array): ApprovedFormat | 'gif' | null {
  if (bytes.length < 12) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'png';
  }

  // GIF: "GIF87a" / "GIF89a"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif';

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'webp';
  }

  return null;
}

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

  // Defence in depth: even though every segment is already `[A-Za-z0-9._-]+` and not `.`/`..`,
  // confirm the resolved path stays inside the upload root before any fs call touches it.
  const rootAbs = resolve(uploadRoot);
  const target = resolve(rootAbs, pathParts.join('/'));
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    return null;
  }

  return target;
}

function getContentType(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase() || '';
  return contentTypesByExtension[extension] || 'application/octet-stream';
}

async function reencode(format: ApprovedFormat, input: Buffer): Promise<Buffer> {
  // failOn:'error' — reject a truncated / malformed image instead of writing a partial re-encode.
  // .rotate() with no argument bakes in EXIF orientation; sharp drops all other metadata by
  // default, so the output carries no EXIF/GPS/ICC/XMP and no trailing bytes past the image.
  const pipeline = sharp(input, { failOn: 'error', animated: false })
    .rotate()
    .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true });

  if (format === 'jpeg') return pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  if (format === 'png') return pipeline.png({ compressionLevel: 9 }).toBuffer();
  return pipeline.webp({ quality: 82 }).toBuffer();
}

export async function saveLocalServiceImage(
  section: ServiceSection,
  file: File
): Promise<{ url: string; publicId: string }> {
  // R07-B — reject on the declared size before a single byte is read into memory.
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new Error('Image file is empty');
  }
  if (file.size > maxUploadBytes) {
    throw new Error(`Image file is too large. Maximum size is ${maxUploadBytes} bytes`);
  }

  const arrayBuffer = await file.arrayBuffer();
  const inputBuffer = Buffer.from(arrayBuffer);

  if (inputBuffer.byteLength <= 0) {
    throw new Error('Image file is empty');
  }
  // The stream can exceed a truthful `size`; re-check the real length.
  if (inputBuffer.byteLength > maxUploadBytes) {
    throw new Error(`Image file is too large. Maximum size is ${maxUploadBytes} bytes`);
  }

  const detected = sniffImageFormat(inputBuffer);
  if (detected === 'gif') {
    throw new Error('GIF images are not supported. Upload a JPEG, PNG or WebP file.');
  }
  if (detected === null) {
    throw new Error('Unsupported image. Upload a JPEG, PNG or WebP file.');
  }

  let outputBuffer: Buffer;
  try {
    outputBuffer = await reencode(detected, inputBuffer);
  } catch {
    throw new Error('The image could not be processed. Upload a valid JPEG, PNG or WebP file.');
  }

  const extension = extensionByFormat[detected];
  const filename = `${Date.now()}-${randomUUID()}.${extension}`;
  const relativePathParts = ['services', section, filename];
  const destinationPath = buildSafeUploadPath(relativePathParts);

  if (!destinationPath) {
    throw new Error('Invalid image path');
  }

  try {
    await mkdir(resolve(uploadRoot, 'services', section), { recursive: true });
    await writeFile(destinationPath, outputBuffer, { mode: 0o600 });
  } catch (error) {
    console.error(`local-image-storage: write failed [${(error as { code?: string })?.code ?? 'UNKNOWN'}]`);
    throw new Error('The image could not be saved. Please try again.');
  }

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
): Promise<{ body: Uint8Array; contentType: string; etag: string; filename: string } | null> {
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
      etag: `"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}"`,
      filename: pathParts[pathParts.length - 1]
    };
  } catch {
    return null;
  }
}
