import { SiteHeader } from '../../components/site-header';
import { ServicesGrid } from '../../components/services-grid';
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

          <ServicesGrid services={content.services} locale={locale} titleTag="h2" />

          <p className="services-cta-text">
            {content.servicesCta.text}{' '}
            <a href="mailto:projects@titanorgroup.fi">{content.servicesCta.linkLabel}</a>
          </p>
        </div>
      </section>
    </main>
  );
}
