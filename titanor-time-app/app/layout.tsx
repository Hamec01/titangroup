import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Titanor Time',
  description: 'Titanor Time — internal time tracking application (Titanor Group).'
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
