import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { DOCUMENT_QUOTA_BYTES, deleteDocumentObject, getDocumentStream, putDocumentStream, type StoredObject } from '@/lib/document-storage';
import { archiveBaseName, archiveFormat, isJunkEntryName } from '@/lib/document-archive-format';
import { DocumentError, MAX_FOLDER_DEPTH, classifyDocument, documentMaxFileBytes, releaseDocumentReservation, reserveDocumentBytes, splitFileName } from '@/lib/documents';

/**
 * Server-side extraction of an uploaded archive into a new folder of the shared document storage.
 * The archive is copied to a private temp directory, listed and extracted by 7-Zip (p7zip-full +
 * p7zip-rar in the image: zip, rar/rar5, 7z, tar, gz), then every extracted file goes through the
 * same quota → object storage → database path as a normal upload, committed in one transaction.
 */

export const DEFAULT_ARCHIVE_MAX_ENTRIES = 5000;
const EXTRACT_TIMEOUT_MS = 15 * 60 * 1000;
const LIST_TIMEOUT_MS = 2 * 60 * 1000;
const DISK_SAFETY_MARGIN_BYTES = 2 * 1024 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;
// 7-Zip prompts for a password on encrypted entries; a fixed dummy value makes it fail instead of hang.
const NO_PASSWORD = '-ptitanor-no-password';

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  log: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip'
};

export function mimeTypeForName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** Makes one archive path segment a valid document name instead of rejecting the whole archive. */
export function sanitizeEntryName(raw: string): string {
  let name = raw.normalize('NFC').replace(/[\u0000-\u001f/\\]/gu, '_').trim();
  if (!name || name === '.' || name === '..') name = '_';
  if (name.length > 255) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 33 ? name.slice(dot) : '';
    name = name.slice(0, 255 - extension.length).trimEnd() + extension;
  }
  return name;
}

/** "Report.pdf" → "Report (2).pdf"; folders (and dot-files) get the suffix at the end. */
export function withCopySuffix(name: string, copy: number, isFile: boolean): string {
  const dot = isFile ? name.lastIndexOf('.') : -1;
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  const suffix = ` (${copy})`;
  return stem.slice(0, 255 - suffix.length - extension.length) + suffix + extension;
}

export function uniqueName(name: string, taken: Set<string>, isFile: boolean): string {
  let candidate = name;
  for (let copy = 2; taken.has(candidate.toLocaleLowerCase('en-US')); copy += 1) candidate = withCopySuffix(name, copy, isFile);
  taken.add(candidate.toLocaleLowerCase('en-US'));
  return candidate;
}

export interface ArchiveListEntry { path: string; isDir: boolean; sizeBytes: bigint; encrypted: boolean }

/** Parses `7z l -slt -ba` output: one `Key = Value` block per entry, blocks start at `Path = `. */
export function parseSevenZipListing(output: string): ArchiveListEntry[] {
  const entries: ArchiveListEntry[] = [];
  let current: Record<string, string> | null = null;
  const flush = () => {
    if (!current || current.Path === undefined) return;
    const attributes = current.Attributes ?? '';
    entries.push({
      path: current.Path,
      isDir: current.Folder === '+' || /^D/.test(attributes),
      sizeBytes: /^\d+$/.test(current.Size ?? '') ? BigInt(current.Size) : BigInt(0),
      encrypted: current.Encrypted === '+'
    });
  };
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Za-z ]+?) = (.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === 'Path') { flush(); current = {}; }
    if (current) current[match[1]] = match[2];
  }
  flush();
  return entries;
}

export interface PlannedFolder { key: string; parentKey: string | null; name: string }
export interface PlannedFile { parentKey: string | null; name: string; diskPath: string; sizeBytes: bigint }
export interface ExtractionPlan { rootName: string; folders: PlannedFolder[]; files: PlannedFile[]; skipped: number; depth: number }

