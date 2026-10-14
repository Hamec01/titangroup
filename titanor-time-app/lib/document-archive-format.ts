/** Archive formats the document storage can extract. Client-safe: no Node imports. */
export type ArchiveFormat = 'zip' | 'rar' | '7z' | 'tar' | 'tar.gz' | 'gz';

export function archiveFormat(fileName: string): ArchiveFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.gz')) return 'gz';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.rar')) return 'rar';
  if (lower.endsWith('.7z')) return '7z';
  if (lower.endsWith('.tar')) return 'tar';
  return null;
}

export function archiveBaseName(fileName: string): string {
  const base = fileName.replace(/\.(tar\.gz|tgz|zip|rar|7z|tar|gz)$/i, '').trim();
  return base || fileName;
}

/** OS metadata files that are never worth storing (Windows thumbnails, macOS Finder/AppleDouble). */
export function isJunkEntryName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === '.ds_store' || lower === 'thumbs.db' || lower === 'desktop.ini' || lower === '__macosx' || lower.startsWith('._');
}
