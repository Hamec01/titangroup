import { SiteHeader } from '../../components/site-header';
import { notFound } from 'next/navigation';
import { assertLocale, dictionary, isLocale } from '../../i18n';

type ContactPageProps = {
  params: Promise<{ lang: string }>;
};

export default async function ContactPage({ params }: ContactPageProps) {
  const resolvedParams = await params;

  if (!isLocale(resolvedParams.lang)) {
    notFound();
  }

  const locale = assertLocale(resolvedParams.lang);
  const content = dictionary[locale];

  return (
    <main className="page-shell">
      <section className="content-section static-page-frame">
        <SiteHeader active="contact" locale={locale} labels={content.nav} />

        <div className="section-inner contact-layout contact-layout-page">
          <div className="contact-panel">
            <div className="section-heading left">
              <span className="section-kicker">{content.contactHeading.kicker}</span>
              <h1 className="static-page-title">{content.contactHeading.title}</h1>
            </div>

            <div className="contact-list">
              {content.contacts.map((item) => (
                <a className="contact-item" href={item.href} key={item.label + item.value}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </a>
              ))}
            </div>
          </div>

          <div className="contact-form">
            <label>
              <span>{content.form.name}</span>
              <input name="name" type="text" placeholder={content.form.name} />
            </label>
            <label>
              <span>{content.form.company}</span>
              <input name="company" type="text" placeholder={content.form.company} />
            </label>
            <label>
              <span>{content.form.email}</span>
              <input name="email" type="email" placeholder={content.form.email} />
            </label>
            <label>
              <span>{content.form.message}</span>
              <textarea name="message" placeholder={content.form.message} />
            </label>
            <button className="button-primary form-button" type="button">
              {content.form.submit}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
