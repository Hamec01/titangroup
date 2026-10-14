import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Minimal single-sheet .xlsx (Office Open XML) writer — enough for styled report grids: inline
 * strings, numbers, formulas with cached values, solid fills, bold/coloured fonts, thin borders,
 * alignment, column widths, merged cells, frozen panes and a landscape fit-to-width print setup.
 * No dependency: an .xlsx is a zip of a few XML parts, written here with node:zlib.
 */

export interface XlsxStyle {
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  /** RGB hex without '#', e.g. '9C0006'. */
  fontColor?: string;
  fill?: string;
  border?: boolean;
  align?: 'left' | 'center' | 'right';
}

export interface XlsxCell {
  value?: string | number | null;
  /** Formula without the leading '='; `value` is written as its cached result. */
  formula?: string;
  style?: XlsxStyle;
}

export interface XlsxSheet {
  name: string;
  /** rows[r][c]; null/undefined cells are skipped. */
  rows: Array<Array<XlsxCell | null | undefined>>;
  columnWidths?: number[];
  /** 0-based, inclusive: [firstRow, firstCol, lastRow, lastCol]. */
  merges?: Array<[number, number, number, number]>;
  /** Freeze everything above `row` and left of `col` (0-based counts). */
  freeze?: { rows: number; cols: number };
  landscape?: boolean;
}

export function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function cellRef(row: number, col: number): string {
  return `${columnName(col)}${row + 1}`;
}

function escapeXml(value: string): string {
  // Drop characters XML 1.0 cannot carry at all, then escape markup.
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Excel sheet names: ≤ 31 chars, none of []:*?/\ and not blank. */
export function safeSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31).trim();
  return cleaned || 'Sheet1';
}

function styleKey(s: XlsxStyle | undefined): string {
  return JSON.stringify(s ?? {});
}

function buildStyles(styles: XlsxStyle[]): string {
  const fonts: string[] = [];
  const fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const xfs: string[] = [];
  const fontIndex = new Map<string, number>();
  const fillIndex = new Map<string, number>();
  const font = (s: XlsxStyle) => {
    const xml = `<font>${s.bold ? '<b/>' : ''}${s.italic ? '<i/>' : ''}<sz val="${s.fontSize ?? 11}"/>${s.fontColor ? `<color rgb="FF${s.fontColor.toUpperCase()}"/>` : ''}<name val="Calibri"/><family val="2"/></font>`;
    if (!fontIndex.has(xml)) { fontIndex.set(xml, fonts.length); fonts.push(xml); }
    return fontIndex.get(xml)!;
  };
  const fill = (s: XlsxStyle) => {
    if (!s.fill) return 0;
    const xml = `<fill><patternFill patternType="solid"><fgColor rgb="FF${s.fill.toUpperCase()}"/><bgColor indexed="64"/></patternFill></fill>`;
    if (!fillIndex.has(xml)) { fillIndex.set(xml, fills.length); fills.push(xml); }
    return fillIndex.get(xml)!;
  };
  font({});
  for (const s of styles) {
    const alignment = s.align ? `<alignment horizontal="${s.align}" vertical="center"/>` : '';
    xfs.push(`<xf numFmtId="0" fontId="${font(s)}" fillId="${fill(s)}" borderId="${s.border ? 1 : 0}" xfId="0" applyFont="1" applyFill="1" applyBorder="1"${alignment ? ' applyAlignment="1"' : ''}>${alignment}</xf>`);
  }
  const thin = '<color rgb="FF9AA5B1"/>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
    + `<fills count="${fills.length}">${fills.join('')}</fills>`
    + `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin">${thin}</left><right style="thin">${thin}</right><top style="thin">${thin}</top><bottom style="thin">${thin}</bottom><diagonal/></border></borders>`
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${xfs.length + 1}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${xfs.join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';
}

function buildSheetXml(sheet: XlsxSheet, styleIds: Map<string, number>): string {
  const lastCol = Math.max(1, ...sheet.rows.map((r) => r.length)) - 1;
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
  if (sheet.landscape) parts.push('<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
  parts.push(`<dimension ref="A1:${cellRef(Math.max(0, sheet.rows.length - 1), lastCol)}"/>`);
  if (sheet.freeze && (sheet.freeze.rows > 0 || sheet.freeze.cols > 0)) {
    const { rows, cols } = sheet.freeze;
    const pane = rows > 0 && cols > 0 ? 'bottomRight' : rows > 0 ? 'bottomLeft' : 'topRight';
    parts.push(`<sheetViews><sheetView workbookViewId="0"><pane${cols > 0 ? ` xSplit="${cols}"` : ''}${rows > 0 ? ` ySplit="${rows}"` : ''} topLeftCell="${cellRef(rows, cols)}" activePane="${pane}" state="frozen"/><selection pane="${pane}" activeCell="${cellRef(rows, cols)}" sqref="${cellRef(rows, cols)}"/></sheetView></sheetViews>`);
  } else {
    parts.push('<sheetViews><sheetView workbookViewId="0"/></sheetViews>');
  }
  parts.push('<sheetFormatPr defaultRowHeight="15"/>');
  if (sheet.columnWidths?.length) {
    parts.push(`<cols>${sheet.columnWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`);
  }
  parts.push('<sheetData>');
  sheet.rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((cell, c) => {
      if (!cell) return;
      const ref = cellRef(r, c);
      const s = cell.style ? ` s="${styleIds.get(styleKey(cell.style))}"` : '';
      if (cell.formula) {
        const cached = typeof cell.value === 'number' && Number.isFinite(cell.value) ? `<v>${cell.value}</v>` : '';
        cells.push(`<c r="${ref}"${s}><f>${escapeXml(cell.formula)}</f>${cached}</c>`);
      } else if (typeof cell.value === 'number' && Number.isFinite(cell.value)) {
        cells.push(`<c r="${ref}"${s}><v>${cell.value}</v></c>`);
      } else if (typeof cell.value === 'string' && cell.value !== '') {
        cells.push(`<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.value)}</t></is></c>`);
      } else {
        cells.push(`<c r="${ref}"${s}/>`);
      }
    });
    if (cells.length) parts.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  parts.push('</sheetData>');
  if (sheet.merges?.length) {
    parts.push(`<mergeCells count="${sheet.merges.length}">${sheet.merges.map(([r1, c1, r2, c2]) => `<mergeCell ref="${cellRef(r1, c1)}:${cellRef(r2, c2)}"/>`).join('')}</mergeCells>`);
  }
  parts.push('<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>');
  if (sheet.landscape) parts.push('<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>');
  parts.push('</worksheet>');
  return parts.join('');
}

/** Stored-name zip with DEFLATE entries (the subset every spreadsheet application reads). */
function zip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // 2026-01-01 00:00 in DOS date/time — a fixed stamp keeps output deterministic.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

export function buildXlsx(sheet: XlsxSheet): Buffer {
  const styles: XlsxStyle[] = [];
  const styleIds = new Map<string, number>();
  for (const row of sheet.rows) {
    for (const cell of row) {
      if (!cell?.style) continue;
      const key = styleKey(cell.style);
      if (!styleIds.has(key)) { styles.push(cell.style); styleIds.set(key, styles.length); }
    }
  }
  const sheetName = safeSheetName(sheet.name);
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: buildStyles(styles) },
    { name: 'xl/worksheets/sheet1.xml', data: buildSheetXml(sheet, styleIds) }
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf8') })));
}
