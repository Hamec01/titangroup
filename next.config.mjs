/** @type {import('next').NextConfig} */

// `output: 'standalone'` is REQUIRED for the self-hosted Docker image — the root Dockerfile's
// runner stage runs `.next/standalone/server.js` and copies `.next/standalone/`. It must stay on
// for every non-Vercel build.
//
// Vercel does NOT support `output: 'standalone'` (it uses its own build output + serverless
// adapter). Since Next 16.3 that combination breaks Vercel's build finalization with
// `ENOENT: .next/next-server.js.nft.json` after a successful compile. On Vercel (VERCEL=1) we
// therefore leave `output` unset and let the platform produce its native output. Verified locally
// on both targets: unset VERCEL -> `.next/standalone/server.js` present, `config.output:
// "standalone"`; VERCEL=1 -> native output, no standalone dir, 19/19 pages, nft file present.

// R07-B — security response headers on every route (page, API, asset). titanorgroup.fi is a public
// marketing site served only over HTTPS through Caddy, so it stays indexable (no X-Robots-Tag) but
// must not be framable, must not sniff content types, and must leak as little as possible. Kept in
// one place so a new route cannot forget them. A Content-Security-Policy is a deliberate follow-up
// (needs an inline-script/style audit first).
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value:
      'geolocation=(), camera=(), microphone=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=(), browsing-topics=()'
  },
  // Honoured by browsers only on HTTPS responses; Caddy terminates TLS in front of the app.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000' }
];

const nextConfig = {
  reactStrictMode: true,
  output: process.env.VERCEL ? undefined : 'standalone',
  // Drop the framework fingerprint (`X-Powered-By: Next.js`).
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: SECURITY_HEADERS
      }
    ];
  }
};

export default nextConfig;
