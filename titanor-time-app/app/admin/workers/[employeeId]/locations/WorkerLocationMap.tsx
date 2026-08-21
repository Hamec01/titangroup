'use client';

import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';
import type { AdminGpsEvent } from '@/lib/attendance-gps-admin';

export function WorkerLocationMap({ items }: { items: AdminGpsEvent[] }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markers = useRef<MapLibreMarker[]>([]);
  useEffect(() => {
    if (!container.current || mapRef.current) return;
    let cancelled = false;
    void import('maplibre-gl').then(({ default: maplibregl }) => {
      if (cancelled || !container.current) return;
      const first = items[0];
      const map = new maplibregl.Map({
        container: container.current,
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: first ? [Number(first.longitude), Number(first.latitude)] : [24.9384, 60.1699],
        zoom: first ? 14 : 8,
        attributionControl: {}
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      for (const item of items) {
        const marker = new maplibregl.Marker({ color: item.operationType === 'CHECK_IN' ? '#18a558' : '#d05a47' })
          .setLngLat([Number(item.longitude), Number(item.latitude)])
          .setPopup(new maplibregl.Popup({ offset: 18 }).setText(`${item.operationType === 'CHECK_IN' ? 'Check In' : 'Check Out'} · ${item.siteName} · ${new Date(item.effectiveAt).toLocaleString()}`))
          .addTo(map);
        markers.current.push(marker);
      }
      mapRef.current = map;
    });
    return () => {
      cancelled = true;
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [items]);
  return <div ref={container} className="geofence-map" aria-label="Map of retained worker Check In and Check Out locations" />;
}
