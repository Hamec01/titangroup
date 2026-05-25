import type { Metadata } from 'next';
import { Bebas_Neue, Manrope } from 'next/font/google';
import './globals.css';

const displayFont = Bebas_Neue({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-display'
});

const bodyFont = Manrope({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-body'
});

export const metadata: Metadata = {
  title: 'TITANOR GROUP — Shipbuilding & Marine Engineering',
  description:
    'Shipbuilding, steel structures, welding, marine engineering and industrial solutions in Finland and Europe.'
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${displayFont.variable} ${bodyFont.variable}`}>{children}</body>
    </html>
  );
}