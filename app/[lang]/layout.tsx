import { notFound } from 'next/navigation';
import { isLocale, locales } from '../i18n';
import { HtmlLang } from './html-lang';

export function generateStaticParams() {
  return locales.map((lang) => ({ lang }));
}

type LangLayoutProps = {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
};

export default async function LangLayout({ children, params }: LangLayoutProps) {
  const { lang } = await params;

  if (!isLocale(lang)) {
    notFound();
  }

  return (
    <>
      <HtmlLang lang={lang} />
      {children}
    </>
  );
}
