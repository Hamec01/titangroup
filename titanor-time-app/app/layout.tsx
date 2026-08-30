import type { Metadata } from 'next';
import './globals.css';
import 'maplibre-gl/dist/maplibre-gl.css';

export const metadata: Metadata = {
  title: 'Titanor Time',
  description: 'Titanor Time — internal time tracking application (Titanor Group).',
  // R07-A — a private internal app: keep it out of every search index (belt to the
  // X-Robots-Tag header's suspenders, and to app/robots.ts).
  robots: { index: false, follow: false, nocache: true },
  icons: {
    icon: '/icons/icon-192.png',
    apple: '/icons/apple-touch-icon.png'
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
