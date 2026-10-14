export type DocumentPreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'text';

export interface DocumentPreviewDescriptor {
  kind: DocumentPreviewKind;
  contentType: string;
}

const MIME_PREVIEWS: Readonly<Record<string, DocumentPreviewDescriptor>> = {
  'application/pdf': { kind: 'pdf', contentType: 'application/pdf' },
  'image/jpeg': { kind: 'image', contentType: 'image/jpeg' },
  'image/png': { kind: 'image', contentType: 'image/png' },
  'image/gif': { kind: 'image', contentType: 'image/gif' },
  'image/webp': { kind: 'image', contentType: 'image/webp' },
  'image/avif': { kind: 'image', contentType: 'image/avif' },
  'image/bmp': { kind: 'image', contentType: 'image/bmp' },
  'video/mp4': { kind: 'video', contentType: 'video/mp4' },
  'video/webm': { kind: 'video', contentType: 'video/webm' },
  'video/ogg': { kind: 'video', contentType: 'video/ogg' },
  'audio/mpeg': { kind: 'audio', contentType: 'audio/mpeg' },
  'audio/mp4': { kind: 'audio', contentType: 'audio/mp4' },
  'audio/ogg': { kind: 'audio', contentType: 'audio/ogg' },
  'audio/wav': { kind: 'audio', contentType: 'audio/wav' },
  'audio/webm': { kind: 'audio', contentType: 'audio/webm' },
  'application/json': { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  'application/xml': { kind: 'text', contentType: 'text/plain; charset=utf-8' }
};

const EXTENSION_PREVIEWS: Readonly<Record<string, DocumentPreviewDescriptor>> = {
  pdf: MIME_PREVIEWS['application/pdf'],
  jpg: MIME_PREVIEWS['image/jpeg'],
  jpeg: MIME_PREVIEWS['image/jpeg'],
  png: MIME_PREVIEWS['image/png'],
  gif: MIME_PREVIEWS['image/gif'],
  webp: MIME_PREVIEWS['image/webp'],
  avif: MIME_PREVIEWS['image/avif'],
  bmp: MIME_PREVIEWS['image/bmp'],
  mp4: MIME_PREVIEWS['video/mp4'],
  m4v: MIME_PREVIEWS['video/mp4'],
  webm: MIME_PREVIEWS['video/webm'],
  ogv: MIME_PREVIEWS['video/ogg'],
  mp3: MIME_PREVIEWS['audio/mpeg'],
  m4a: MIME_PREVIEWS['audio/mp4'],
  oga: MIME_PREVIEWS['audio/ogg'],
  ogg: MIME_PREVIEWS['audio/ogg'],
  wav: MIME_PREVIEWS['audio/wav'],
  txt: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  md: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  csv: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  log: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  json: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  xml: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  yaml: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  yml: { kind: 'text', contentType: 'text/plain; charset=utf-8' }
};

function normalizedExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > -1 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toLowerCase() : '';
}

/**
 * Resolves only formats browsers can render safely without sending internal files to a third-party
 * document viewer. SVG and HTML deliberately become plain text (or unsupported) rather than an
 * active same-origin document.
 */
export function resolveDocumentPreview(mimeType: string, fileName: string): DocumentPreviewDescriptor | null {
  const mime = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (mime.startsWith('text/')) return { kind: 'text', contentType: 'text/plain; charset=utf-8' };
  return MIME_PREVIEWS[mime] ?? EXTENSION_PREVIEWS[normalizedExtension(fileName)] ?? null;
}
