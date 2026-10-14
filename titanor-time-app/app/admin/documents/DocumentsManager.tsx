'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { AppLocale } from '@/lib/i18n/locale';
import { resolveDocumentPreview } from '@/lib/document-preview';
import { archiveFormat, isJunkEntryName } from '@/lib/document-archive-format';

type Folder = { id: string; name: string; parentId: string | null; itemCount: number; updatedAt: string };
type FileItem = { id: string; displayName: string; mimeType: string; category: string; sizeBytes: string; updatedAt: string };
type Listing = { folder: { id: string; name: string } | null; breadcrumbs: Array<{ id: string; name: string }>; folders: Folder[]; files: FileItem[]; storage: StorageInfo };
type StorageInfo = { quotaBytes: string; usedBytes: string; reservedBytes: string; freeBytes: string };
type UploadState = { name: string; progress: number; status: 'queued' | 'uploading' | 'done' | 'error'; error?: string; fileId?: string };
type UploadEntry = { file: File; dirs: string[] };
type ExtractResult = { folder: { id: string; name: string }; fileCount: number; folderCount: number; skipped: number };
type SearchResult = { kind: 'folder' | 'file'; id: string; name: string; folderId: string | null; category: string; mimeType: string; sizeBytes: string };
type FolderOption = { id: string; parentId: string | null; name: string; path: string; depth: number };

const CSRF_HEADERS = { 'X-Requested-With': 'titanor-time' };
const CATEGORIES = ['ALL', 'FOLDER', 'DOCUMENT', 'IMAGE', 'VIDEO', 'ARCHIVE', 'OTHER'] as const;
const UPLOAD_CONCURRENCY = 3;

function readDirectory(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // readEntries returns at most ~100 entries per call; keep reading until it returns none.
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () => reader.readEntries((batch) => { if (!batch.length) resolve(all); else { all.push(...batch); next(); } }, reject);
    next();
  });
}

/** Walks dropped files and folders, keeping each file's folder path relative to the drop. */
async function collectEntries(roots: FileSystemEntry[]): Promise<{ entries: UploadEntry[]; folders: string[][] }> {
  const entries: UploadEntry[] = [];
  const folders: string[][] = [];
  const walk = async (entry: FileSystemEntry, dirs: string[]): Promise<void> => {
    if (isJunkEntryName(entry.name)) return;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      entries.push({ file, dirs });
    } else if (entry.isDirectory) {
      const path = [...dirs, entry.name];
      folders.push(path);
      for (const child of await readDirectory((entry as FileSystemDirectoryEntry).createReader())) await walk(child, path);
    }
  };
  for (const root of roots) await walk(root, []);
  return { entries, folders };
}

function formatBytes(raw: string | bigint): string {
  const bytes = Number(BigInt(raw));
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) { value /= 1024; unit = units[i]; }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function icon(category: string, folder = false) {
  if (folder) return '📁';
  if (category === 'IMAGE') return '🖼️';
  if (category === 'VIDEO') return '🎬';
  if (category === 'ARCHIVE') return '🗜️';
  if (category === 'PDF') return '📕';
  if (category === 'DOCUMENT') return '📄';
  return '📎';
}

