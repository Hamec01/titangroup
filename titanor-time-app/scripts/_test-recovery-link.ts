import { buildRecoveryLink, parseRecoveryLinkFragment } from '../lib/recovery-link';

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, value?: unknown) => {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.error('FAIL:', name, value);
  }
};

const login = 'worker+night@example.fi';
const code = 'K7M4-9QX2-P3RF';
const link = buildRecoveryLink('https://app.titanorgroup.fi/admin/workers/ignored', { login, code });
const url = new URL(link);

check('1: recovery link targets /reset-password', url.origin === 'https://app.titanorgroup.fi' && url.pathname === '/reset-password', link);
check('2: secret is absent from query string', url.search === '' && !url.search.includes(code), url.search);
check('3: fragment carries encoded login and code', url.hash.length > 1 && url.hash.includes('login=') && url.hash.includes('code='), url.hash);
check('4: generated fragment round-trips', JSON.stringify(parseRecoveryLinkFragment(url.hash)) === JSON.stringify({ login, code }));
check('5: parser accepts a fragment without leading #', parseRecoveryLinkFragment(url.hash.slice(1))?.code === code);
check('6: parser rejects missing login', parseRecoveryLinkFragment('#code=AAAA-BBBB-CCCC') === null);
check('7: parser rejects missing code', parseRecoveryLinkFragment('#login=worker') === null);
check('8: parser rejects oversized values', parseRecoveryLinkFragment(`#login=${'x'.repeat(321)}&code=${code}`) === null);

console.log(JSON.stringify({ pass, fail }));
if (fail > 0) process.exit(1);
