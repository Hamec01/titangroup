// R07-B — contact form: rate-limit, SMTP timeouts, sanitized failure logging, honeypot + escaping
// kept, malformed input -> 4xx (never 500). The SMTP transport is stubbed; nothing is sent.
let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

type SendCall = { transport: Record<string, unknown>; mail: Record<string, unknown> };

async function main() {
  process.env.SMTP_HOST = 'smtp.example.test';
  process.env.SMTP_PORT = '465';
  process.env.SMTP_USER = 'mailer@example.test';
  process.env.SMTP_PASSWORD = 'super-secret-smtp-pass';
  process.env.CONTACT_TO_EMAIL = 'inbox@example.test';

  const { POST, __setCreateTransportForTests } = await import('../app/api/contact/route');
  const { __resetRateLimitStore } = await import('../lib/rate-limit');

  const calls: SendCall[] = [];
  let mode: 'ok' | 'reject' = 'ok';
  __setCreateTransportForTests(((transport: Record<string, unknown>) => ({
    async sendMail(mail: Record<string, unknown>) {
      calls.push({ transport, mail });
      if (mode === 'reject') {
        const err = new Error('421 4.7.0 smtp.example.test Service not available <mailer@example.test>');
        (err as unknown as { code: string }).code = 'EENVELOPE';
        throw err;
      }
      return { messageId: '<stub@example.test>' };
    }
  })) as never);

  const errorLog: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errorLog.push(args.map(String).join(' ')); };

  function req(body: string | undefined, ip: string, ct = 'application/json'): Request {
    return new Request('http://localhost/api/contact', {
      method: 'POST',
      headers: { 'content-type': ct, 'x-forwarded-for': ip },
      body
    });
  }
  const valid = () => JSON.stringify({ name: 'Ada', email: 'ada@example.test', message: 'We need hull welders for a Q4 refit.' });

  // ---- malformed / invalid input -> 4xx, never 500 ----
  __resetRateLimitStore();
  check('malformed JSON -> 400', (await POST(req('{not json', '203.0.113.1'))).status === 400);
  check('missing fields -> 400', (await POST(req('{}', '203.0.113.2'))).status === 400);
  check('invalid email -> 400', (await POST(req(JSON.stringify({ name: 'A', email: 'nope', message: 'hi there team' }), '203.0.113.3'))).status === 400);
  check('no mail sent for any 4xx', calls.length === 0);

  // ---- honeypot kept: filled website field -> 200 ok, nothing sent ----
  __resetRateLimitStore();
  {
    const r = await POST(req(JSON.stringify({ name: 'Bot', email: 'bot@example.test', message: 'spam spam', website: 'http://spam' }), '203.0.113.4'));
    check('honeypot -> 200', r.status === 200);
    check('honeypot -> { ok: true }', ((await r.json()) as { ok?: boolean }).ok === true);
    check('honeypot sent no mail', calls.length === 0);
  }

  // ---- happy path -> 200, sendMail called, SMTP timeouts applied, HTML escaped ----
  __resetRateLimitStore();
  {
    const r = await POST(req(JSON.stringify({ name: '<script>x</script>', email: 'ada@example.test', message: 'hull welders <b>now</b>' }), '203.0.113.5'));
    check('valid submission -> 200', r.status === 200, { status: r.status });
    check('sendMail was called once', calls.length === 1);
    const t = calls[0]?.transport ?? {};
    check('transport sets connectionTimeout', t.connectionTimeout === 10_000);
    check('transport sets greetingTimeout', t.greetingTimeout === 10_000);
    check('transport sets socketTimeout', t.socketTimeout === 20_000);
    const html = String(calls[0]?.mail?.html ?? '');
    check('HTML output escapes the submitted name', html.includes('&lt;script&gt;') && !html.includes('<script>'));
    check('HTML output escapes the message', html.includes('&lt;b&gt;now&lt;/b&gt;'));
    check('replyTo is the sender', calls[0]?.mail?.replyTo === 'ada@example.test');
  }

  // ---- rate limit: 5 / window per IP, not bypassable by a forged leading X-Forwarded-For ----
  __resetRateLimitStore();
  {
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await POST(req(valid(), '198.51.100.20'))).status;
    check('6th submission from one IP -> 429', last === 429, { last });
    check('a different IP is unaffected -> 200', (await POST(req(valid(), '198.51.100.21'))).status === 200);
    // The proxy appends the real peer; a client-forged leading entry must not open a fresh bucket.
    const forged = new Request('http://localhost/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4, 198.51.100.20' },
      body: valid()
    });
    check('forged leading XFF does not bypass the limit', (await POST(forged)).status === 429);
  }

  // ---- SMTP failure -> 500 generic, sanitized log (no password, no PII, no raw object) ----
  __resetRateLimitStore();
  {
    mode = 'reject';
    errorLog.length = 0;
    const r = await POST(req(valid(), '203.0.113.9'));
    check('SMTP failure -> 500', r.status === 500);
    check('SMTP failure -> generic client message', ((await r.json()) as { error?: string }).error === 'Unable to send message at the moment.');
    const logged = errorLog.join('\n');
    check('failure was logged', logged.includes('contact: mail send failed'));
    check('log carries the error code', logged.includes('EENVELOPE'));
    check('log does not leak the SMTP password', !logged.includes('super-secret-smtp-pass'));
    check('log does not leak the submitter email', !logged.includes('ada@example.test'));
    check('log does not leak the message text', !logged.includes('hull welders'));
    mode = 'ok';
  }

  __setCreateTransportForTests(null);
  console.error = realError;
  console.log(`\nPASS: ${pass}/${pass + fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
