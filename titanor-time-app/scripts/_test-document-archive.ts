export {};

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let passed = 0;

function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
  passed += 1;
}

function has7z(): boolean {
  try { execFileSync(process.env.DOCUMENT_ARCHIVE_7Z_BIN || '7z', ['i'], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function main() {
  const { archiveBaseName, archiveFormat, isJunkEntryName } = await import('../lib/document-archive-format');
  const { parseSevenZipListing, planExtraction, sanitizeEntryName, uniqueName, withCopySuffix, mimeTypeForName } = await import('../lib/document-archive');

  check(archiveFormat('Docs.ZIP') === 'zip', 'zip format');
  check(archiveFormat('photos.rar') === 'rar', 'rar format');
  check(archiveFormat('a.7z') === '7z', '7z format');
  check(archiveFormat('backup.tar.gz') === 'tar.gz' && archiveFormat('b.tgz') === 'tar.gz', 'compressed tar format');
  check(archiveFormat('report.pdf') === null, 'non-archive is not extractable');
  check(archiveBaseName('Objekti 12.tar.gz') === 'Objekti 12' && archiveBaseName('Docs.zip') === 'Docs', 'archive base name');
  check(isJunkEntryName('Thumbs.db') && isJunkEntryName('.DS_Store') && isJunkEntryName('._photo.jpg') && !isJunkEntryName('photo.jpg'), 'junk names');
  check(sanitizeEntryName('a\u0001b') === 'a_b' && sanitizeEntryName('..') === '_' && sanitizeEntryName('  ') === '_', 'sanitizes unsafe names');
  check(sanitizeEntryName(`${'x'.repeat(300)}.pdf`).length === 255 && sanitizeEntryName(`${'x'.repeat(300)}.pdf`).endsWith('.pdf'), 'truncates long names keeping extension');
  check(withCopySuffix('Report.pdf', 2, true) === 'Report (2).pdf' && withCopySuffix('Folder.v1', 3, false) === 'Folder.v1 (3)', 'copy suffix');
  const taken = new Set<string>();
  check(uniqueName('A.txt', taken, true) === 'A.txt' && uniqueName('a.TXT', taken, true) === 'a (2).TXT', 'case-insensitive unique names');
  check(mimeTypeForName('x.DOCX').includes('wordprocessingml') && mimeTypeForName('noext') === 'application/octet-stream', 'mime by extension');

  const listing = parseSevenZipListing(['Path = dir', 'Folder = +', 'Size = 0', '', 'Path = dir/a = b.txt', 'Folder = -', 'Size = 12', 'Encrypted = -', '', 'Path = dir/secret.pdf', 'Size = 5', 'Encrypted = +', 'Attributes = A'].join('\n'));
  check(listing.length === 3 && listing[0].isDir && listing[1].path === 'dir/a = b.txt' && listing[1].sizeBytes === BigInt(12) && listing[2].encrypted, 'parses 7z -slt listing');

  if (!has7z()) {
    console.log(`document archive unit: ${passed}/${passed} passed (7z not installed — extraction checks skipped)`);
    return;
  }

  // Real extraction through the same 7z invocation the server uses, without DB or S3.
  const work = mkdtempSync(path.join(tmpdir(), 'titanor-archive-test-'));
  try {
    const src = path.join(work, 'src');
    mkdirSync(path.join(src, 'Project', 'Kuvat', 'Syvä'), { recursive: true });
    mkdirSync(path.join(src, 'Project', 'Tyhjä kansio'), { recursive: true });
    writeFileSync(path.join(src, 'Project', 'Sopimus.pdf'), 'pdf');
    writeFileSync(path.join(src, 'Project', 'Kuvat', 'työmaa.jpg'), 'jpg');
    writeFileSync(path.join(src, 'Project', 'Kuvat', 'Syvä', 'empty.txt'), '');
    writeFileSync(path.join(src, 'Project', 'Thumbs.db'), 'junk');
    symlinkSync('/etc/passwd', path.join(src, 'Project', 'link'));
    const bin = process.env.DOCUMENT_ARCHIVE_7Z_BIN || '7z';
    for (const format of ['zip', '7z', 'tar']) {
      const archive = path.join(work, `Project.${format}`);
      execFileSync(bin, ['a', '-snl', archive, 'Project'], { cwd: src, stdio: 'ignore' });
      const out = path.join(work, `out-${format}`);
      execFileSync(bin, ['x', '-y', '-bd', '-ptitanor-no-password', `-o${out}`, '--', archive], { stdio: 'ignore' });
      const plan = await planExtraction(out, `Project.${format}`, 5000);
      check(plan.rootName === 'Project', `${format}: single top-level folder becomes the target`);
      check(plan.files.map((f) => f.name).sort().join('|') === 'Sopimus.pdf|empty.txt|työmaa.jpg', `${format}: files kept, junk and symlink dropped`);
      check(plan.folders.map((f) => f.name).sort().join('|') === 'Kuvat|Syvä|Tyhjä kansio', `${format}: nested and empty folders kept`);
      check(plan.depth === 3 && plan.skipped >= 1, `${format}: depth and skipped count`);
      const listed = parseSevenZipListing(execFileSync(bin, ['l', '-slt', '-ba', '-ptitanor-no-password', '--', archive]).toString('utf8'));
      check(listed.some((e) => e.path.endsWith('työmaa.jpg') && e.sizeBytes === BigInt(3)), `${format}: listing sizes and UTF-8 names`);
    }

    // Loose files at the archive root land in a folder named after the archive; duplicates are renamed.
    const flat = path.join(work, 'flat');
    mkdirSync(flat);
    writeFileSync(path.join(flat, 'a.txt'), '1');
    writeFileSync(path.join(flat, 'b.txt'), '2');
    const flatPlan = await planExtraction(flat, 'Laskut 2026.zip', 5000);
    check(flatPlan.rootName === 'Laskut 2026' && flatPlan.files.length === 2 && flatPlan.folders.length === 0, 'flat archive uses archive name');
    let tooMany = false;
    try { await planExtraction(flat, 'x.zip', 1); } catch (error) { tooMany = (error as { code?: string }).code === 'ARCHIVE_TOO_MANY_ENTRIES'; }
    check(tooMany, 'entry limit enforced while scanning');

    // Encrypted archives fail fast instead of prompting for a password.
    const secret = path.join(work, 'secret.7z');
    execFileSync(bin, ['a', '-pparool', '-mhe=on', secret, 'Project'], { cwd: src, stdio: 'ignore' });
    let encryptedFailed = false;
    try { execFileSync(bin, ['l', '-slt', '-ba', '-ptitanor-no-password', '--', secret], { stdio: 'pipe', timeout: 20_000 }); } catch (error) { encryptedFailed = /wrong password|encrypted/i.test(String((error as { stdout?: Buffer }).stdout) + String((error as { stderr?: Buffer }).stderr)); }
    check(encryptedFailed, 'header-encrypted archive is reported as encrypted');

    // Zip-slip: an entry named ../evil.txt must stay inside the output directory.
    const slipSrc = path.join(work, 'slip');
    mkdirSync(path.join(slipSrc, 'inner'), { recursive: true });
    writeFileSync(path.join(slipSrc, 'evil.txt'), 'x');
    const slip = path.join(work, 'slip.tar');
    execFileSync('tar', ['-P', '-cf', slip, '-C', path.join(slipSrc, 'inner'), '../evil.txt'], { stdio: 'ignore' });
    check(execFileSync('tar', ['-tf', slip]).toString().includes('../evil.txt'), 'test archive really contains a ../ entry');
    const slipOut = path.join(work, 'slip-out');
    try { execFileSync(bin, ['x', '-y', '-bd', '-ptitanor-no-password', `-o${slipOut}`, '--', slip], { stdio: 'ignore' }); } catch { /* 7z may refuse the entry */ }
    check(!existsSync(path.join(work, 'evil.txt')), 'zip-slip entry does not escape the output dir');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`document archive unit: ${passed}/${passed} passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
