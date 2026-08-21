'use client';

import { useEffect, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';

const DEFAULT_CENTER: [number, number] = [24.9384, 60.1699];

function circleFeature(longitude: number, latitude: number, radiusMeters: number) {
  const coordinates: [number, number][] = [];
  const earthRadius = 6_371_000;
  const angular = radiusMeters / earthRadius;
  const lat1 = latitude * Math.PI / 180;
  const lon1 = longitude * Math.PI / 180;
  for (let step = 0; step <= 64; step += 1) {
    const bearing = step / 64 * Math.PI * 2;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
    const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
    coordinates.push([lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]);
  }
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [coordinates] } };
}

export function GeofenceMapPicker(props: {
  latitude: string;
  longitude: string;
  radiusMeters: string;
  disabled: boolean;
  onCoordinates: (latitude: string, longitude: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<MapLibreMarker | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const onCoordinatesRef = useRef(props.onCoordinates);
  const disabledRef = useRef(props.disabled);
  onCoordinatesRef.current = props.onCoordinates;
  disabledRef.current = props.disabled;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;
    void import('maplibre-gl').then(({ default: maplibregl }) => {
      if (cancelled || !containerRef.current) return;
      const lat = Number(props.latitude);
      const lon = Number(props.longitude);
      const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lon) && props.latitude !== '' && props.longitude !== '';
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: hasCoordinates ? [lon, lat] : DEFAULT_CENTER,
        zoom: hasCoordinates ? 15 : 10,
        attributionControl: {}
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.on('click', (event) => {
        if (!disabledRef.current) onCoordinatesRef.current(event.lngLat.lat.toFixed(6), event.lngLat.lng.toFixed(6));
      });
      map.on('load', () => {
        if (!map.getSource('geofence-radius')) {
          map.addSource('geofence-radius', { type: 'geojson', data: circleFeature(hasCoordinates ? lon : DEFAULT_CENTER[0], hasCoordinates ? lat : DEFAULT_CENTER[1], Number(props.radiusMeters) || 150) });
          map.addLayer({ id: 'geofence-radius-fill', type: 'fill', source: 'geofence-radius', paint: { 'fill-color': '#2e9fff', 'fill-opacity': 0.18 } });
          map.addLayer({ id: 'geofence-radius-line', type: 'line', source: 'geofence-radius', paint: { 'line-color': '#2e9fff', 'line-width': 2 } });
        }
        if (!cancelled) setMapReady(true);
      });
      mapRef.current = map;
    });
    return () => {
      cancelled = true;
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Map is intentionally created once; live coordinates are synchronized by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const latitude = Number(props.latitude);
    const longitude = Number(props.longitude);
    const radius = Number(props.radiusMeters);
    if (!map || !Number.isFinite(latitude) || !Number.isFinite(longitude) || props.latitude === '' || props.longitude === '') return;
    void import('maplibre-gl').then(({ default: maplibregl }) => {
      if (!mapRef.current) return;
      if (!markerRef.current) {
        markerRef.current = new maplibregl.Marker({ draggable: !props.disabled })
          .setLngLat([longitude, latitude])
          .addTo(mapRef.current);
        markerRef.current.on('dragend', () => {
          const point = markerRef.current?.getLngLat();
          if (point) onCoordinatesRef.current(point.lat.toFixed(6), point.lng.toFixed(6));
        });
      } else {
        markerRef.current.setLngLat([longitude, latitude]);
        markerRef.current.setDraggable(!props.disabled);
      }
      mapRef.current.easeTo({ center: [longitude, latitude], zoom: Math.max(mapRef.current.getZoom(), 14), duration: 300 });
      const source = mapRef.current.getSource('geofence-radius') as GeoJSONSource | undefined;
      if (source) source.setData(circleFeature(longitude, latitude, Number.isFinite(radius) && radius > 0 ? radius : 150));
    });
  }, [mapReady, props.latitude, props.longitude, props.radiusMeters, props.disabled]);

  return (
    <div className="geofence-map-wrap">
      <div ref={containerRef} className="geofence-map" aria-label="Map for selecting the site geofence center" />
      <p className="setup-subtitle">Click the map or drag the marker. Map: OpenFreeMap · data © OpenStreetMap contributors.</p>
    </div>
  );
}
