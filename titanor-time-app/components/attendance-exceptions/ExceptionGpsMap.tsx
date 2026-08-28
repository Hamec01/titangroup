'use client';

import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

// GPS-1 (2026-08-28) — the "where was this" mini-map on a GPS_NOT_VERIFIED / VERIFIED_OUTSIDE
// exception: the retained (possibly imprecise) worker point + its accuracy circle + the site
// geofence circle, so the admin can eyeball "the ±2 km circle is centred on the shipyard" vs
// "the point is 40 km away". Same OpenFreeMap style + MapLibre pattern as GeofenceMapPicker /
// WorkerLocationMap. Only rendered when the caller holds attendance.gps.read.raw.

function circleFeature(longitude: number, latitude: number, radiusMeters: number) {
  const earthRadius = 6371000;
  const coordinates: [number, number][] = [];
  const angular = radiusMeters / earthRadius;
  const latRad = (latitude * Math.PI) / 180;
  for (let i = 0; i <= 64; i++) {
    const bearing = (i / 64) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(latRad) * Math.cos(angular) + Math.cos(latRad) * Math.sin(angular) * Math.cos(bearing));
    const lon2 =
      (longitude * Math.PI) / 180 +
      Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(latRad), Math.cos(angular) - Math.sin(latRad) * Math.sin(lat2));
    coordinates.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [coordinates] } };
}

interface Props {
  point: { latitude: number; longitude: number };
  accuracyMeters: number | null;
  geofence: { latitude: number; longitude: number; radiusMeters: number } | null;
}

export function ExceptionGpsMap({ point, accuracyMeters, geofence }: Props) {
  const locale = useAppLocale();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markers = useRef<MapLibreMarker[]>([]);

  useEffect(() => {
    if (!container.current || mapRef.current) return;
    let cancelled = false;
    void import('maplibre-gl').then(({ default: maplibregl }) => {
      if (cancelled || !container.current) return;
      const map = new maplibregl.Map({
        container: container.current,
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: [point.longitude, point.latitude],
        zoom: 13,
        attributionControl: {}
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

      map.on('load', () => {
        if (geofence) {
          map.addSource('exc-geofence', { type: 'geojson', data: circleFeature(geofence.longitude, geofence.latitude, geofence.radiusMeters) });
          map.addLayer({ id: 'exc-geofence-fill', type: 'fill', source: 'exc-geofence', paint: { 'fill-color': '#18a558', 'fill-opacity': 0.15 } });
          map.addLayer({ id: 'exc-geofence-line', type: 'line', source: 'exc-geofence', paint: { 'line-color': '#18a558', 'line-width': 2 } });
        }
        if (accuracyMeters && accuracyMeters > 0) {
          map.addSource('exc-accuracy', { type: 'geojson', data: circleFeature(point.longitude, point.latitude, accuracyMeters) });
          map.addLayer({ id: 'exc-accuracy-fill', type: 'fill', source: 'exc-accuracy', paint: { 'fill-color': '#d05a47', 'fill-opacity': 0.14 } });
          map.addLayer({ id: 'exc-accuracy-line', type: 'line', source: 'exc-accuracy', paint: { 'line-color': '#d05a47', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
        }

        // fit both circles + point
        const bounds = new maplibregl.LngLatBounds();
        bounds.extend([point.longitude, point.latitude]);
        if (geofence) bounds.extend([geofence.longitude, geofence.latitude]);
        const pad = Math.max(accuracyMeters ?? 0, geofence?.radiusMeters ?? 0);
        if (pad > 0) {
          // rough degree padding so the circle isn't clipped
          const dLat = (pad / 111000) * 1.4;
          bounds.extend([point.longitude - dLat, point.latitude - dLat]);
          bounds.extend([point.longitude + dLat, point.latitude + dLat]);
        }
        map.fitBounds(bounds, { padding: 48, maxZoom: 16, duration: 0 });
      });

      markers.current.push(new maplibregl.Marker({ color: '#d05a47' }).setLngLat([point.longitude, point.latitude]).addTo(map));
      if (geofence) {
        markers.current.push(new maplibregl.Marker({ color: '#18a558' }).setLngLat([geofence.longitude, geofence.latitude]).addTo(map));
      }
      mapRef.current = map;
    });
    return () => {
      cancelled = true;
      markers.current.forEach((m) => m.remove());
      markers.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [point.latitude, point.longitude, accuracyMeters, geofence, locale]);

  return (
    <div
      ref={container}
      className="geofence-map"
      aria-label={localeText(locale, 'Map: worker GPS point, accuracy circle and the site geofence', 'Карта: GPS-точка работника, круг точности и геозона объекта')}
    />
  );
}