export function DocumentsManager({ locale }: { locale: AppLocale }) {
  const ru = locale === 'RU';
  const [folderId, setFolderId] = useState<string | null>(null);
  const [data, setData] = useState<Listing | null>(null);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'grid' | 'list'>(() => typeof window === 'undefined' ? 'grid' : (localStorage.getItem('titanor-documents-view') === 'list' ? 'list' : 'grid'));
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('ALL');
  const [sort, setSort] = useState('name-asc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string>('');
  const [folderOptions, setFolderOptions] = useState<FolderOption[]>([]);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [extracting, setExtracting] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; folderId?: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const qs = folderId ? `?folderId=${encodeURIComponent(folderId)}` : '';
      const [itemsRes, storageRes] = await Promise.all([fetch(`/api/admin/documents/items${qs}`, { cache: 'no-store' }), fetch('/api/admin/documents/storage', { cache: 'no-store' })]);
      if (!itemsRes.ok) throw new Error('LOAD_FAILED');
      const listing = await itemsRes.json() as Listing;
      setData(listing);
      if (storageRes.ok) { const status = await storageRes.json(); setStorageAvailable(Boolean(status.available)); setCategories(status.categories ?? {}); }
      setSelected(new Set());
    } catch { setError(ru ? 'Не удалось загрузить документы.' : 'Could not load documents.'); }
    finally { setLoading(false); }
  }, [folderId, ru]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const clean = query.trim();
    if (clean.length < 2) { setSearchResults([]); setSearching(false); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/admin/documents/search?q=${encodeURIComponent(clean)}`, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) throw new Error('SEARCH_FAILED');
        const payload = await res.json();
        setSearchResults([
          ...payload.folders.map((f: { id: string; name: string; parentId: string | null }) => ({ kind: 'folder' as const, id: f.id, name: f.name, folderId: f.parentId, category: 'FOLDER', mimeType: '', sizeBytes: '0' })),
          ...payload.files.map((f: { id: string; displayName: string; folderId: string | null; category: string; mimeType: string; sizeBytes: string }) => ({ kind: 'file' as const, id: f.id, name: f.displayName, folderId: f.folderId, category: f.category, mimeType: f.mimeType, sizeBytes: f.sizeBytes }))
        ]);
      } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setError(ru ? 'Поиск не выполнен.' : 'Search failed.'); }
      finally { if (!controller.signal.aborted) setSearching(false); }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, ru]);

  useEffect(() => {
    if (!previewFile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewFile(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [previewFile]);

  const visible = useMemo(() => {
    if (!data) return [];
    const rows = [
      ...data.folders.map((f) => ({ kind: 'folder' as const, id: f.id, name: f.name, category: 'FOLDER', size: BigInt(0), updatedAt: f.updatedAt, folder: f })),
      ...data.files.map((f) => ({ kind: 'file' as const, id: f.id, name: f.displayName, category: f.category, size: BigInt(f.sizeBytes), updatedAt: f.updatedAt, file: f }))
    ].filter((x) => category === 'ALL' || x.category === category || (category === 'DOCUMENT' && x.category === 'PDF'));
    return rows.sort((a, b) => {
      if (sort === 'name-desc') return b.name.localeCompare(a.name);
      if (sort === 'date-desc') return +new Date(b.updatedAt) - +new Date(a.updatedAt);
      if (sort === 'date-asc') return +new Date(a.updatedAt) - +new Date(b.updatedAt);
      if (sort === 'size-desc') return Number(b.size - a.size);
      if (sort === 'size-asc') return Number(a.size - b.size);
      return a.name.localeCompare(b.name);
    });
  }, [data, category, sort]);

  async function mutate(url: string, method: string, body?: unknown) {
    const res = await fetch(url, { method, headers: { ...CSRF_HEADERS, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) { const payload = await res.json().catch(() => null); throw new Error(payload?.error?.code || 'REQUEST_FAILED'); }
    return res.status === 204 ? null : res.json();
  }

  async function createFolder() {
    try { await mutate('/api/admin/documents/folders', 'POST', { name: folderName, parentId: folderId }); setCreateOpen(false); setFolderName(''); await load(); }
    catch (e) { setError(messageFor(e)); }
  }

  async function rename(kind: 'folder' | 'file', id: string, oldName: string) {
    const name = window.prompt(ru ? 'Новое название' : 'New name', oldName);
    if (!name || name === oldName) return;
    try { await mutate(`/api/admin/documents/${kind === 'folder' ? 'folders' : 'files'}/${id}`, 'PATCH', { name }); await load(); }
    catch (e) { setError(messageFor(e)); }
  }

  async function remove(kind: 'folder' | 'file', id: string, name: string) {
    if (!window.confirm(ru ? `Удалить «${name}»? Это действие нельзя отменить.` : `Delete “${name}”? This cannot be undone.`)) return;
    try { await mutate(`/api/admin/documents/${kind === 'folder' ? 'folders' : 'files'}/${id}`, 'DELETE'); await load(); }
    catch (e) { setError(messageFor(e)); }
  }

  function uploadOne(entry: UploadEntry, targetFolderId: string | null, index: number): Promise<void> {
    return new Promise((resolve) => {
      const { file } = entry;
      const update = (patch: Partial<UploadState>) => setUploads((current) => current.map((u, i) => i === index ? { ...u, ...patch } : u));
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/admin/documents/files/upload');
      xhr.setRequestHeader('X-Requested-With', 'titanor-time');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.setRequestHeader('X-File-Size', String(file.size));
      if (targetFolderId) xhr.setRequestHeader('X-Folder-Id', targetFolderId);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) update({ progress: Math.round(event.loaded / event.total * 100) }); };
      xhr.onload = () => {
        const ok = xhr.status >= 200 && xhr.status < 300;
        let payload: { file?: { id: string }; error?: { code?: string } } | null = null;
        try { payload = JSON.parse(xhr.responseText); } catch { payload = null; }
        update(ok ? { progress: 100, status: 'done', fileId: payload?.file?.id } : { status: 'error', error: messageFor(new Error(payload?.error?.code || 'REQUEST_FAILED')) });
        resolve();
      };
      xhr.onerror = () => { update({ status: 'error', error: ru ? 'Нет связи с сервером или файл недоступен для чтения.' : 'Network error or the file could not be read.' }); resolve(); };
      update({ status: 'uploading' });
      xhr.send(file);
    });
  }

  /** Uploads files; `dirs` recreates the dropped/selected folder tree under the current folder. */
  async function uploadEntries(rawEntries: UploadEntry[], emptyFolders: string[][] = []) {
    const entries = rawEntries.filter((entry) => !isJunkEntryName(entry.file.name));
    if (!entries.length && !emptyFolders.length) return;
    const targetFolderId = folderId;
    setNotice(null);
    setUploads(entries.map((entry) => ({ name: [...entry.dirs, entry.file.name].join(' / '), progress: 0, status: 'queued' })));
    const folderIds = new Map<string, string | null>([['', targetFolderId]]);
    const failedFolders = new Map<string, string>();
    const paths = new Map<string, string[]>();
    for (const dirs of [...emptyFolders, ...entries.map((entry) => entry.dirs)]) if (dirs.length) paths.set(dirs.join('/'), dirs);
    for (const dirs of [...paths.values()].sort((a, b) => a.length - b.length)) {
      const key = dirs.join('/');
      let known = dirs.length - 1;
      while (known > 0 && !folderIds.has(dirs.slice(0, known).join('/'))) known -= 1;
      const prefix = dirs.slice(0, known).join('/');
      if (failedFolders.has(prefix)) { failedFolders.set(key, failedFolders.get(prefix)!); continue; }
      try {
        const result = await mutate('/api/admin/documents/folders/path', 'POST', { parentId: folderIds.get(prefix) ?? null, segments: dirs.slice(known) }) as { folderIds: string[] };
        result.folderIds.forEach((id, i) => folderIds.set(dirs.slice(0, known + i + 1).join('/'), id));
      } catch (e) { failedFolders.set(key, messageFor(e)); }
    }
    let next = 0;
    const lanes = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, entries.length) }, async () => {
      while (next < entries.length) {
        const index = next;
        next += 1;
        const key = entries[index].dirs.join('/');
        const folderError = failedFolders.get(key);
        if (folderError) { setUploads((current) => current.map((u, i) => i === index ? { ...u, status: 'error', error: folderError } : u)); continue; }
        await uploadOne(entries[index], folderIds.get(key) ?? null, index);
      }
    });
    await Promise.all(lanes);
    await load();
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    // Entries must be taken synchronously: the DataTransfer is emptied once this handler returns.
    const roots = Array.from(event.dataTransfer.items ?? []).filter((item) => item.kind === 'file').map((item) => item.webkitGetAsEntry?.() ?? null);
    if (roots.length && roots.every((entry): entry is FileSystemEntry => entry !== null)) {
      void collectEntries(roots).then(({ entries, folders }) => uploadEntries(entries, folders)).catch(() => setError(ru ? 'Не удалось прочитать перетащенную папку.' : 'Could not read the dropped folder.'));
    } else if (event.dataTransfer.files.length) {
      void uploadEntries(Array.from(event.dataTransfer.files).map((file) => ({ file, dirs: [] })));
    }
  }

  async function extractArchive(fileId: string, name: string) {
    if (extracting) return;
    if (!window.confirm(ru ? `Распаковать «${name}» в новую папку рядом с архивом? Сам архив останется.` : `Extract “${name}” into a new folder next to it? The archive itself is kept.`)) return;
    setExtracting(name); setError(null); setNotice(null); setPreviewFile(null);
    try {
      const result = await mutate(`/api/admin/documents/files/${fileId}/extract`, 'POST') as ExtractResult;
      setNotice({ text: ru ? `Архив распакован в папку «${result.folder.name}»: файлов ${result.fileCount}, папок ${result.folderCount}${result.skipped ? `, пропущено служебных/ссылок ${result.skipped}` : ''}.` : `Extracted into “${result.folder.name}”: ${result.fileCount} files, ${result.folderCount} folders${result.skipped ? `, ${result.skipped} system entries/links skipped` : ''}.`, folderId: result.folder.id });
      await load();
    } catch (e) { setError(messageFor(e)); }
    finally { setExtracting(null); }
  }

  async function deleteSelected() {
    const rows = visible.filter((item) => selected.has(`${item.kind}:${item.id}`));
    if (!rows.length || !window.confirm(ru ? `Удалить выбранные элементы: ${rows.length}?` : `Delete ${rows.length} selected items?`)) return;
    for (const item of rows) {
      try { await mutate(`/api/admin/documents/${item.kind === 'folder' ? 'folders' : 'files'}/${item.id}`, 'DELETE'); }
      catch (e) { setError(messageFor(e)); break; }
    }
    await load();
  }

  async function openMove() {
    try {
      const res = await fetch('/api/admin/documents/folders/tree', { cache: 'no-store' });
      if (!res.ok) throw new Error('LOAD_FAILED');
      const payload = await res.json() as { folders: FolderOption[] };
      setFolderOptions(payload.folders); setMoveTarget(folderId ?? ''); setMoveOpen(true);
    } catch (e) { setError(messageFor(e)); }
  }

  async function moveSelected() {
    const rows = visible.filter((item) => selected.has(`${item.kind}:${item.id}`));
    const destination = moveTarget || null;
    try {
      for (const item of rows) {
        await mutate(`/api/admin/documents/${item.kind === 'folder' ? 'folders' : 'files'}/${item.id}`, 'PATCH', item.kind === 'folder' ? { parentId: destination } : { folderId: destination });
      }
      setMoveOpen(false); await load();
    } catch (e) { setError(messageFor(e)); }
  }

  function messageFor(error: unknown) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'DOCUMENT_NAME_CONFLICT') return ru ? 'Элемент с таким названием уже существует.' : 'An item with this name already exists.';
    if (code === 'STORAGE_QUOTA_EXCEEDED') return ru ? 'Недостаточно свободного места.' : 'Not enough free space.';
    if (code === 'DOCUMENT_STORAGE_UNAVAILABLE') return ru ? 'Хранилище временно недоступно.' : 'Storage is temporarily unavailable.';
    if (code === 'FILE_TOO_LARGE') return ru ? 'Файл слишком большой (максимум 2 ГБ).' : 'The file is too large (2 GB maximum).';
    if (code === 'INVALID_DOCUMENT_NAME') return ru ? 'Недопустимое название.' : 'Invalid name.';
    if (code === 'FOLDER_DEPTH_EXCEEDED') return ru ? 'Слишком глубокая вложенность папок.' : 'Folders are nested too deeply.';
    if (code === 'ARCHIVE_ENCRYPTED') return ru ? 'Архив защищён паролем. Распакуйте его на компьютере и загрузите папку целиком.' : 'The archive is password-protected. Extract it on your computer and upload the folder instead.';
    if (code === 'ARCHIVE_INVALID' || code === 'ARCHIVE_UNSUPPORTED') return ru ? 'Файл повреждён или это не поддерживаемый архив (zip, rar, 7z, tar, gz).' : 'The file is damaged or not a supported archive (zip, rar, 7z, tar, gz).';
    if (code === 'ARCHIVE_TOO_MANY_ENTRIES') return ru ? 'В архиве слишком много файлов (больше 5000).' : 'The archive contains too many files (over 5000).';
    if (code === 'ARCHIVE_TOO_LARGE') return ru ? 'Архив распаковывается в слишком большой объём.' : 'The archive expands to too much data.';
    if (code === 'ARCHIVE_DISK_FULL') return ru ? 'На сервере сейчас недостаточно места для распаковки.' : 'The server does not have enough temporary space to extract it.';
    if (code === 'ARCHIVE_EXTRACTION_BUSY') return ru ? 'Сейчас распаковывается другой архив. Попробуйте через минуту.' : 'Another archive is being extracted. Try again in a minute.';
    if (code === 'ARCHIVE_EXTRACTION_TIMEOUT') return ru ? 'Распаковка заняла слишком много времени и была остановлена.' : 'Extraction took too long and was stopped.';
    if (code === 'ARCHIVE_EXTRACTION_FAILED') return ru ? 'Не удалось распаковать архив.' : 'Could not extract the archive.';
    return ru ? 'Операция не выполнена.' : 'The operation failed.';
  }

  const used = data ? BigInt(data.storage.usedBytes) : BigInt(0);
  const quota = data ? BigInt(data.storage.quotaBytes) : BigInt('10737418240');
  const percent = quota ? Math.min(100, Number(used * BigInt(10000) / quota) / 100) : 0;
  const uploadsDone = uploads.filter((u) => u.status === 'done').length;
  const uploadsFailed = uploads.filter((u) => u.status === 'error').length;
  const uploadsFinished = uploadsDone + uploadsFailed === uploads.length;
  const previewDescriptor = previewFile ? resolveDocumentPreview(previewFile.mimeType, previewFile.displayName) : null;
  const previewUrl = previewFile ? `/api/admin/documents/files/${previewFile.id}/preview` : '';

  return (
    <main className="documents-page" onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) setDragging(true); }} onDragOver={(e) => e.preventDefault()} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={handleDrop}>
      <header className="documents-heading"><div><p className="documents-eyebrow">Titanor Time</p><h1>{ru ? 'Файлы и документы' : 'Files and documents'}</h1><p>{ru ? 'Хранение внутренних файлов Titanor Group' : 'Internal Titanor Group file storage'}</p></div></header>
      {data && <section className="documents-storage-card"><div className="documents-storage-title"><div><strong>{ru ? 'Хранилище' : 'Storage'}</strong><span>{formatBytes(used)} {ru ? 'из' : 'of'} {formatBytes(quota)}</span></div><b>{percent}%</b></div><div className="documents-storage-bar" aria-label={`${percent}%`}><span className="documents-storage-image" style={{ width: `${quota ? Number(BigInt(categories.IMAGE ?? '0') * BigInt(10000) / quota) / 100 : 0}%` }} /><span className="documents-storage-doc" style={{ width: `${quota ? Number((BigInt(categories.DOCUMENT ?? '0') + BigInt(categories.PDF ?? '0')) * BigInt(10000) / quota) / 100 : 0}%` }} /><span className="documents-storage-video" style={{ width: `${quota ? Number(BigInt(categories.VIDEO ?? '0') * BigInt(10000) / quota) / 100 : 0}%` }} /><span className="documents-storage-other" style={{ width: `${quota ? Number((BigInt(categories.ARCHIVE ?? '0') + BigInt(categories.OTHER ?? '0')) * BigInt(10000) / quota) / 100 : 0}%` }} /></div><div className="documents-storage-legend"><span>● {ru ? 'Изображения' : 'Images'} {formatBytes(categories.IMAGE ?? '0')}</span><span>● {ru ? 'Документы' : 'Documents'} {formatBytes(BigInt(categories.DOCUMENT ?? '0') + BigInt(categories.PDF ?? '0'))}</span><span>● {ru ? 'Видео' : 'Video'} {formatBytes(categories.VIDEO ?? '0')}</span><span>● {ru ? 'Другое' : 'Other'} {formatBytes(BigInt(categories.ARCHIVE ?? '0') + BigInt(categories.OTHER ?? '0'))}</span><span>{ru ? 'Свободно' : 'Free'} {formatBytes(data.storage.freeBytes)}</span></div></section>}
      {!storageAvailable && <div className="documents-warning" role="alert">{ru ? 'Хранилище временно недоступно. Файлы сейчас нельзя загрузить или скачать.' : 'Storage is temporarily unavailable. Files cannot currently be uploaded or downloaded.'}</div>}
      <div className="documents-toolbar"><button className="documents-primary" onClick={() => fileInput.current?.click()} disabled={!storageAvailable}>＋ {ru ? 'Загрузить файлы' : 'Upload files'}</button><input ref={fileInput} hidden type="file" multiple onChange={(e) => { if (e.target.files) void uploadEntries(Array.from(e.target.files).map((file) => ({ file, dirs: [] }))); e.target.value = ''; }} /><button onClick={() => folderInput.current?.click()} disabled={!storageAvailable}>＋ {ru ? 'Загрузить папку' : 'Upload folder'}</button><input ref={(el) => { folderInput.current = el; el?.setAttribute('webkitdirectory', ''); }} hidden type="file" multiple onChange={(e) => { if (e.target.files) void uploadEntries(Array.from(e.target.files).map((file) => ({ file, dirs: (file.webkitRelativePath || file.name).split('/').slice(0, -1) }))); e.target.value = ''; }} /><button onClick={() => setCreateOpen(true)}>＋ {ru ? 'Создать папку' : 'Create folder'}</button><label className="documents-search"><span className="sr-only">{ru ? 'Поиск по всему хранилищу' : 'Search all storage'}</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={ru ? 'Поиск файлов и папок…' : 'Search files and folders…'} /></label><div className="documents-toolbar-spacer" /><button aria-pressed={view === 'grid'} onClick={() => { setView('grid'); localStorage.setItem('titanor-documents-view', 'grid'); }}>▦</button><button aria-pressed={view === 'list'} onClick={() => { setView('list'); localStorage.setItem('titanor-documents-view', 'list'); }}>☷</button></div>
      {query.trim().length >= 2 && <section className="documents-search-results"><strong>{searching ? (ru ? 'Поиск…' : 'Searching…') : `${ru ? 'Результаты' : 'Results'}: ${searchResults.length}`}</strong>{!searching && searchResults.map((result) => <button key={`${result.kind}:${result.id}`} onClick={() => { if (result.kind === 'folder') setFolderId(result.id); else setPreviewFile({ id: result.id, displayName: result.name, mimeType: result.mimeType, category: result.category, sizeBytes: result.sizeBytes, updatedAt: '' }); setQuery(''); }}><span>{icon(result.category, result.kind === 'folder')}</span><span>{result.name}<small>{result.kind === 'folder' ? (ru ? 'Папка' : 'Folder') : result.category}</small></span></button>)}</section>}
      <nav className="documents-breadcrumbs" aria-label={ru ? 'Путь к папке' : 'Folder path'}><button onClick={() => setFolderId(null)}>{ru ? 'Документы' : 'Documents'}</button>{data?.breadcrumbs.map((b) => <span key={b.id}>› <button onClick={() => setFolderId(b.id)}>{b.name}</button></span>)}</nav>
      <div className="documents-controls"><div className="documents-filters">{CATEGORIES.map((c) => <button key={c} className={category === c ? 'is-active' : ''} onClick={() => setCategory(c)}>{({ ALL: ru ? 'Все' : 'All', FOLDER: ru ? 'Папки' : 'Folders', DOCUMENT: ru ? 'Документы' : 'Documents', IMAGE: ru ? 'Фото' : 'Images', VIDEO: ru ? 'Видео' : 'Video', ARCHIVE: ru ? 'Архивы' : 'Archives', OTHER: ru ? 'Другое' : 'Other' })[c]}</button>)}</div><select value={sort} onChange={(e) => setSort(e.target.value)}><option value="name-asc">{ru ? 'Имя А–Я' : 'Name A–Z'}</option><option value="name-desc">{ru ? 'Имя Я–А' : 'Name Z–A'}</option><option value="date-desc">{ru ? 'Сначала новые' : 'Newest first'}</option><option value="date-asc">{ru ? 'Сначала старые' : 'Oldest first'}</option><option value="size-desc">{ru ? 'Сначала большие' : 'Largest first'}</option><option value="size-asc">{ru ? 'Сначала маленькие' : 'Smallest first'}</option></select></div>
      {selected.size > 0 && <div className="documents-selection"><strong>{ru ? 'Выбрано' : 'Selected'}: {selected.size}</strong><button onClick={() => void openMove()}>{ru ? 'Переместить' : 'Move'}</button><button onClick={() => void deleteSelected()}>{ru ? 'Удалить' : 'Delete'}</button><button onClick={() => setSelected(new Set())}>{ru ? 'Снять выбор' : 'Clear selection'}</button></div>}
      {error && <div className="documents-warning" role="alert">{error} <button onClick={() => setError(null)}>×</button></div>}
      {extracting && <div className="documents-notice" role="status">{ru ? `Распаковка «${extracting}»… Для больших архивов это может занять несколько минут — не закрывайте страницу.` : `Extracting “${extracting}”… Large archives can take a few minutes — keep this page open.`}</div>}
      {notice && <div className="documents-notice" role="status"><span>{notice.text}</span><span>{notice.folderId && <button onClick={() => { setFolderId(notice.folderId!); setNotice(null); }}>{ru ? 'Открыть папку' : 'Open folder'}</button>}<button onClick={() => setNotice(null)} aria-label={ru ? 'Закрыть' : 'Close'}>×</button></span></div>}
      {uploads.length > 0 && <section className="documents-upload-panel"><header><strong>{uploadsFinished ? (ru ? 'Загрузка завершена' : 'Upload finished') : (ru ? 'Загрузка файлов' : 'Uploading files')}: {uploadsDone} / {uploads.length}{uploadsFailed ? ` · ${ru ? 'ошибок' : 'errors'}: ${uploadsFailed}` : ''}</strong>{uploadsFinished && <button onClick={() => setUploads([])} aria-label={ru ? 'Закрыть' : 'Close'}>×</button>}</header><progress max={uploads.length} value={uploadsDone + uploadsFailed} /><div className="documents-upload-list">{uploads.map((u, i) => <div key={`${u.name}-${i}`} className={`is-${u.status}`}><span title={u.name}>{u.name}</span><progress max="100" value={u.progress} /><small>{u.status === 'error' ? (ru ? 'Ошибка' : 'Error') : u.status === 'queued' ? (ru ? 'в очереди' : 'queued') : `${u.progress}%`}</small>{u.status === 'error' && u.error && <em>{u.error}</em>}{u.status === 'done' && u.fileId && archiveFormat(u.name) && <button disabled={Boolean(extracting)} onClick={() => void extractArchive(u.fileId!, u.name.split(' / ').pop()!)}>{ru ? 'Распаковать' : 'Extract'}</button>}</div>)}</div></section>}
      {loading ? <p className="documents-empty">{ru ? 'Загрузка…' : 'Loading…'}</p> : visible.length === 0 ? <div className="documents-empty"><span>📂</span><h2>{ru ? 'Здесь пока нет файлов' : 'No files here yet'}</h2><p>{ru ? 'Загрузите документы или создайте папку.' : 'Upload documents or create a folder.'}</p></div> : <div className={`documents-items documents-${view}`}>{visible.map((item) => { const key = `${item.kind}:${item.id}`; const checked = selected.has(key); return <article key={key} className={checked ? 'documents-item is-selected' : 'documents-item'} draggable onDragStart={(e) => e.dataTransfer.setData('application/x-titanor-document', JSON.stringify({ kind: item.kind, id: item.id }))} onDoubleClick={() => item.kind === 'folder' ? setFolderId(item.id) : setPreviewFile(item.file)}><label className="documents-check"><input type="checkbox" checked={checked} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} /><span className="sr-only">{ru ? 'Выбрать' : 'Select'}</span></label><button className="documents-item-main" onClick={() => item.kind === 'folder' ? setFolderId(item.id) : setPreviewFile(item.file)}><span className="documents-item-icon">{icon(item.category, item.kind === 'folder')}</span><strong>{item.name}</strong><small>{item.kind === 'folder' ? `${item.folder.itemCount} ${ru ? 'элементов' : 'items'}` : `${item.category} · ${formatBytes(item.size)}`}</small><small>{new Date(item.updatedAt).toLocaleDateString(ru ? 'ru-RU' : 'en-GB')}</small></button><details className="documents-menu"><summary aria-label={ru ? 'Действия' : 'Actions'}>⋯</summary><div>{item.kind === 'file' && <><button onClick={() => setPreviewFile(item.file)}>{ru ? 'Просмотреть' : 'Preview'}</button><a href={`/api/admin/documents/files/${item.id}/download`}>{ru ? 'Скачать' : 'Download'}</a>{archiveFormat(item.name) && <button disabled={Boolean(extracting)} onClick={() => void extractArchive(item.id, item.name)}>{ru ? 'Распаковать' : 'Extract'}</button>}</>}<button onClick={() => void rename(item.kind, item.id, item.name)}>{ru ? 'Переименовать' : 'Rename'}</button><button className="is-danger" onClick={() => void remove(item.kind, item.id, item.name)}>{ru ? 'Удалить' : 'Delete'}</button></div></details></article>; })}</div>}
      {dragging && <div className="documents-drop-overlay"><span>↑</span><strong>{ru ? 'Отпустите файлы или папки здесь' : 'Drop files or folders here'}</strong><p>{ru ? 'Папка:' : 'Folder:'} {data?.folder?.name ?? (ru ? 'Документы' : 'Documents')}</p></div>}
      {previewFile && <div className="documents-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setPreviewFile(null); }}><section className="documents-preview" role="dialog" aria-modal="true" aria-labelledby="document-preview-title"><header className="documents-preview-header"><div><span>{ru ? 'Предпросмотр' : 'Preview'}</span><h2 id="document-preview-title">{previewFile.displayName}</h2><small>{previewFile.category} · {formatBytes(previewFile.sizeBytes)}</small></div><div className="documents-preview-actions">{previewDescriptor && <a href={previewUrl} target="_blank" rel="noreferrer">{ru ? 'Открыть отдельно' : 'Open separately'}</a>}<a href={`/api/admin/documents/files/${previewFile.id}/download`}>{ru ? 'Скачать' : 'Download'}</a><button type="button" onClick={() => setPreviewFile(null)} aria-label={ru ? 'Закрыть просмотр' : 'Close preview'}>×</button></div></header><div className={`documents-preview-body${previewDescriptor ? ` is-${previewDescriptor.kind}` : ' is-unsupported'}`}>{previewDescriptor?.kind === 'image' && <img src={previewUrl} alt={previewFile.displayName} />}{previewDescriptor?.kind === 'pdf' && <iframe src={previewUrl} title={previewFile.displayName} />}{previewDescriptor?.kind === 'text' && <iframe src={previewUrl} title={previewFile.displayName} />}{previewDescriptor?.kind === 'video' && <video src={previewUrl} controls preload="metadata" />}{previewDescriptor?.kind === 'audio' && <div className="documents-preview-audio"><span>🎵</span><audio src={previewUrl} controls preload="metadata" /></div>}{!previewDescriptor && <div className="documents-preview-unsupported"><span>📄</span><h3>{ru ? 'Этот формат нельзя показать в браузере' : 'This format cannot be previewed in the browser'}</h3><p>{ru ? 'Файл остаётся защищённым. Скачайте его и откройте в подходящей программе.' : 'The file remains protected. Download it and open it in a compatible application.'}</p><a href={`/api/admin/documents/files/${previewFile.id}/download`}>{ru ? 'Скачать файл' : 'Download file'}</a>{archiveFormat(previewFile.displayName) && <button type="button" disabled={Boolean(extracting)} onClick={() => void extractArchive(previewFile.id, previewFile.displayName)}>{ru ? 'Распаковать архив' : 'Extract archive'}</button>}</div>}</div></section></div>}
      {createOpen && <div className="documents-modal-backdrop" role="presentation"><div className="documents-modal" role="dialog" aria-modal="true" aria-labelledby="create-folder-title"><h2 id="create-folder-title">{ru ? 'Создать папку' : 'Create folder'}</h2><label>{ru ? 'Название' : 'Name'}<input autoFocus value={folderName} onChange={(e) => setFolderName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void createFolder(); if (e.key === 'Escape') setCreateOpen(false); }} /></label><div><button onClick={() => setCreateOpen(false)}>{ru ? 'Отмена' : 'Cancel'}</button><button className="documents-primary" onClick={() => void createFolder()} disabled={!folderName.trim()}>{ru ? 'Создать' : 'Create'}</button></div></div></div>}
      {moveOpen && <div className="documents-modal-backdrop" role="presentation"><div className="documents-modal" role="dialog" aria-modal="true" aria-labelledby="move-title"><h2 id="move-title">{ru ? 'Переместить выбранное' : 'Move selected items'}</h2><label>{ru ? 'Куда' : 'Destination'}<select autoFocus value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)}><option value="">{ru ? 'Документы (корень)' : 'Documents (root)'}</option>{folderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}</select></label><div><button onClick={() => setMoveOpen(false)}>{ru ? 'Отмена' : 'Cancel'}</button><button className="documents-primary" onClick={() => void moveSelected()}>{ru ? 'Переместить' : 'Move'}</button></div></div></div>}
    </main>
  );
}
