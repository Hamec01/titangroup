'use client';

import { useEffect } from 'react';

// The public site's <html> tag is rendered once, in the root layout (app/layout.tsx), with a
// static lang="en". App Router renders <html> only in the root layout — above the [lang]
// segment — so it cannot see the locale route param. This client effect corrects
// document.documentElement.lang for the active locale (same approach the Titanor Time app uses
// in components/i18n/AppLocaleProvider.tsx). SSR still emits lang="en"; the DOM is corrected on
// hydration and on every client navigation between /fi and /en.
export function HtmlLang({ lang }: { lang: string }) {
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return null;
}
