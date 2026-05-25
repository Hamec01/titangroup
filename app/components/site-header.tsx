import Link from 'next/link';
import { Locale, locales } from '../i18n';

type SiteHeaderProps = {
  active: 'home' | 'services' | 'contact';
  locale: Locale;
  labels: {
    home: string;
    services: string;
    contact: string;
    cta: string;
  };
};

export function SiteHeader({ active, locale, labels }: SiteHeaderProps) {
  const pagePath = active === 'home' ? '' : `/${active}`;

  return (
    <header className="site-header">
      <Link className="brand" href={`/${locale}`} aria-label="TITANOR GROUP home">
        <span className="brand-title">TITANOR</span>
        <span className="brand-subtitle">GROUP</span>
      </Link>

      <nav className="nav-desktop" aria-label="Primary navigation">
        <Link className={active === 'home' ? 'is-active' : undefined} href={`/${locale}`}>
          {labels.home}
        </Link>
        <Link
          className={active === 'services' ? 'is-active' : undefined}
          href={`/${locale}/services`}
        >
          {labels.services}
        </Link>
        <Link className={active === 'contact' ? 'is-active' : undefined} href={`/${locale}/contact`}>
          {labels.contact}
        </Link>
      </nav>

      <div className="header-lang" aria-label="Language switcher">
        {locales.map((lang) => (
          <Link
            key={lang}
            href={`/${lang}${pagePath}`}
            className={lang === locale ? 'is-active' : undefined}
          >
            {lang.toUpperCase()}
          </Link>
        ))}
      </div>

      <Link className="header-cta" href={`/${locale}/contact`}>
        {labels.cta}
      </Link>

      <details className="nav-mobile">
        <summary aria-label="Open menu">
          <span />
          <span />
          <span />
        </summary>
        <div className="mobile-panel">
          <Link href={`/${locale}`}>{labels.home}</Link>
          <Link href={`/${locale}/services`}>{labels.services}</Link>
          <Link href={`/${locale}/contact`}>{labels.contact}</Link>
          <Link href={`/${locale}/contact`}>{labels.cta}</Link>
          <div className="mobile-lang">
            {locales.map((lang) => (
              <Link
                key={lang}
                href={`/${lang}${pagePath}`}
                className={lang === locale ? 'is-active' : undefined}
              >
                {lang.toUpperCase()}
              </Link>
            ))}
          </div>
        </div>
      </details>
    </header>
  );
}