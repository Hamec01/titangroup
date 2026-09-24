export {};

async function main() {
  const { DEFAULT_ADMIN_THEME, normalizeAdminTheme } = await import('../lib/admin-theme');
  const checks: Array<[string, boolean]> = [
    ['Titan dark is the default theme', DEFAULT_ADMIN_THEME === 'titan-dark'],
    ['missing cookie uses Titan dark', normalizeAdminTheme(undefined) === 'titan-dark'],
    ['empty cookie uses Titan dark', normalizeAdminTheme('') === 'titan-dark'],
    ['malformed cookie uses Titan dark', normalizeAdminTheme('unknown') === 'titan-dark'],
    ['explicit light preference is preserved', normalizeAdminTheme('light') === 'light'],
    ['explicit graphite preference is preserved', normalizeAdminTheme('graphite') === 'graphite'],
    ['explicit ocean preference is preserved', normalizeAdminTheme('ocean') === 'ocean']
  ];
  for (const [name, ok] of checks) {
    if (!ok) throw new Error(name);
  }
  console.log(`admin theme unit: ${checks.length}/${checks.length} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
