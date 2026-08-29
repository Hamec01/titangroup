import nodemailer from 'nodemailer';

interface PasswordResetMailConfig {
  appUrl: URL;
  from: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

/**
 * Validates all delivery settings before a token is issued. In particular, the
 * reset URL never comes from a request Host header, which would otherwise turn
 * a password recovery email into a host-header injection primitive.
 */
export function passwordResetMailConfig(): PasswordResetMailConfig {
  const rawAppUrl = requiredEnv('APP_URL');
  let appUrl: URL;
  try {
    appUrl = new URL(rawAppUrl);
  } catch {
    throw new Error('APP_URL must be an absolute http(s) URL.');
  }
  if (appUrl.protocol !== 'https:' && appUrl.protocol !== 'http:') {
    throw new Error('APP_URL must use http or https.');
  }
  if (process.env.NODE_ENV === 'production' && appUrl.protocol !== 'https:') {
    throw new Error('APP_URL must use https in production.');
  }

  const rawPort = requiredEnv('SMTP_PORT');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be a valid TCP port.');
  }
  const rawSecure = process.env.SMTP_SECURE?.trim().toLowerCase();
  if (rawSecure !== 'true' && rawSecure !== 'false') {
    throw new Error('SMTP_SECURE must be true or false.');
  }

  return {
    appUrl,
    from: process.env.AUTH_EMAIL_FROM?.trim() || requiredEnv('SMTP_USER'),
    host: requiredEnv('SMTP_HOST'),
    port,
    secure: rawSecure === 'true',
    user: requiredEnv('SMTP_USER'),
    password: requiredEnv('SMTP_PASSWORD')
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}

export function passwordResetUrl(config: PasswordResetMailConfig, rawToken: string): string {
  return new URL(`/reset-password/${encodeURIComponent(rawToken)}`, config.appUrl).toString();
}

export async function sendPasswordResetEmail(
  config: PasswordResetMailConfig,
  input: { to: string; username: string; resetUrl: string }
): Promise<void> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password }
  });
  const safeUsername = escapeHtml(input.username);
  const safeUrl = escapeHtml(input.resetUrl);

  await transport.sendMail({
    from: config.from,
    to: input.to,
    subject: 'Titanor Time — password reset',
    text: `Hello ${input.username},\n\nUse this one-time link to set a new Titanor Time password. It expires in 60 minutes:\n${input.resetUrl}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>Hello ${safeUsername},</p><p>Use this one-time link to set a new Titanor Time password. It expires in 60 minutes:</p><p><a href="${safeUrl}">Set a new password</a></p><p>If you did not request this, you can ignore this email.</p>`
  });
}
