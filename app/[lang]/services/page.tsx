import { SiteHeader } from '../../components/site-header';
import { notFound } from 'next/navigation';
import { assertLocale, dictionary, isLocale } from '../../i18n';

type ServicesPageProps = {
  params: Promise<{ lang: string }>;
};

export default async function ServicesPage({ params }: ServicesPageProps) {
  const resolvedParams = await params;

  if (!isLocale(resolvedParams.lang)) {
    notFound();
  }

  const locale = assertLocale(resolvedParams.lang);
  const content = dictionary[locale];

  return (
    <main className="page-shell">
      <section className="content-section static-page-frame">
        <SiteHeader active="services" locale={locale} labels={content.nav} />

        <div className="section-inner">
          <div className="section-heading">
            <span className="section-kicker">{content.servicesHeading.kicker}</span>
            <h1 className="static-page-title">{content.servicesHeading.title}</h1>
          </div>

          <div className="services-grid">
            {content.services.map((service) => (
              <article className="service-card" key={service.title}>
                <div
                  className="service-image"
                  style={{
                    backgroundImage: `linear-gradient(180deg, rgba(5, 7, 11, 0.06), rgba(5, 7, 11, 0.5)), url(${service.image})`
                  }}
                />
                <div className="service-content">
                  <span className="service-number">{service.number}</span>
                  <h2>{service.title}</h2>
                  <p>{service.text}</p>
                </div>
              </article>
            ))}
          </div>

          <p className="services-cta-text">
            {content.servicesCta.text}{' '}
            <a href="mailto:projects@titanorgroup.fi">{content.servicesCta.linkLabel}</a>
          </p>
        </div>
      </section>
    </main>
  );
}
