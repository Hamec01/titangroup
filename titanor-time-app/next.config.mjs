/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  turbopack: {
    root: import.meta.dirname
  },
  // Next.js's standalone output-file tracing does not always follow Prisma's
  // dynamically-loaded native query engine binary. Force it in explicitly so
  // .next/standalone actually contains it at runtime.
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
        source: '/worker-offline',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }]
      }
    ];
  }
};

export default nextConfig;
