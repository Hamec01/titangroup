import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteHeader } from '../components/site-header';
import { ContactForm } from '../components/contact-form';
import { ServicesGrid } from '../components/services-grid';
import { assertLocale, dictionary, isLocale } from '../i18n';

type HomePageProps = {
  params: Promise<{ lang: string }>;
};

export default async function HomePage({ params }: HomePageProps) {
  const resolvedParams = await params;

  if (!isLocale(resolvedParams.lang)) {
    notFound();
  }

  const locale = assertLocale(resolvedParams.lang);
  const content = dictionary[locale];

  return (
    <main className="page-shell">
      <section className="hero-frame" id="home">
        <SiteHeader active="home" locale={locale} labels={content.nav} />

        <div className="hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">{content.hero.eyebrow}</p>
            <h1>
              Titanor Group
            </h1>
            <p className="hero-text">{content.hero.description}</p>
            <div className="hero-actions">
              <Link className="button-primary" href={`/${locale}#contact`}>
                {content.hero.primary}
              </Link>
              <Link className="button-secondary" href={`/${locale}/services`}>
                {content.hero.secondary}
              </Link>
            </div>
          </div>

          <div className="hero-visual">
            <div className="hero-image-card">
              <div className="hero-badge">{content.hero.badge}</div>
              <div className="hero-stat hero-stat-top">
                <strong>{content.hero.statTopTitle}</strong>
                <span>{content.hero.statTop}</span>
              </div>
              <div className="hero-stat hero-stat-bottom">
                <strong>{content.hero.statBottomTitle}</strong>
                <span>{content.hero.statBottom}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="benefits-section">
        <div className="section-inner benefits-grid">
          {content.benefits.map((benefit) => (
            <article className="benefit-card" key={benefit.title}>
              <div className="benefit-icon" aria-hidden="true">
                {benefit.icon}
              </div>
              <h2>{benefit.title}</h2>
              <p>{benefit.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="content-section" id="services">
        <div className="section-inner">
          <div className="section-heading">
            <span className="section-kicker">{content.servicesHeading.kicker}</span>
            <h2>{content.servicesHeading.title}</h2>
          </div>

          <ServicesGrid services={content.services} locale={locale} />

          <p className="services-cta-text">
            {content.servicesCta.text}{' '}
            <a href="mailto:projects@titanorgroup.fi">{content.servicesCta.linkLabel}</a>
          </p>
        </div>
      </section>

      <section className="content-section" id="contact">
        <div className="section-inner contact-layout">
          <div className="contact-panel">
            <div className="section-heading left">
              <span className="section-kicker">{content.contactHeading.kicker}</span>
              <h2>{content.contactHeading.title}</h2>
            </div>

            <div className="contact-list">
              {content.contacts.map((item) => (
                <a className="contact-item" href={item.href} key={item.label + item.value}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </a>
              ))}
            </div>

            <div className="business-card">
              <strong>{content.business.company}</strong>
              <span>{content.business.country}</span>
              <span>{content.business.id}</span>
            </div>
          </div>

          <ContactForm form={content.form} locale={locale} titleLevel="h3" />
        </div>
      </section>

    </main>
  );
}
