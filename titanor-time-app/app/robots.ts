import type { MetadataRoute } from 'next';

// R07-A — Titanor Time is a private internal application. Nothing here should ever be crawled
// or indexed; disallow the whole origin. (The X-Robots-Tag header in next.config.mjs and the
// root metadata.robots cover clients that never fetch /robots.txt.)
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: '/' }]
  };
}