type ScannedNode = { name: string; diskPath: string; isDir: boolean; sizeBytes: bigint; children: ScannedNode[] };

async function scanDirectory(dir: string, counter: { entries: number; skipped: number; max: number }): Promise<ScannedNode[]> {
  const nodes: ScannedNode[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const diskPath = path.join(dir, entry.name);
    // Symlinks, devices and sockets are never followed or stored.
    if (isJunkEntryName(entry.name) || (!entry.isDirectory() && !entry.isFile())) { counter.skipped += 1; continue; }
    counter.entries += 1;
    if (counter.entries > counter.max) throw new DocumentError('ARCHIVE_TOO_MANY_ENTRIES', '', 413);
    if (entry.isDirectory()) nodes.push({ name: entry.name, diskPath, isDir: true, sizeBytes: BigInt(0), children: await scanDirectory(diskPath, counter) });
    else nodes.push({ name: entry.name, diskPath, isDir: false, sizeBytes: BigInt((await stat(diskPath)).size), children: [] });
  }
  return nodes;
}

/**
 * Turns the extracted tree into folders/files with valid, case-insensitively unique names. When the
 * archive holds exactly one top-level folder (the usual "Project.zip → Project/…" shape), that folder
 * becomes the target instead of being nested inside a second folder of the same meaning.
 */
export async function planExtraction(outDir: string, archiveName: string, maxEntries: number): Promise<ExtractionPlan> {
  const counter = { entries: 0, skipped: 0, max: maxEntries };
  let roots = await scanDirectory(outDir, counter);
  let rootName = sanitizeEntryName(archiveBaseName(archiveName));
  if (roots.length === 1 && roots[0].isDir) { rootName = sanitizeEntryName(roots[0].name); roots = roots[0].children; }
  const folders: PlannedFolder[] = [];
  const files: PlannedFile[] = [];
  let depth = 1;
  const visit = (nodes: ScannedNode[], parentKey: string | null, level: number) => {
    const takenFolders = new Set<string>();
    const takenFiles = new Set<string>();
    for (const node of [...nodes].sort((a, b) => a.name.localeCompare(b.name))) {
      if (node.isDir) {
        const key = `${parentKey ?? ''}/${folders.length}`;
        folders.push({ key, parentKey, name: uniqueName(sanitizeEntryName(node.name), takenFolders, false) });
        depth = Math.max(depth, level + 1);
        visit(node.children, key, level + 1);
      } else {
        files.push({ parentKey, name: uniqueName(sanitizeEntryName(node.name), takenFiles, true), diskPath: node.diskPath, sizeBytes: node.sizeBytes });
      }
    }
  };
  visit(roots, null, 1);
  return { rootName, folders, files, skipped: counter.skipped, depth };
}

function sevenZipBinary(): string {
  return process.env.DOCUMENT_ARCHIVE_7Z_BIN?.trim() || '7z';
}

function runSevenZip(args: string[], timeoutMs: number, watchdog?: () => Promise<boolean>): Promise<{ code: number | null; output: string; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZipBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let aborted = false;
    const collect = (chunk: Buffer) => { if (size < 64 * 1024 * 1024) { chunks.push(chunk); size += chunk.length; } };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const poll = watchdog ? setInterval(() => { void watchdog().then((stop) => { if (stop) { aborted = true; child.kill('SIGKILL'); } }); }, 1000) : null;
    child.on('error', (error) => { clearTimeout(timer); if (poll) clearInterval(poll); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); if (poll) clearInterval(poll); resolve({ code, output: Buffer.concat(chunks).toString('utf8'), timedOut, aborted }); });
  });
}

function sevenZipError(result: { output: string; timedOut: boolean; aborted: boolean }): DocumentError {
  if (result.timedOut) return new DocumentError('ARCHIVE_EXTRACTION_TIMEOUT', '', 422);
  if (result.aborted) return new DocumentError('ARCHIVE_TOO_LARGE', '', 413);
  if (/wrong password|encrypted/i.test(result.output)) return new DocumentError('ARCHIVE_ENCRYPTED', '', 422);
  if (/can ?not open .* as archive|is not archive|unsupported/i.test(result.output)) return new DocumentError('ARCHIVE_INVALID', '', 422);
  return new DocumentError('ARCHIVE_EXTRACTION_FAILED', '', 422);
}

