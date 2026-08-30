// R09.2 — accessDeniedText: every area has short human RU + EN text, no permission-code jargon in
// the body, RU != EN, unknown area falls back. Pure — unit lane.
import { accessDeniedText, ACCESS_DENIED_AREAS, type AccessDeniedArea } from '../lib/i18n/access-denied';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

// a permission code looks like `word.word.word` (two or more dot-separated lowercase segments)
const PERMISSION_CODE = /\b[a-z]+(?:\.[a-z]+){2,}\b/;

for (const area of ACCESS_DENIED_AREAS) {
  const en = accessDeniedText(area, 'EN');
  const ru = accessDeniedText(area, 'RU');
  check(`${area}: EN non-empty`, en.trim().length > 10);
  check(`${area}: RU non-empty`, ru.trim().length > 10);
  check(`${area}: RU differs from EN`, ru !== en);
  check(`${area}: EN has no permission code`, !PERMISSION_CODE.test(en), en);
  check(`${area}: RU has no permission code`, !PERMISSION_CODE.test(ru), ru);
  check(`${area}: EN points to a next step`, /SUPER_ADMIN/.test(en));
  check(`${area}: RU points to a next step`, /SUPER_ADMIN/.test(ru));
}

check('unknown area falls back to the generic admin text', accessDeniedText('nope' as AccessDeniedArea, 'EN') === accessDeniedText('admin', 'EN'));
check('overview text mentions timesheets/attendance context', /timesheet|attendance/i.test(accessDeniedText('overview', 'EN')));

console.log(`\nPASS: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
