// T12 §2b — the pure pacing rule for opportunistic presence capture (lib/offline-outbox/presence.ts).
// No DB, no browser.
import { shouldCapturePresence, PRESENCE_MIN_INTERVAL_MS } from '../lib/offline-outbox/presence';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

const now = 1_000_000_000_000;

check('interval is 3 hours', PRESENCE_MIN_INTERVAL_MS === 3 * 60 * 60 * 1000);
check('no previous sample -> capture', shouldCapturePresence(null, now) === true);
check('last sample 10 min ago -> skip', shouldCapturePresence(now - 10 * 60 * 1000, now) === false);
check('last sample exactly 3h ago -> capture', shouldCapturePresence(now - PRESENCE_MIN_INTERVAL_MS, now) === true);
check('last sample 2h59m ago -> skip', shouldCapturePresence(now - (PRESENCE_MIN_INTERVAL_MS - 60_000), now) === false);
check('last sample 5h ago -> capture', shouldCapturePresence(now - 5 * 60 * 60 * 1000, now) === true);
check('clock jumped backwards (future last sample) -> skip', shouldCapturePresence(now + 60_000, now) === false);

console.log(JSON.stringify({ pass, fail }));
process.exit(fail > 0 ? 1 : 0);
