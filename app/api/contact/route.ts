import { NextResponse } from 'next/server';
import * as nodemailer from 'nodemailer';
import { checkRateLimit } from '../../../lib/rate-limit';
import { clientRateLimitKey } from '../../../lib/client-ip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FIELD_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 5000;

// R07-B — 5 submissions / 15 min per trusted client IP. Fixed window, in-memory; a restart clears
// it (acceptable for a one-instance low-traffic site).
const RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 };

// R07-B — bound every stage of the SMTP conversation so a slow/hung mail server cannot pin a
// request (and its socket) open indefinitely.
const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };

// Test seam: the security regression suite swaps in a stub so nothing is actually sent.
type CreateTransport = typeof nodemailer.createTransport;
let createTransport: CreateTransport = nodemailer.createTransport;
export function __setCreateTransportForTests(fn: CreateTransport | null): void {
  createTransport = fn ?? nodemailer.createTransport;
}

type ContactPayload = {
  name?: unknown;
  company?: unknown;
  email?: unknown;
  message?: unknown;
  website?: unknown;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function normalizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, maxLength);
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// R07-B — never log the submitted payload (name / email / message are personal data) or a raw
// error object (SMTP errors can echo the envelope). Keep only a short, non-sensitive signal.
function logSendFailure(error: unknown): void {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'UNKNOWN';
  const message = error instanceof Error ? error.message.slice(0, 200) : 'send failed';
  console.error(`contact: mail send failed [${code}] ${message}`);
}

export async function POST(request: Request) {
  if (!checkRateLimit(`contact-ip:${clientRateLimitKey(request)}`, RATE_LIMIT.limit, RATE_LIMIT.windowMs).allowed) {
    return NextResponse.json(
      { ok: false, error: 'Too many messages. Please try again later.' },
      { status: 429 }
    );
  }

  let payload: ContactPayload;
  try {
    payload = (await request.json()) as ContactPayload;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body.' }, { status: 400 });
  }

  const honeypot = normalizeText(payload.website, MAX_FIELD_LENGTH);

  if (honeypot) {
    return NextResponse.json({ ok: true });
  }

  const name = normalizeText(payload.name, MAX_FIELD_LENGTH);
  const company = normalizeText(payload.company, MAX_FIELD_LENGTH);
  const email = normalizeText(payload.email, MAX_FIELD_LENGTH);
  const message = normalizeText(payload.message, MAX_MESSAGE_LENGTH);

  if (!name || !email || !message) {
    return NextResponse.json(
      { ok: false, error: 'Name, email and message are required.' },
      { status: 400 }
    );
  }

  if (!isValidEmail(email)) {
    return NextResponse.json({ ok: false, error: 'Invalid email address.' }, { status: 400 });
  }

  try {
    const smtpHost = getRequiredEnv('SMTP_HOST');
    const smtpPort = Number.parseInt(process.env.SMTP_PORT || '465', 10);
    const smtpSecure = (process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
    const smtpUser = getRequiredEnv('SMTP_USER');
    const smtpPassword = getRequiredEnv('SMTP_PASSWORD');
    const toEmail = getRequiredEnv('CONTACT_TO_EMAIL');
    const fromEmail = process.env.CONTACT_FROM_EMAIL || smtpUser;

    const transporter = createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPassword
      },
      ...SMTP_TIMEOUTS
    });

    const subject = `Titanor project inquiry from ${name}`;
    const text = [
      'New project inquiry from titanorgroup.fi',
      '',
      `Name: ${name}`,
      `Company: ${company || '-'}`,
      `Email: ${email}`,
      '',
      'Message:',
      message
    ].join('\n');

    const html = `
      <h2>New project inquiry from titanorgroup.fi</h2>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Company:</strong> ${escapeHtml(company || '-')}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Message:</strong></p>
      <p>${escapeHtml(message).replaceAll('\n', '<br />')}</p>
    `;

    await transporter.sendMail({
      from: `"Titanor Website" <${fromEmail}>`,
      to: toEmail,
      replyTo: email,
      subject,
      text,
      html
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    logSendFailure(error);

    return NextResponse.json(
      { ok: false, error: 'Unable to send message at the moment.' },
      { status: 500 }
    );
  }
}
