import type { Metadata } from 'next';
import './globals.css';
import 'maplibre-gl/dist/maplibre-gl.css';

export const metadata: Metadata = {
  title: 'Titanor Time',
  description: 'Titanor Time — internal time tracking application (Titanor Group).',
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
