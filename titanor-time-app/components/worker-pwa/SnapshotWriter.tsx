'use client';

import { useEffect } from 'react';
import { writeWorkerReadSnapshot, type SnapshotPayloadFor } from '@/lib/offline-outbox/read-snapshots';
import type { SnapshotRouteKind } from '@/lib/offline-outbox/db';

// docs/titanor-time/T8_PWA_DESIGN.md §F.8 — the only thing every offline-eligible Worker Server
// Component page adds. Renders nothing, takes no props besides the exact allowlisted payload the
// page already computed (never an HTTP fetch, never a Prisma/server import). Not async (Client
// Components cannot be). A write failure (IndexedDB unavailable, quota, anything) never surfaces —
// this is a best-effort "while you're here, remember this for later" side effect that must never
// affect the online page's own rendering or behavior.
interface SnapshotWriterProps<K extends SnapshotRouteKind> {
  routeKind: K;
  ownerUserId: string;
  periodId?: string;
  date?: string;
  payload: SnapshotPayloadFor<K>;
}

export function SnapshotWriter<K extends SnapshotRouteKind>({ routeKind, ownerUserId, periodId, date, payload }: SnapshotWriterProps<K>) {
  useEffect(() => {
    writeWorkerReadSnapshot({ routeKind, ownerUserId, periodId, date, payload }).catch(() => {
      // Intentionally ignored — see file header comment.
    });
    // Payload is fully captured once per page render (Server Components don't client-re-render
    // without a real navigation, which mounts a fresh instance of this component anyway).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