async function listArchive(archivePath: string): Promise<ArchiveListEntry[]> {
  const result = await runSevenZip(['l', '-slt', '-ba', NO_PASSWORD, '--', archivePath], LIST_TIMEOUT_MS);
  if (result.code !== 0) throw sevenZipError(result);
  return parseSevenZipListing(result.output);
}

async function freeDiskBytes(dir: string): Promise<bigint> {
  const fs = await statfs(dir, { bigint: true });
  return fs.bavail * fs.bsize;
}

/** Extracts with a disk watchdog: 7-Zip is killed if it writes more than the listing promised. */
async function extractArchive(archivePath: string, outDir: string, allowedBytes: bigint): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const startFree = await freeDiskBytes(outDir);
  const slack = BigInt(256 * 1024 * 1024);
  const result = await runSevenZip(['x', '-y', '-bd', NO_PASSWORD, `-o${outDir}`, '--', archivePath], EXTRACT_TIMEOUT_MS, async () => {
    const free = await freeDiskBytes(outDir).catch(() => startFree);
    return free < BigInt(DISK_SAFETY_MARGIN_BYTES) || startFree - free > allowedBytes + slack;
  });
  if (result.code !== 0 || result.timedOut || result.aborted) throw sevenZipError(result);
}

async function mapWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (failure === null && next < items.length) {
      const item = items[next];
      next += 1;
      try { await worker(item); } catch (error) { failure ??= error; }
    }
  });
  await Promise.all(lanes);
  if (failure !== null) throw failure;
}

async function folderDepth(folderId: string | null, storageSpaceId: string): Promise<number> {
  let depth = 0;
  for (let cursor = folderId; cursor; depth += 1) {
    if (depth > MAX_FOLDER_DEPTH) break;
    const row: { parentId: string | null } | null = await prisma.documentFolder.findFirst({ where: { id: cursor, storageSpaceId }, select: { parentId: true } });
    if (!row) throw new DocumentError('FOLDER_NOT_FOUND', '', 404);
    cursor = row.parentId;
  }
  return depth;
}

let extractionRunning = false;

export interface ArchiveExtractionResult { folder: { id: string; name: string; parentId: string | null }; fileCount: number; folderCount: number; totalBytes: bigint; skipped: number }

