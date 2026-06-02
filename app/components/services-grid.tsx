'use client';

import { useEffect, useMemo, useState } from 'react';
import { ServiceCard } from './service-card';
import type { ServiceSection } from '../../lib/service-sections';
import type { Locale } from '../i18n';

type ServiceItem = {
  key: ServiceSection;
  number: string;
  title: string;
  text: string;
  images: string[];
};

type ServicesGridProps = {
  services: ServiceItem[];
  locale: Locale;
  titleTag?: 'h2' | 'h3';
};

type ImageUrlMap = Record<ServiceSection, string[]>;
type ContentByLocale = Record<Locale, Record<ServiceSection, string>>;

export function ServicesGrid({ services, locale, titleTag = 'h3' }: ServicesGridProps) {
  const [dynamicImages, setDynamicImages] = useState<ImageUrlMap | null>(null);
  const [dynamicContent, setDynamicContent] = useState<ContentByLocale | null>(null);

  useEffect(() => {
    let isMounted = true;

    const load = async () => {
      try {
        const [imagesResponse, contentResponse] = await Promise.all([
          fetch('/api/service-images', { cache: 'no-store' }),
          fetch('/api/service-content', { cache: 'no-store' })
        ]);

        if (imagesResponse.ok) {
          const payload = (await imagesResponse.json()) as ImageUrlMap;
          if (isMounted) {
            setDynamicImages(payload);
          }
        }

        if (contentResponse.ok) {
          const payload = (await contentResponse.json()) as ContentByLocale;
          if (isMounted) {
            setDynamicContent(payload);
          }
        }
      } catch {
        // Keep static fallback images from i18n if API is unavailable.
      }
    };

    void load();

    return () => {
      isMounted = false;
    };
  }, []);

  const resolvedServices = useMemo(
    () =>
      services.map((service) => {
        const replacement = dynamicImages?.[service.key];

        if (!replacement || replacement.length === 0) {
          return service;
        }

        return {
          ...service,
          images: replacement,
          text: dynamicContent?.[locale]?.[service.key] || service.text
        };
      }),
    [dynamicContent, dynamicImages, locale, services]
  );

  return (
    <div className="services-grid">
      {resolvedServices.map((service) => (
        <ServiceCard
          key={service.title}
          number={service.number}
          title={service.title}
          text={service.text}
          images={service.images}
          titleTag={titleTag}
        />
      ))}
    </div>
  );
}
