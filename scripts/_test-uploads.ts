// R07-B — uploads: magic-byte format check, GIF rejected, size-before-processing, sharp re-encode
// that strips metadata, path-traversal containment, and nosniff / Content-Disposition on serving.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

function fakeFile(bytes: Buffer, type: string, name = 'upload', sizeOverride?: number): File {
  return {
    name,
    type,
    size: sizeOverride ?? bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  } as unknown as File;
}

async function main() {
  const uploadRoot = mkdtempSync(join(tmpdir(), 'r07b-uploads-'));
  process.env.UPLOAD_DIR = uploadRoot;
  process.env.IMAGE_UPLOAD_MAX_BYTES = String(2 * 1024 * 1024);

  const storage = await import('../lib/local-image-storage');
  const { sniffImageFormat, saveLocalServiceImage, deleteLocalServiceImage, readLocalServiceImage } = storage;
  const uploadsRoute = await import('../app/uploads/[...path]/route');

  const png = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .withExif({ IFD0: { Copyright: 'SECRET-EXIF-MARKER' } }).jpeg().toBuffer();
  const webp = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 10, g: 20, b: 30 } } }).webp().toBuffer();
  const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(24)]);
  const html = Buffer.from('<!DOCTYPE html><script>alert(1)</script>'.padEnd(64, ' '));

  // ---- sniffImageFormat ----
  check('sniff PNG', sniffImageFormat(png) === 'png');
  check('sniff JPEG', sniffImageFormat(jpeg) === 'jpeg');
  check('sniff WebP', sniffImageFormat(webp) === 'webp');
  check('sniff GIF -> "gif"', sniffImageFormat(gif) === 'gif');
  check('sniff HTML -> null', sniffImageFormat(html) === null);
  check('sniff too-short -> null', sniffImageFormat(Buffer.from([0xff, 0xd8])) === null);
  check('sniff PNG signature with broken tail -> null',
    sniffImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])) === null);

  // ---- saveLocalServiceImage: happy path re-encodes and strips metadata ----
  let savedRel = '';
  {
    const out = await saveLocalServiceImage('welding', fakeFile(jpeg, 'image/jpeg', 'photo.jpg'));
    check('save JPEG -> url under /uploads/services/welding/', out.url.startsWith('/uploads/services/welding/') && out.url.endsWith('.jpg'));
    savedRel = out.url.replace('/uploads/', '');
    const onDisk = join(uploadRoot, savedRel);
    check('file written to disk', existsSync(onDisk));
    const bytes = readFileSync(onDisk);
    check('stored file is a JPEG', sniffImageFormat(bytes) === 'jpeg');
    check('stored file dropped the EXIF marker', !bytes.includes(Buffer.from('SECRET-EXIF-MARKER')));
    check('stored file carries no EXIF at all', !(await sharp(bytes).metadata()).exif);
  }

  // ---- format enforced by bytes, not by Content-Type ----
  {
    let msg = '';
    try { await saveLocalServiceImage('welding', fakeFile(html, 'image/png', 'evil.png')); }
    catch (e) { msg = (e as Error).message; }
    check('HTML disguised as image/png -> rejected', /JPEG, PNG or WebP/i.test(msg), msg);
  }

  // ---- GIF rejected outright ----
  {
    let msg = '';
    try { await saveLocalServiceImage('welding', fakeFile(gif, 'image/gif', 'anim.gif')); }
    catch (e) { msg = (e as Error).message; }
    check('GIF -> rejected with a GIF-specific message', /GIF/i.test(msg), msg);
  }

  // ---- size checked before the buffer is processed ----
  {
    let msg = '';
    try { await saveLocalServiceImage('welding', fakeFile(png, 'image/png', 'big.png', 9_000_000)); }
    catch (e) { msg = (e as Error).message; }
    check('declared size over the cap -> rejected before processing', /too large/i.test(msg), msg);
  }

  // ---- empty file ----
  {
    let msg = '';
    try { await saveLocalServiceImage('welding', fakeFile(Buffer.alloc(0), 'image/png', 'empty.png')); }
    catch (e) { msg = (e as Error).message; }
    check('empty file -> rejected', /empty/i.test(msg), msg);
  }

  // ---- corrupt image with a valid signature ----
  {
    const brokenPng = Buffer.concat([png.subarray(0, 8), Buffer.from('garbage after signature only')]);
    let msg = '';
    try { await saveLocalServiceImage('welding', fakeFile(brokenPng, 'image/png', 'broken.png')); }
    catch (e) { msg = (e as Error).message; }
    check('corrupt image -> rejected, not written', /could not be processed|Unsupported/i.test(msg), msg);
  }

  // ---- path traversal is contained ----
  check('readLocalServiceImage rejects ".." segments', (await readLocalServiceImage(['..', '..', 'etc', 'passwd'])) === null);
  check('readLocalServiceImage rejects an embedded traversal segment',
    (await readLocalServiceImage(['services', 'welding', '../../../../etc/passwd'])) === null);
  check('readLocalServiceImage rejects a non-services root', (await readLocalServiceImage(['uploads', 'welding', 'x.png'])) === null);
  await deleteLocalServiceImage('local:../../etc/passwd'); // must be a no-op, must not throw
  check('deleteLocalServiceImage ignores a traversal publicId', true);

  // ---- serving route: nosniff + inline Content-Disposition, 404 on traversal ----
  {
    const parts = savedRel.split('/');
    const res = await uploadsRoute.GET(new Request('http://localhost/uploads/' + savedRel), { params: Promise.resolve({ path: parts }) });
    check('serve stored image -> 200', res.status === 200);
    check('serve -> X-Content-Type-Options: nosniff', res.headers.get('x-content-type-options') === 'nosniff');
    check('serve -> Content-Disposition inline', /^inline; filename=/.test(res.headers.get('content-disposition') || ''));
    check('serve -> Content-Type image/jpeg', res.headers.get('content-type') === 'image/jpeg');
    const trav = await uploadsRoute.GET(new Request('http://localhost/uploads/x'), { params: Promise.resolve({ path: ['..', '..', 'etc', 'passwd'] }) });
    check('serve traversal path -> 404', trav.status === 404);
  }

  console.log(`\nPASS: ${pass}/${pass + fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
