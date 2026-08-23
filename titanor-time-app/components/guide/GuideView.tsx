'use client';

import Link from 'next/link';
import { useState } from 'react';
import { GUIDE_CONTENT } from '@/lib/i18n/guide';
import type { AppLocale } from '@/lib/i18n/locale';

// Public, unauthenticated user guide (app/guide/page.tsx). Deliberately self-contained: it does
// NOT touch the app's own NEXT_LOCALE cookie/session locale (that would silently flip the language
// of the login page or an already-authenticated admin session just from reading this page) — this
// toggle is local component state only, seeded once from the server-resolved locale so the initial
// render already matches the visitor's likely language.
export function GuideView({ initialLocale, homeHref }: { initialLocale: AppLocale; homeHref: string }) {
  const [locale, setLocale] = useState<AppLocale>(initialLocale);
  const t = GUIDE_CONTENT[locale];
  const ru = locale === 'RU';
  const backLabel = homeHref === '/login' ? t.backToLogin : t.backToHome;

  return (
    <main className="setup-page guide-page">
      <div className="guide-card">
        <div className="guide-topbar">
          <Link href={homeHref} className="guide-back-link">
            {backLabel}
          </Link>
          <div className="login-locale-switch" role="group" aria-label={ru ? 'Язык' : 'Language'}>
            <button type="button" aria-pressed={locale === 'RU'} onClick={() => setLocale('RU')}>
              RU
            </button>
            <button type="button" aria-pressed={locale === 'EN'} onClick={() => setLocale('EN')}>
              EN
            </button>
          </div>
        </div>

        <h1>{t.pageTitle}</h1>
        <p className="setup-subtitle">{t.tagline}</p>

        <section className="guide-section">
          {t.intro.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </section>

        <section className="guide-section">
          <h2 className="wk-section-title">{t.rolesTitle}</h2>
          <div className="guide-roles-grid">
            {t.roles.map((role) => (
              <div key={role.title} className="guide-role-card">
                <h3>{role.title}</h3>
                <p>{role.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="guide-section">
          <h2 className="wk-section-title">{t.startTitle}</h2>
          <p>{t.startIntro}</p>
          <ol className="guide-steps">
            {t.steps.map((step) => (
              <li key={step.title} className="guide-step">
                <strong>{step.title}</strong>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="guide-section">
          <h2 className="wk-section-title">{t.todayTitle}</h2>
          {t.today.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </section>

        <section className="guide-section">
          <h2 className="wk-section-title">{t.referenceTitle}</h2>
          <p>{t.referenceIntro}</p>
          {t.groups.map((group, i) => (
            <details key={group.title} className="owner-secondary-panel guide-reference-group" open={i === 0}>
              <summary>{group.title}</summary>
              <dl className="guide-reference-list">
                {group.items.map((item) => (
                  <div key={item.title} className="guide-reference-item">
                    <dt>{item.title}</dt>
                    <dd>{item.text}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ))}
        </section>

        <section className="guide-section">
          <h2 className="wk-section-title">{t.workerAppTitle}</h2>
          {t.workerApp.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </section>

        <section className="guide-section">
          <h2 className="wk-section-title">{t.tipsTitle}</h2>
          <ul className="guide-tips">
            {t.tips.map((tip, i) => (
              <li key={i} className="policy-notice">
                {tip}
              </li>
            ))}
          </ul>
        </section>

        <p>
          <Link href={homeHref} className="guide-back-link">
            {backLabel}
          </Link>
        </p>
      </div>
    </main>
  );
}
