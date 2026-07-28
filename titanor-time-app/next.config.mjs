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
  }
};

export default nextConfig;
