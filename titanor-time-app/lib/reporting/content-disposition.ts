// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §7 — safe Content-Disposition for
// the report-file download route. The stored fileName is already constrained by CK-58
// (`^[A-Za-z0-9._ -]{1,255}$` — no CR/LF/quote/path separator), so header injection is not
// reachable; this helper is the second, transport-level guarantee and also emits a correct
// RFC 6266 `filename*` alongside the ASCII `filename` fallback.

/** Strips anything outside a conservative filename allow-list and caps the length. Never returns
 * an empty string (falls back to `download`). */
export function sanitizeDownloadFileName(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);
  return cleaned.length > 0 ? cleaned : 'download';
}

/** `attachment; filename="<ascii>"; filename*=UTF-8''<pct-encoded>` — RFC 6266 §4.1 / RFC 5987. */
export function attachmentContentDisposition(rawFileName: string): string {
  const safe = sanitizeDownloadFileName(rawFileName);
  const asciiFallback = safe.replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
