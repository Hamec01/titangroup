import { notFound } from 'next/navigation';
import { CareerSection } from '../../components/career-section';
import { SiteHeader } from '../../components/site-header';
import { assertLocale, dictionary, isLocale } from '../../i18n';

type CareerPageProps = {
  params: Promise<{ lang: string }>;
};

export default async function CareerPage({ params }: CareerPageProps) {
  const resolvedParams = await params;

  if (!isLocale(resolvedParams.lang)) {
    notFound();
  }

  const locale = assertLocale(resolvedParams.lang);
  const content = dictionary[locale];

  return (
    <main className="page-shell">
      <section className="content-section static-page-frame">
        <SiteHeader active="career" locale={locale} labels={content.nav} />
        <CareerSection locale={locale} standalone />
      </section>
    </main>
  );
}
