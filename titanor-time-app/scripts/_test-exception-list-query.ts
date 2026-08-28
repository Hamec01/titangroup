// T12 fix (2026-08-28) — parseExceptionListQuery: `?status=OPEN&type=&from=&to=` (exactly what the
// filter <form method=GET> emits for its untouched fields) must be "no type/from/to filter", not
// "три некорректных фильтра". A non-empty invalid value is still a 400. Pure function, no DB.
import { parseExceptionListQuery, type ExceptionListQueryInput } from '../lib/attendance-exceptions';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

const base: ExceptionListQueryInput = {
  page: null,
  pageSize: null,
  status: null,
  type: null,
  siteId: null,
  employeeId: null,
  payrollPeriodId: null,
  from: null,
  to: null
};

// 1. The exact failing URL from the screenshot: status set, everything else an empty string.
{
  const r = parseExceptionListQuery({ ...base, status: 'OPEN', type: '', from: '', to: '' }, { allowEmployeeId: true });
  check('status=OPEN&type=&from=&to= -> ok', r.ok === true, r);
  if (r.ok) {
    check('  status parsed as OPEN', r.filters.status === 'OPEN', r.filters);
    check('  type left unset', r.filters.type === undefined, r.filters);
    check('  from/to left unset', r.filters.occurredFrom === undefined && r.filters.occurredTo === undefined, r.filters);
  }
}

// 2. All-blank (every field an empty string) -> defaults, ok.
{
  const r = parseExceptionListQuery(
    { page: '', pageSize: '', status: '', type: '', siteId: '', employeeId: '', payrollPeriodId: '', from: '', to: '' },
    { allowEmployeeId: true }
  );
  check('all-blank -> ok with defaults', r.ok === true && r.ok && r.filters.status === 'OPEN' && r.filters.page === 1, r);
}

// 3. Whitespace-only is also "not provided".
{
  const r = parseExceptionListQuery({ ...base, type: '   ' }, { allowEmployeeId: true });
  check('type="   " -> ok, unset', r.ok === true && r.ok && r.filters.type === undefined, r);
}

// 4. A genuinely present, non-empty invalid value is STILL a 400 (contract preserved).
{
  const r = parseExceptionListQuery({ ...base, type: 'NONSENSE' }, { allowEmployeeId: true });
  check('type=NONSENSE -> 400 with fieldErrors.type', r.ok === false && !!(r as { fieldErrors: Record<string, string[]> }).fieldErrors.type, r);
}
{
  const r = parseExceptionListQuery({ ...base, from: 'not-a-date' }, { allowEmployeeId: true });
  check('from=not-a-date -> 400 with fieldErrors.from', r.ok === false && !!(r as { fieldErrors: Record<string, string[]> }).fieldErrors.from, r);
}
{
  const r = parseExceptionListQuery({ ...base, siteId: 'xxx' }, { allowEmployeeId: true });
  check('siteId=xxx -> 400 with fieldErrors.siteId', r.ok === false && !!(r as { fieldErrors: Record<string, string[]> }).fieldErrors.siteId, r);
}

// 5. Valid explicit values still work.
{
  const r = parseExceptionListQuery({ ...base, status: 'RESOLVED', type: 'GPS_NOT_VERIFIED', from: '2026-08-01', to: '2026-08-31' }, { allowEmployeeId: true });
  check('valid explicit filters -> ok', r.ok === true, r);
  if (r.ok) {
    check('  type = GPS_NOT_VERIFIED', r.filters.type === 'GPS_NOT_VERIFIED', r.filters);
    check('  occurredFrom / occurredTo are Dates', r.filters.occurredFrom instanceof Date && r.filters.occurredTo instanceof Date, r.filters);
  }
}

console.log(JSON.stringify({ pass, fail }));
process.exit(fail > 0 ? 1 : 0);
