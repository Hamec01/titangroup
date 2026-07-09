import { NextResponse } from 'next/server';
import * as nodemailer from 'nodemailer';

export const runtime = 'nodejs';

const MAX_FIELD_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 5000;

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

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as ContactPayload;

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

    const smtpHost = getRequiredEnv('SMTP_HOST');
    const smtpPort = Number.parseInt(process.env.SMTP_PORT || '465', 10);
    const smtpSecure = (process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
    const smtpUser = getRequiredEnv('SMTP_USER');
    const smtpPassword = getRequiredEnv('SMTP_PASSWORD');
    const toEmail = getRequiredEnv('CONTACT_TO_EMAIL');
    const fromEmail = process.env.CONTACT_FROM_EMAIL || smtpUser;

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPassword
      }
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
    console.error('Contact form send failed:', error);

    return NextResponse.json(
      { ok: false, error: 'Unable to send message at the moment.' },
      { status: 500 }
    );
  }
}
