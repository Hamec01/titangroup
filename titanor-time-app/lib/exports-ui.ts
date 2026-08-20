// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4C" — small presentation-only helpers shared
// by the export history/detail views. Never recomputes anything the backend already produced
// (lib/csv-export.ts) — purely string formatting.

export function exportKindLabel(kind: 'FULL' | 'CORRECTION'): string {
  return kind === 'FULL' ? 'Full export' : 'Correction export';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(kb < 10 ? 2 : 1)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
}

/** First 8 + last 4 hex chars of a SHA-256 digest, for compact display — the full hash is always
 * still available as the title attribute / in the detail page, never fully hidden. */
export function shortenHash(hash: string): string {
  if (hash.length <= 16) {
    return hash;
  }
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}
