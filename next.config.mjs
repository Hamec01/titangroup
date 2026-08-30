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
const nextConfig = {
  reactStrictMode: true,
  output: process.env.VERCEL ? undefined : 'standalone'
};

export default nextConfig;
