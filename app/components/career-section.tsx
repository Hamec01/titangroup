'use client';

import { useEffect, useState } from 'react';
import type { Locale } from '../i18n';
import type { Vacancy } from '../../lib/vacancy-types';

type CareerSectionProps = {
  locale: Locale;
};

const contentByLocale: Record<Locale, {
  kicker: string;
  title: string;
  intro: string;
  introStrong: string;
  contactMail: string;
  openVacanciesTitle: string;
  noVacancies: string;
  formTitle: string;
  name: string;
  email: string;
  phone: string;
  position: string;
  message: string;
  submit: string;
  note: string;
}> = {
  en: {
    kicker: 'Join Titanor Group',
    title: 'Career',
    intro:
      'If you want to become part of our team, we offer a competitive salary, professional growth, and strong project-based work environment in marine and industrial sectors.',
    introStrong: 'Send your application to',
    contactMail: 'info@titanorgroup.fi',
    openVacanciesTitle: 'Open vacancies',
    noVacancies: 'There are no open roles right now. You can still send us your application.',
    formTitle: 'Apply now',
    name: 'Name',
    email: 'Email',
    phone: 'Phone',
    position: 'Position you are applying for',
    message: 'Message / experience summary',
    submit: 'Send application',
    note: 'Please include your preferred start date, location, and relevant marine/industrial experience.'
  },
  fi: {
    kicker: 'Liity Titanor Groupiin',
    title: 'Ura',
    intro:
      'Jos haluat osaksi tiimiamme, tarjoamme kilpailukykyisen palkan, ammatillisen kasvun mahdollisuuksia ja vakaan projektiympariston meri- ja teollisuusalalla.',
    introStrong: 'Laheta hakemus osoitteeseen',
    contactMail: 'info@titanorgroup.fi',
    openVacanciesTitle: 'Avoimet tehtavat',
    noVacancies: 'Avoimia rooleja ei ole juuri nyt. Voit silti lahettaa avoimen hakemuksen.',
    formTitle: 'Jata hakemus',
    name: 'Nimi',
    email: 'Sahkoposti',
    phone: 'Puhelin',
    position: 'Haettava tehtava',
    message: 'Viesti / osaamisen kuvaus',
    submit: 'Laheta hakemus',
    note: 'Kerro toivottu aloitusajankohta, sijainti seka asiaankuuluva meri-/teollisuuskokemus.'
  }
};

export function CareerSection({ locale }: CareerSectionProps) {
  const [vacancies, setVacancies] = useState<Vacancy[]>([]);
  const [loaded, setLoaded] = useState(false);

  const copy = contentByLocale[locale];

  useEffect(() => {
    let isMounted = true;

    const load = async () => {
      try {
        const response = await fetch('/api/vacancies', { cache: 'no-store' });

        if (!response.ok) {
          if (isMounted) {
            setLoaded(true);
          }
          return;
        }

        const payload = (await response.json()) as Vacancy[];
        if (isMounted) {
          setVacancies(payload);
          setLoaded(true);
        }
      } catch {
        if (isMounted) {
          setLoaded(true);
        }
      }
    };

    void load();

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <section className="content-section" id="career">
      <div className="section-inner career-layout">
        <div className="career-panel">
          <div className="section-heading left">
            <span className="section-kicker">{copy.kicker}</span>
            <h2>{copy.title}</h2>
          </div>

          <p className="career-intro">{copy.intro}</p>
          <p className="career-mail-line">
            <strong>{copy.introStrong}</strong>{' '}
            <a href={`mailto:${copy.contactMail}`}>{copy.contactMail}</a>
          </p>

          <div className="career-vacancies">
            <h3>{copy.openVacanciesTitle}</h3>
            {!loaded ? <p>{locale === 'en' ? 'Loading vacancies...' : 'Ladataan tehtavia...'}</p> : null}
            {loaded && vacancies.length === 0 ? <p>{copy.noVacancies}</p> : null}

            <div className="career-vacancy-grid">
              {vacancies.map((vacancy) => (
                <article className="career-vacancy-card" key={vacancy.id}>
                  <h4>{vacancy.role}</h4>
                  <p>{vacancy.description}</p>
                  <ul>
                    <li>{vacancy.location}</li>
                    <li>{vacancy.duration}</li>
                    <li>{vacancy.postedAt}</li>
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </div>

        <form className="career-form" action={`mailto:${copy.contactMail}`} method="post" encType="text/plain">
          <h3 className="form-title">{copy.formTitle}</h3>

          <label>
            <span>{copy.name}</span>
            <input name="name" type="text" placeholder={copy.name} />
          </label>
          <label>
            <span>{copy.email}</span>
            <input name="email" type="email" placeholder={copy.email} />
          </label>
          <label>
            <span>{copy.phone}</span>
            <input name="phone" type="text" placeholder={copy.phone} />
          </label>
          <label>
            <span>{copy.position}</span>
            <input name="position" type="text" placeholder={copy.position} />
          </label>
          <label>
            <span>{copy.message}</span>
            <textarea name="message" placeholder={copy.message} />
          </label>

          <button className="button-primary form-button" type="submit">
            {copy.submit}
          </button>
          <p className="form-note">{copy.note}</p>
        </form>
      </div>
    </section>
  );
}
