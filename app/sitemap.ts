import { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://titanorgroup.fi';
  const lastModified = new Date('2026-05-29');

  return [
    // Root (redirects to /en, but canonical entry for Google)
    {
      url: `${base}/`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 1.0
    },
    // English
    {
      url: `${base}/en`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 1.0
    },
    {
      url: `${base}/en/services`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.8
    },
    {
      url: `${base}/en/contact`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.8
    },
    // Finnish
    {
      url: `${base}/fi`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 1.0
    },
    {
      url: `${base}/fi/services`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.8
    },
    {
      url: `${base}/fi/contact`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.8
    }
  ];
}
