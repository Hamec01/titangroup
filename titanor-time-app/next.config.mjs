// R07-A — security response headers applied to every route (page, API, asset). Titanor Time is a
// private internal application: it is never framed, never indexed, and only ever reached over
// HTTPS through Caddy. Kept in one place instead of per-route so a new route cannot forget them.
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // geolocation is needed by the worker PWA (lib/worker-gps.ts); everything else is denied.
  {
    key: 'Permissions-Policy',
    value:
      'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=(), browsing-topics=()'
  },
  // Honoured by browsers only on HTTPS responses; Caddy terminates TLS in front of the app.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' }
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Drop the framework fingerprint (`X-Powered-By: Next.js`).
  poweredByHeader: false,
  turbopack: {
    root: import.meta.dirname
  },
  typescript: {
    // scripts/ holds standalone dev/CI regression tools (run via `tsx`, never bundled into the
    // app) with their own separate typecheck workflow (`npx tsc --noEmit` against the default
    // tsconfig.json) and their own dependency needs — e.g. scripts/_test-export-ui.ts's Playwright
    // import, which must never be a real npm dependency here (it would drag Chromium's browser
    // binary into the production image via this Dockerfile's runner stage, which copies the full
    // node_modules). tsconfig.build.json excludes scripts/ so the production build's typecheck gate
    // only covers code that actually ships.
    tsconfigPath: './tsconfig.build.json'
  },
  // Next.js's standalone output-file tracing does not always follow Prisma's
  // dynamically-loaded native query engine binary. Force it in explicitly so
  // .next/standalone actually contains it at runtime.
  //
  // pdfkit + fontkit are deliberately NOT in serverExternalPackages: the Turbopack
  // build inlines them into the server chunks together with a virtual FS for
  // pdfkit's *.afm metric files and fontkit's trie tables, so the bundle is
  // self-contained. Marking them external instead makes node-file-trace follow
  // their require graph and it drops CJS-only conditional deps (@noble/hashes CJS
  // entry, restructure, unicode-properties, brotli) — a partial, broken tree. The
  // reporting code (lib/reporting/*-pdf.ts) always registers the embedded DejaVu
  // TTFs from assets/ before drawing, so no dependency on a physical node_modules
  // font layout at runtime. R06-B verifies real PDF output from the slim image.
  outputFileTracingIncludes: {
    '/api/ready': ['./node_modules/.prisma/client/**/*']
  },
  // T7A.10C.1 FOLLOW-UP — explicit, checkable response contract for the offline PWA shell
  // (public/sw.js caches this route as the /worker offline fallback). The route itself is already
  // static/data-free (app/worker-offline/page.tsx — no cookies()/headers()/dynamic='force-dynamic'),
  // so no Set-Cookie is ever set here structurally; this header makes the safe-to-cache contract
  // explicit and testable via a real HTTP response, not just inferred from the route's source.
  async headers() {
    return [
      {
        // R07-A — security headers on everything.
        source: '/:path*',
        headers: SECURITY_HEADERS
      },
      {
        source: '/worker-offline',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }]
      }
    ];
  }
};

export default nextConfig;
