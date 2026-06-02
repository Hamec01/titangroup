'use client';

import { useMemo, useState } from 'react';

type ServiceCardProps = {
  number: string;
  title: string;
  text: string;
  images: string[];
  titleTag?: 'h2' | 'h3';
};

export function ServiceCard({ number, title, text, images, titleTag = 'h3' }: ServiceCardProps) {
  const safeImages = useMemo(() => images.filter(Boolean), [images]);
  const [activeIndex, setActiveIndex] = useState(0);

  const hasMultipleImages = safeImages.length > 1;
  const activeImage = safeImages[activeIndex] ?? '';
  const TitleTag = titleTag;

  const goToPrev = () => {
    setActiveIndex((current) => (current === 0 ? safeImages.length - 1 : current - 1));
  };

  const goToNext = () => {
    setActiveIndex((current) => (current === safeImages.length - 1 ? 0 : current + 1));
  };

  return (
    <article className="service-card">
      <div
        className="service-image"
        style={{
          backgroundImage: `linear-gradient(180deg, rgba(5, 7, 11, 0.06), rgba(5, 7, 11, 0.5)), url(${activeImage})`
        }}
      >
        {hasMultipleImages ? (
          <div className="service-image-controls">
            <button
              className="service-image-control"
              type="button"
              onClick={goToPrev}
              aria-label={`Previous image for ${title}`}
            >
              {'<'}
            </button>
            <button
              className="service-image-control"
              type="button"
              onClick={goToNext}
              aria-label={`Next image for ${title}`}
            >
              {'>'}
            </button>
          </div>
        ) : null}
      </div>

      <div className="service-content">
        <span className="service-number">{number}</span>
        <TitleTag>{title}</TitleTag>
        <p>{text}</p>
      </div>
    </article>
  );
}