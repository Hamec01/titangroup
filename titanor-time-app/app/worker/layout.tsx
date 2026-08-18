import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ServiceWorkerRegistration } from '@/components/worker-pwa/ServiceWorkerRegistration';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §C — the PWA manifest
// link and service worker registration are scoped to the /worker* prefix ONLY via this nested
// layout, never added to the app-wide root layout. Next.js merges this `metadata.manifest` into
// <head> only for routes under this layout.
export const metadata: Metadata = {
  manifest: '/manifest.webmanifest'
};

export default function WorkerLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ServiceWorkerRegistration />
      {children}
    </>
  );
}
