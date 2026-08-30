import { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // R07-B — keep the private admin surface and raw upload/API paths out of search indexes.
      disallow: ['/ship-admin-portal', '/api/', '/uploads/']
    },
    sitemap: 'https://titanorgroup.fi/sitemap.xml'
  };
}
