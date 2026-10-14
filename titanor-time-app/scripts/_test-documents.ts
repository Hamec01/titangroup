export {};

let passed = 0;

function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
  passed += 1;
}

async function main() {
  const { classifyDocument, normalizeDocumentName, splitFileName } = await import('../lib/documents');
  const { resolveDocumentPreview } = await import('../lib/document-preview');

  const normalized = normalizeDocumentName('  Quarterly Report  ');
  check(normalized.name === 'Quarterly Report', 'trims display name');
  check(normalized.normalizedName === 'quarterly report', 'normalizes name for uniqueness');

  for (const bad of ['', '   ', '.', '..', '../secret', 'a/b', 'a\\b', `a${String.fromCharCode(0)}b`]) {
    let rejected = false;
    try { normalizeDocumentName(bad); } catch { rejected = true; }
    check(rejected, `rejects unsafe name ${JSON.stringify(bad)}`);
  }

  check(splitFileName('archive.TAR.GZ').extension === 'gz', 'uses final extension');
  check(splitFileName('.env').extension === null, 'dotfile has no extension');
  check(splitFileName('README').extension === null, 'extensionless name');
  check(classifyDocument('image/png', 'png') === 'IMAGE', 'image category');
  check(classifyDocument('video/mp4', 'mp4') === 'VIDEO', 'video category');
  check(classifyDocument('application/pdf', 'pdf') === 'PDF', 'pdf category');
  check(classifyDocument('application/octet-stream', 'zip') === 'ARCHIVE', 'archive by extension');
  check(classifyDocument('text/plain', 'txt') === 'DOCUMENT', 'text document category');
  check(classifyDocument('application/octet-stream', 'bin') === 'OTHER', 'fallback category');
  check(resolveDocumentPreview('application/pdf', 'report.pdf')?.kind === 'pdf', 'pdf preview');
  check(resolveDocumentPreview('application/octet-stream', 'photo.PNG')?.contentType === 'image/png', 'safe extension fallback');
  check(resolveDocumentPreview('text/html', 'page.html')?.contentType === 'text/plain; charset=utf-8', 'html is rendered as inert text');
  check(resolveDocumentPreview('image/svg+xml', 'drawing.svg') === null, 'active SVG is not previewed');
  check(resolveDocumentPreview('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx') === null, 'office file stays download-only');

  console.log(`documents unit: ${passed}/${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
