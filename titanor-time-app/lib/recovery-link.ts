export interface RecoveryLinkPrefill {
  login: string;
  code: string;
}

/**
 * Keep the one-time recovery code in the URL fragment. Fragments stay in the browser and are not
 * sent with the initial HTTP request, so the code does not enter Caddy / Next access logs.
 */
export function buildRecoveryLink(origin: string, prefill: RecoveryLinkPrefill): string {
  const url = new URL('/reset-password', origin);
  url.hash = new URLSearchParams({ login: prefill.login, code: prefill.code }).toString();
  return url.toString();
}

/** Parse only the two allowlisted recovery fields, with the same outer size limits as the API. */
export function parseRecoveryLinkFragment(fragment: string): RecoveryLinkPrefill | null {
  const params = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  const login = params.get('login')?.trim() ?? '';
  const code = params.get('code')?.trim() ?? '';
  if (!login || login.length > 320 || !code || code.length > 64) return null;
  return { login, code };
}
