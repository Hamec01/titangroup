import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export const DOCUMENT_QUOTA_BYTES = BigInt(10) * BigInt(1024) * BigInt(1024) * BigInt(1024);
export const DEFAULT_MAX_FILE_BYTES = BigInt(2) * BigInt(1024) * BigInt(1024) * BigInt(1024);

export class DocumentStorageUnavailableError extends Error {}

export interface StoredObject {
  storageKey: string;
  sizeBytes: bigint;
  checksumSha256: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new DocumentStorageUnavailableError(`Missing ${name}`);
  return value;
}

let cachedClient: S3Client | null = null;
function config() {
  const endpoint = required('DOCUMENT_STORAGE_ENDPOINT');
  const bucket = required('DOCUMENT_STORAGE_BUCKET');
  const region = process.env.DOCUMENT_STORAGE_REGION?.trim() || 'usc1';
  const accessKeyId = required('DOCUMENT_STORAGE_ACCESS_KEY_ID');
  const secretAccessKey = required('DOCUMENT_STORAGE_SECRET_ACCESS_KEY');
  cachedClient ??= new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  return { client: cachedClient, bucket, prefix: (process.env.DOCUMENT_STORAGE_PREFIX?.trim() || 'titanor-time-foundation/documents').replace(/^\/+|\/+$/g, '') };
}

export function documentStorageConfigured(): boolean {
  return ['DOCUMENT_STORAGE_ENDPOINT', 'DOCUMENT_STORAGE_BUCKET', 'DOCUMENT_STORAGE_ACCESS_KEY_ID', 'DOCUMENT_STORAGE_SECRET_ACCESS_KEY'].every((key) => Boolean(process.env[key]?.trim()));
}

export function makeStorageKey(): string {
  const id = randomUUID();
  const { prefix } = config();
  return `${prefix}/objects/${id.slice(0, 2)}/${id}`;
}

export async function putDocumentStream(body: ReadableStream<Uint8Array>, expectedBytes: bigint, mimeType: string): Promise<StoredObject> {
  const { client, bucket } = config();
  const storageKey = makeStorageKey();
  const hash = createHash('sha256');
  let actualBytes = BigInt(0);
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      actualBytes += BigInt(chunk.length);
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  const source = Readable.fromWeb(body as never).pipe(hashing);
  try {
    await new Upload({
      client,
      params: { Bucket: bucket, Key: storageKey, Body: source, ContentType: mimeType, ContentLength: Number(expectedBytes) },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false
    }).done();
    if (actualBytes !== expectedBytes) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey })).catch(() => undefined);
      throw new Error('DOCUMENT_UPLOAD_SIZE_MISMATCH');
    }
    return { storageKey, sizeBytes: actualBytes, checksumSha256: hash.digest('hex') };
  } catch (error) {
    if (error instanceof Error && error.message === 'DOCUMENT_UPLOAD_SIZE_MISMATCH') throw error;
    throw new DocumentStorageUnavailableError('Remote document storage is unavailable');
  }
}

export async function getDocumentStream(storageKey: string): Promise<{ body: ReadableStream<Uint8Array>; contentLength: number | null }> {
  const { client, bucket } = config();
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
    if (!result.Body) throw new Error('missing body');
    return { body: result.Body.transformToWebStream(), contentLength: result.ContentLength ?? null };
  } catch {
    throw new DocumentStorageUnavailableError('Remote document storage is unavailable');
  }
}

export async function deleteDocumentObject(storageKey: string): Promise<void> {
  const { client, bucket } = config();
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
  } catch {
    throw new DocumentStorageUnavailableError('Remote document storage is unavailable');
  }
}

export async function documentObjectExists(storageKey: string): Promise<boolean> {
  const { client, bucket } = config();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));
    return true;
  } catch {
    return false;
  }
}
