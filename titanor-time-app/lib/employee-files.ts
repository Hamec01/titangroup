import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

// Worker Profile feature (2026-08-24 plan) — the app's first and only file-upload surface.
// Photos (profile photo, qualification card photo) are ALWAYS re-encoded through sharp on
// the way in and never stored as uploaded: the original buffer only ever lives in memory for
// the duration of the request, never written to disk, so there is nothing to "clean up"
// afterward. The contract (frequently a PDF) is stored as-is, size-capped only.

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads', 'employees');

const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
// Raw upload cap, checked BEFORE the file is buffered/decoded — MAX_IMAGE_BYTES above is the
// output cap, enforced only after sharp has already re-encoded a (by then trusted-size) input.
// Without this, an arbitrarily large multipart body claiming image/jpeg would be buffered into
// memory in full before sharp ever ran (security audit finding, 2026-08-24).
const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1600;
const MIN_JPEG_QUALITY = 30;

const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png']);
const ALLOWED_DOCUMENT_MIME = new Set(['image/jpeg', 'image/png', 'application/pdf']);

export type EmployeeImageKind = 'photo' | 'qualification-photo';

export interface SavedEmployeeUpload {
  /** Stored in the DB as-is (e.g. EmployeeProfile.photoPath) — always our own generated path, never client input. */
  relativePath: string;
  contentType: string;
}

export class EmployeeUploadError extends Error {
  code: 'UNSUPPORTED_TYPE' | 'TOO_LARGE';
  constructor(code: 'UNSUPPORTED_TYPE' | 'TOO_LARGE', message: string) {
    super(message);
    this.code = code;
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Resizes to fit within MAX_IMAGE_DIMENSION and steps JPEG quality down until the result is
 * at or under MAX_IMAGE_BYTES (or MIN_JPEG_QUALITY is reached — a 1600px-max JPEG at quality
 * 30 is already far below 2.5MB for any real photo, so this floor is just a safety stop, not
 * expected to bind in practice). */
async function reencodeImage(buffer: Buffer): Promise<Buffer> {
  const base = sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: 'inside', withoutEnlargement: true });
  let quality = 82;
  let output = await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
  while (output.byteLength > MAX_IMAGE_BYTES && quality > MIN_JPEG_QUALITY) {
    quality -= 12;
    output = await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  return output;
}

export async function saveEmployeeImageUpload(employeeId: string, kind: EmployeeImageKind, file: File): Promise<SavedEmployeeUpload> {
  if (!ALLOWED_IMAGE_MIME.has(file.type)) {
    throw new EmployeeUploadError('UNSUPPORTED_TYPE', `Unsupported image type: ${file.type}`);
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new EmployeeUploadError('TOO_LARGE', 'File exceeds the upload limit.');
  }
  const inputBuffer = Buffer.from(await file.arrayBuffer());
  const outputBuffer = await reencodeImage(inputBuffer);
  const dir = path.join(UPLOAD_ROOT, employeeId, kind);
  await ensureDir(dir);
  const filename = `${randomUUID()}.jpg`;
  await writeFile(path.join(dir, filename), outputBuffer);
  return { relativePath: path.posix.join(employeeId, kind, filename), contentType: 'image/jpeg' };
}

export async function saveEmployeeDocumentUpload(employeeId: string, file: File): Promise<SavedEmployeeUpload> {
  if (!ALLOWED_DOCUMENT_MIME.has(file.type)) {
    throw new EmployeeUploadError('UNSUPPORTED_TYPE', `Unsupported document type: ${file.type}`);
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new EmployeeUploadError('TOO_LARGE', 'File exceeds the 8MB limit.');
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const dir = path.join(UPLOAD_ROOT, employeeId, 'contract');
  await ensureDir(dir);
  const ext = file.type === 'application/pdf' ? 'pdf' : file.type === 'image/png' ? 'png' : 'jpg';
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(path.join(dir, filename), buffer);
  return { relativePath: path.posix.join(employeeId, 'contract', filename), contentType: file.type };
}

/** `relativePath` is always a value we generated ourselves and stored in the DB (never
 * client-supplied) — this still normalizes+contains it defensively so a corrupted/tampered
 * stored value can never resolve outside UPLOAD_ROOT. */
function resolveStoredPath(relativePath: string): string {
  const resolved = path.normalize(path.join(UPLOAD_ROOT, relativePath));
  if (!resolved.startsWith(path.normalize(UPLOAD_ROOT + path.sep))) {
    throw new Error('Resolved upload path escapes the upload root');
  }
  return resolved;
}

export async function readEmployeeUpload(relativePath: string): Promise<Buffer> {
  return readFile(resolveStoredPath(relativePath));
}

export async function deleteEmployeeUpload(relativePath: string): Promise<void> {
  await rm(resolveStoredPath(relativePath), { force: true });
}
