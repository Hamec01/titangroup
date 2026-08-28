'use client';

import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';
import type { AdminGpsEvent, AdminPresenceSample } from '@/lib/attendance-gps-admin';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

export function WorkerLocationMap({ items, presenceSamples = [] }: { items: AdminGpsEvent[]; presenceSamples?: AdminPresenceSample[] }) {
  const locale = useAppLocale();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markers = useRef<MapLibreMarker[]>([]);
  useEffect(() => {
    if (!container.current || mapRef.current) return;
    let cancelled = false;
    void import('maplibre-gl').then(({ default: maplibregl }) => {
      if (cancelled || !container.current) return;
      const first = items[0] ?? presenceSamples[0];
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
          .setPopup(new maplibregl.Popup({ offset: 18 }).setText(`${item.operationType === 'CHECK_IN' ? 'Check In' : 'Check Out'} · ${item.siteName} · ${new Date(item.effectiveAt).toLocaleString(locale === 'RU' ? 'ru-RU' : 'en-GB')}`))
          .addTo(map);
        markers.current.push(marker);
      }
      // T12 §2b — mid-shift presence samples: amber, smaller scale, distinct from Check In/Out.
      for (const s of presenceSamples) {
        const zone = s.insideGeofence === true ? (locale === 'RU' ? 'в зоне' : 'in zone') : s.insideGeofence === false ? (locale === 'RU' ? 'вне зоны' : 'outside zone') : locale === 'RU' ? 'зона не определена' : 'zone unknown';
        const label = `${locale === 'RU' ? 'Во время смены' : 'During shift'} · ${s.siteName ?? ''} · ${new Date(s.capturedAt).toLocaleString(locale === 'RU' ? 'ru-RU' : 'en-GB')} · ±${s.accuracyMeters} ${locale === 'RU' ? 'м' : 'm'} · ${zone}${s.capturedOffline ? (locale === 'RU' ? ' · офлайн' : ' · offline') : ''}`;
        const marker = new maplibregl.Marker({ color: '#e0a400', scale: 0.7 })
          .setLngLat([Number(s.longitude), Number(s.latitude)])
          .setPopup(new maplibregl.Popup({ offset: 14 }).setText(label))
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
  }, [items, presenceSamples, locale]);
  return <div ref={container} className="geofence-map" aria-label={localeText(locale, 'Map of retained worker Check In and Check Out locations', 'Карта сохранённых мест Check In и Check Out работника')} />;
}
