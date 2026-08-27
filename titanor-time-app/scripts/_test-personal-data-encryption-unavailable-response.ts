// Worker Dossier feature — direct lib-level test for personalDataEncryptionUnavailable()
// (lib/api-error.ts), the catch-block helper that every henkilötunnus-touching route delegates to
// when encrypt/decrypt fails. A missing/malformed PERSONAL_DATA_ENCRYPTION_KEY must become a clean,
// diagnosable 503 with a stable `code` — never an opaque 500 the UI can only render as a generic
// "contact your administrator". Any other error must pass straight through unchanged. No DB/HTTP.
import { PersonalDataEncryptionConfigError } from '../lib/personal-data-encryption';
import { personalDataEncryptionUnavailable } from '../lib/api-error';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${name}`, extra ?? '');
  }
}

async function main(): Promise<void> {
  const requestId = 'test-request-id';

  // --- Config error → 503 in the standard envelope ---
  const response = personalDataEncryptionUnavailable(new PersonalDataEncryptionConfigError('PERSONAL_DATA_ENCRYPTION_KEY is not set.'), requestId);
  check('config error maps to HTTP 503', response.status === 503, response.status);
  check('response carries the request id header', response.headers.get('X-Request-Id') === requestId);
  const body = (await response.json()) as { error?: { code?: string; message?: string; requestId?: string } };
  check('body.error.code is the stable PERSONAL_DATA_ENCRYPTION_UNAVAILABLE', body.error?.code === 'PERSONAL_DATA_ENCRYPTION_UNAVAILABLE', body.error?.code);
  check('body.error.requestId echoes the request id', body.error?.requestId === requestId);
  check('body.error.message never leaks the key or a henkilötunnus', typeof body.error?.message === 'string' && !/\d{6}[-+A]\d{3}/.test(body.error!.message!));

  // --- Any other error is re-thrown untouched (never swallowed into a 503) ---
  const passthrough = new Error('some unrelated database failure');
  let rethrew: unknown = null;
  try {
    personalDataEncryptionUnavailable(passthrough, requestId);
  } catch (error) {
    rethrew = error;
  }
  check('a non-config error is re-thrown, not converted', rethrew === passthrough);

  // --- A plain string / non-Error is also re-thrown, not treated as a config error ---
  let stringRethrew = false;
  try {
    personalDataEncryptionUnavailable('not an error object', requestId);
  } catch (error) {
    stringRethrew = error === 'not an error object';
  }
  check('a non-Error value is re-thrown unchanged', stringRethrew);

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