export async function extractDocumentArchive(input: { fileId: string; actorUserId: string; requestId: string }): Promise<ArchiveExtractionResult> {
  const archive = await prisma.documentFile.findFirst({ where: { id: input.fileId, status: 'ACTIVE' } });
  if (!archive) throw new DocumentError('FILE_NOT_FOUND', '', 404);
  const format = archiveFormat(archive.displayName) ?? archiveFormat(archive.originalName);
  if (!format) throw new DocumentError('ARCHIVE_UNSUPPORTED', '', 422);
  // One extraction at a time: it is disk- and CPU-heavy on a shared host.
  if (extractionRunning) throw new DocumentError('ARCHIVE_EXTRACTION_BUSY', '', 409);
  extractionRunning = true;
  let workDir: string | null = null;
  const stored: StoredObject[] = [];
  let reservationId: string | null = null;
  try {
    workDir = await mkdtemp(path.join(tmpdir(), 'titanor-archive-'));
    const maxEntries = Number(process.env.DOCUMENT_ARCHIVE_MAX_ENTRIES || DEFAULT_ARCHIVE_MAX_ENTRIES);
    const maxFile = documentMaxFileBytes();
    const space = await prisma.storageSpace.findUniqueOrThrow({ where: { id: archive.storageSpaceId } });
    const freeQuota = space.quotaBytes - space.usedBytes - space.reservedBytes;
    const parentDepth = await folderDepth(archive.folderId, archive.storageSpaceId);

    if ((await freeDiskBytes(workDir)) < archive.sizeBytes + BigInt(DISK_SAFETY_MARGIN_BYTES)) throw new DocumentError('ARCHIVE_DISK_FULL', '', 507);
    const archivePath = path.join(workDir, `archive.${format === 'tar.gz' ? 'tgz' : format}`);
    const source = await getDocumentStream(archive.storageKey);
    await pipeline(Readable.fromWeb(source.body as never), createWriteStream(archivePath, { mode: 0o600 }));

    // Pre-check from the archive's own table of contents before writing anything to disk.
    const listing = await listArchive(archivePath);
    if (listing.some((entry) => entry.encrypted)) throw new DocumentError('ARCHIVE_ENCRYPTED', '', 422);
    if (listing.length > maxEntries) throw new DocumentError('ARCHIVE_TOO_MANY_ENTRIES', '', 413);
    const declared = listing.reduce((sum, entry) => sum + (entry.isDir ? BigInt(0) : entry.sizeBytes), BigInt(0));
    if (listing.some((entry) => !entry.isDir && entry.sizeBytes > maxFile)) throw new DocumentError('FILE_TOO_LARGE', '', 413);
    // A plain .gz header only records the size modulo 4 GiB, so it cannot bound the output.
    const allowed = format === 'gz' || format === 'tar.gz' ? (freeQuota < maxFile ? freeQuota : maxFile) : declared;
    if (declared > freeQuota || declared > DOCUMENT_QUOTA_BYTES) throw new DocumentError('STORAGE_QUOTA_EXCEEDED', '', 409);
    if ((await freeDiskBytes(workDir)) < allowed + BigInt(DISK_SAFETY_MARGIN_BYTES)) throw new DocumentError('ARCHIVE_DISK_FULL', '', 507);

    let outDir = path.join(workDir, 'out');
    await extractArchive(archivePath, outDir, allowed);
    await rm(archivePath, { force: true });
    if (format === 'tar.gz') {
      const inner = await readdir(outDir);
      if (inner.length === 1 && inner[0].toLowerCase().endsWith('.tar')) {
        const tarPath = path.join(outDir, inner[0]);
        const tarDeclared = (await listArchive(tarPath)).reduce((sum, entry) => sum + (entry.isDir ? BigInt(0) : entry.sizeBytes), BigInt(0));
        if (tarDeclared > freeQuota) throw new DocumentError('STORAGE_QUOTA_EXCEEDED', '', 409);
        const tarOut = path.join(workDir, 'out-tar');
        await extractArchive(tarPath, tarOut, tarDeclared);
        await rm(outDir, { recursive: true, force: true });
        outDir = tarOut;
      }
    }

    const plan = await planExtraction(outDir, archive.displayName, maxEntries);
    if (parentDepth + plan.depth > MAX_FOLDER_DEPTH) throw new DocumentError('FOLDER_DEPTH_EXCEEDED', '', 409);
    if (plan.files.some((file) => file.sizeBytes > maxFile)) throw new DocumentError('FILE_TOO_LARGE', '', 413);
    const totalBytes = plan.files.reduce((sum, file) => sum + file.sizeBytes, BigInt(0));
    reservationId = totalBytes > BigInt(0) ? (await reserveDocumentBytes(input.actorUserId, totalBytes, { batch: true })).id : null;

    const storedByPath = new Map<string, StoredObject>();
    await mapWithConcurrency(plan.files, UPLOAD_CONCURRENCY, async (file) => {
      const body = file.sizeBytes === BigInt(0) ? null : Readable.toWeb(createReadStream(file.diskPath)) as ReadableStream<Uint8Array>;
      const object = await putDocumentStream(body, file.sizeBytes, mimeTypeForName(file.name));
      stored.push(object);
      storedByPath.set(file.diskPath, object);
    });

    const committedReservation = reservationId;
    const result = await prisma.$transaction(async (tx) => {
      const reservation = committedReservation ? await tx.documentUploadReservation.findUnique({ where: { id: committedReservation } }) : null;
      if (committedReservation && (!reservation || reservation.sizeBytes !== totalBytes)) throw new DocumentError('UPLOAD_RESERVATION_INVALID', '', 409);
      const current = await tx.documentFile.findFirst({ where: { id: archive.id, status: 'ACTIVE' }, select: { folderId: true } });
      if (!current) throw new DocumentError('FILE_NOT_FOUND', '', 404);
      const siblings = await tx.documentFolder.findMany({ where: { storageSpaceId: archive.storageSpaceId, parentId: current.folderId }, select: { normalizedName: true } });
      const rootName = uniqueName(plan.rootName, new Set(siblings.map((s) => s.normalizedName)), false);
      const root = await tx.documentFolder.create({ data: { storageSpaceId: archive.storageSpaceId, parentId: current.folderId, name: rootName, normalizedName: rootName.toLocaleLowerCase('en-US'), createdByUserId: input.actorUserId } });
      const folderIds = new Map<string | null, string>([[null, root.id]]);
      for (const folder of plan.folders) {
        const created = await tx.documentFolder.create({ data: { storageSpaceId: archive.storageSpaceId, parentId: folderIds.get(folder.parentKey)!, name: folder.name, normalizedName: folder.name.toLocaleLowerCase('en-US'), createdByUserId: input.actorUserId }, select: { id: true } });
        folderIds.set(folder.key, created.id);
      }
      const rows = plan.files.map((file) => {
        const parsed = splitFileName(file.name);
        const mimeType = mimeTypeForName(file.name);
        const object = storedByPath.get(file.diskPath)!;
        return { storageSpaceId: archive.storageSpaceId, folderId: folderIds.get(file.parentKey)!, originalName: parsed.name, displayName: parsed.name, normalizedName: parsed.normalizedName, extension: parsed.extension, mimeType, category: classifyDocument(mimeType, parsed.extension), sizeBytes: object.sizeBytes, storageKey: object.storageKey, checksumSha256: object.checksumSha256, createdByUserId: input.actorUserId };
      });
      for (let i = 0; i < rows.length; i += 500) await tx.documentFile.createMany({ data: rows.slice(i, i + 500) });
      if (reservation) {
        await tx.documentUploadReservation.delete({ where: { id: reservation.id } });
        await tx.storageSpace.update({ where: { id: reservation.storageSpaceId }, data: { reservedBytes: { decrement: reservation.sizeBytes }, usedBytes: { increment: reservation.sizeBytes } } });
      }
      await createAuditEvent(tx, { actorUserId: input.actorUserId, eventType: 'DOCUMENT_ARCHIVE_EXTRACTED', entityType: 'DOCUMENT_FILE', entityId: archive.id, requestId: input.requestId, afterValue: { archiveName: archive.displayName, folderId: root.id, folderName: root.name, parentId: root.parentId, fileCount: rows.length, folderCount: plan.folders.length + 1, totalBytes: totalBytes.toString(), skippedEntries: plan.skipped } });
      return root;
    }, { maxWait: 10_000, timeout: 120_000 });
    reservationId = null;
    stored.length = 0;
    return { folder: { id: result.id, name: result.name, parentId: result.parentId }, fileCount: plan.files.length, folderCount: plan.folders.length + 1, totalBytes, skipped: plan.skipped };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new DocumentError('DOCUMENT_NAME_CONFLICT', '', 409);
    throw error;
  } finally {
    // Objects uploaded for a failed extraction are never referenced by a row; remove them.
    await Promise.all(stored.map((object) => deleteDocumentObject(object.storageKey).catch(() => undefined)));
    if (reservationId) await releaseDocumentReservation(reservationId).catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    extractionRunning = false;
  }
}
