export {};

import { crc32, inflateRawSync } from 'node:zlib';

let passed = 0;

function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
  passed += 1;
}

/** Reads a zip back via its central directory, verifying every entry's CRC. */
function readZip(buf: Buffer): Map<string, string> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end-of-central-directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central entry');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(local + 26);
    const lelen = buf.readUInt16LE(local + 28);
    const raw = buf.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`crc/size mismatch in ${name}`);
    out.set(name, data.toString('utf8'));
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function wellFormed(xml: string): boolean {
  // Cheap tag-balance check (no DOM parser in Node): every open tag closes in order.
  const stack: string[] = [];
  for (const m of xml.replace(/<\?[^>]*\?>/g, '').matchAll(/<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[3] === '/') continue;
    if (m[1] === '/') { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]);
  }
  return stack.length === 0;
}

async function main() {
  const { columnName, safeSheetName, buildXlsx } = await import('../lib/xlsx-writer');
  const { buildMonthlyMatrix, customerKeyOf } = await import('../lib/reporting/monthly-matrix');
  const { buildMonthlyMatrixXlsx, monthlyMatrixXlsxFileName } = await import('../lib/reporting/monthly-matrix-xlsx');

  check(columnName(0) === 'A' && columnName(25) === 'Z' && columnName(26) === 'AA' && columnName(35) === 'AJ', 'column letters');
  check(safeSheetName('Oct/2026: [x]') === 'Oct 2026 x' && safeSheetName('') === 'Sheet1' && safeSheetName('x'.repeat(40)).length === 31, 'sheet name sanitising');

  const tiny = readZip(buildXlsx({ name: 'T', rows: [[{ value: 'a & <b>' }, { value: 1.5 }]] }));
  check(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'].every((n) => tiny.has(n)), 'all package parts present');
  check(tiny.get('xl/worksheets/sheet1.xml')!.includes('a &amp; &lt;b&gt;') && tiny.get('xl/worksheets/sheet1.xml')!.includes('<v>1.5</v>'), 'escaping and numbers');

  const days = (start: string, minutes: number[]) => minutes.map((m, i) => ({ date: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10), dayType: 'WORK', confirmedZero: false, segments: [], autoUnpaidBreakMinutes: 0, grossMinutes: m, breakMinutes: 0, workedMinutes: m }));
  const slice = { kind: 'WEEKLY_CUSTOMER_SLICE', logicalKey: { employeeId: 'e1', timesheetId: 't', siteId: 's', workAreaId: 'w', weekStart: '2026-10-05', weekEnd: '2026-10-11' }, employeeName: 'Oleksandr Tsvietkov', employeeNumber: '1010', submissionState: 'SUBMITTED', displayDays: days('2026-10-05', [570, 0, 570, 570, 570, 480, 0]) } as never;
  const matrix = buildMonthlyMatrix('2026-10', [{ slice, siteName: 'Meyer Turku Shipyard', workAreaName: 'Siris Finland Oy' }], '2026-10-14', new Map([['e1', { firstName: 'Oleksandr', lastName: 'Tsvietkov' }]]), customerKeyOf('s', 'w'), [
    { employeeId: 'e2', firstName: 'Serhii', lastName: 'Aldushyn', employeeNumber: '1024', customerKey: customerKeyOf('s', 'w'), customerName: 'Siris' }
  ]);
  const files = readZip(buildMonthlyMatrixXlsx(matrix, { customerName: 'Siris Finland Oy', siteName: 'Meyer Turku Shipyard', generatedAt: '14/10/2026, 16:30' }));
  for (const [name, xml] of files) check(wellFormed(xml), `${name} is well-formed`);
  const sheet = files.get('xl/worksheets/sheet1.xml')!;
  const styles = files.get('xl/styles.xml')!;
  check(sheet.includes('Siris Finland Oy — Meyer Turku Shipyard') && sheet.includes('October 2026'), 'title rows');
  check(['Nr.', 'Surname', 'Name', 'Emp. no.', 'Total'].every((h) => sheet.includes(`>${h}<`)), 'header labels like the customer sheet');
  check(/<c r="E4" s="\d+"><v>1<\/v><\/c>/.test(sheet) && /<c r="E5" s="\d+" t="inlineStr"><is><t xml:space="preserve">Th<\/t>/.test(sheet) && /<c r="AI4" s="\d+"><v>31<\/v>/.test(sheet), 'two-row header: day number, weekday under it');
  check(sheet.includes('>Aldushyn<') && sheet.includes('>Tsvietkov<') && sheet.includes('>1010<'), 'worker rows with employee number');
  check(sheet.includes('<v>9.5</v>') && sheet.includes('<v>8</v>'), 'hours are numeric cells');
  check(sheet.includes('>OFF<'), 'OFF cell for the Tuesday gap');
  check(sheet.includes('<f>SUM(E6:AI6)</f>') && sheet.includes('<f>SUM(E6:E7)</f>') && sheet.includes('<f>SUM(AJ6:AJ7)</f>'), 'row, day and grand total formulas');
  check(sheet.includes('<v>46</v>'), 'cached grand total (4×9.5 + 8)');
  check(sheet.includes('xSplit="4" ySplit="5" topLeftCell="E6"') && sheet.includes('orientation="landscape"'), 'frozen worker columns/header and landscape print');
  check(sheet.includes('<mergeCell ref="A8:D8"/>') && sheet.includes('<mergeCell ref="A4:A5"/>') && sheet.includes('<mergeCell ref="AJ4:AJ5"/>') && sheet.includes('>Sum:<'), 'merged Sum: label');
  check(['FF92D050', 'FF00B0F0', 'FFFF0000'].every((c) => styles.includes(c)), 'green / blue / red fills');
  const xfCount = Number(/<cellXfs count="(\d+)"/.exec(styles)![1]);
  const maxStyle = Math.max(...[...sheet.matchAll(/ s="(\d+)"/g)].map((m) => Number(m[1])));
  check(maxStyle < xfCount, 'every cell style index exists');
  check(monthlyMatrixXlsxFileName('Siris Finland Oy', '2026-10') === 'Timesheet_Siris Finland Oy_2026-10.xlsx', 'file name');

  console.log(`monthly matrix xlsx unit: ${passed}/${passed} passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
