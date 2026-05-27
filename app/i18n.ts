export const locales = ['fi', 'en'] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

export function isLocale(value: string): value is Locale {
  return locales.includes(value as Locale);
}

export function assertLocale(value: string): Locale {
  if (!isLocale(value)) {
    throw new Error(`Unsupported locale: ${value}`);
  }

  return value;
}

type Dictionary = {
  langLabel: string;
  nav: {
    home: string;
    services: string;
    contact: string;
    cta: string;
  };
  hero: {
    eyebrow: string;
    description: string;
    primary: string;
    secondary: string;
    badge: string;
    statTopTitle: string;
    statBottomTitle: string;
    statTop: string;
    statBottom: string;
  };
  benefits: Array<{
    title: string;
    text: string;
    icon: string;
  }>;
  servicesHeading: {
    kicker: string;
    title: string;
  };
  servicesCta: {
    text: string;
    linkLabel: string;
  };
  services: Array<{
    number: string;
    title: string;
    text: string;
    image: string;
  }>;
  contactHeading: {
    kicker: string;
    title: string;
  };
  contacts: Array<{
    label: string;
    value: string;
    href: string;
  }>;
  form: {
    title: string;
    subtitle: string;
    checklistTitle: string;
    checklist: string[];
    name: string;
    company: string;
    email: string;
    message: string;
    submit: string;
    note: string;
  };
  business: {
    company: string;
    country: string;
    id: string;
  };
};

const serviceImages = [
  'https://images.unsplash.com/photo-1518623489648-a173ef7824f3?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1504307651254-35680f356dfd?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1517048676732-d65bc937f952?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1500375592092-40eb2168fd21?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1494412651409-8963ce7935a7?auto=format&fit=crop&w=900&q=80'
];

export const dictionary: Record<Locale, Dictionary> = {
  en: {
    langLabel: 'English',
    nav: {
      home: 'Home',
      services: 'Services',
      contact: 'Contact',
      cta: 'Contact us'
    },
    hero: {
      eyebrow: 'Shipbuilding, steel structures and marine engineering',
      description:
        'Reliable solutions for shipbuilding, vessel repair, steel structures and industrial marine projects.',
      primary: 'Contact us',
      secondary: 'Our services',
      badge: 'Finland / EU',
      statTopTitle: 'B2B',
      statBottomTitle: 'Steel. Welding. Repair.',
      statTop: 'marine and industrial focus',
      statBottom: 'Structured delivery for demanding shipyard work.'
    },
    benefits: [
      {
        title: 'Experience',
        text: 'Many years of experience in shipbuilding and industrial production.',
        icon: '⚒'
      },
      {
        title: 'Quality',
        text: 'High quality standards and precision at every stage of the work.',
        icon: '◎'
      },
      {
        title: 'Reliability',
        text: 'On-time delivery and an individual approach to every project.',
        icon: '⬡'
      },
      {
        title: 'Safety',
        text: 'Strict compliance with safety rules and international standards.',
        icon: '◌'
      },
      {
        title: 'International approach',
        text: 'Working with clients across Europe and beyond.',
        icon: '◍'
      }
    ],
    servicesHeading: {
      kicker: 'Shipbuilding & marine industry solutions',
      title: 'Services'
    },
    servicesCta: {
      text: 'Need support for a shipbuilding or steel structure project?',
      linkLabel: 'Contact us at projects@titanorgroup.fi'
    },
    services: [
      {
        number: '01',
        title: 'Shipbuilding',
        text: 'Construction, assembly and participation in shipbuilding projects.',
        image: serviceImages[0]
      },
      {
        number: '02',
        title: 'Steel Structures',
        text: 'Manufacturing and installation of metal structures for marine and industrial sectors.',
        image: serviceImages[1]
      },
      {
        number: '03',
        title: 'Welding & Assembly',
        text: 'Welding, assembly and preparatory works.',
        image: serviceImages[2]
      },
      {
        number: '04',
        title: 'Ship Repair',
        text: 'Repair, maintenance and restoration of vessel elements.',
        image: serviceImages[3]
      },
      {
        number: '05',
        title: 'Technical Support',
        text: 'Support in project delivery, documentation and technical coordination.',
        image: serviceImages[4]
      }
    ],
    contactHeading: {
      kicker: 'TITANORGROUP',
      title: 'Contact'
    },
    contacts: [
      { label: 'Email', value: 'info@titanorgroup.fi', href: 'mailto:info@titanorgroup.fi' },
      {
        label: 'Projects',
        value: 'projects@titanorgroup.fi',
        href: 'mailto:projects@titanorgroup.fi'
      },
      {
        label: 'Office',
        value: 'office@titanorgroup.fi',
        href: 'mailto:office@titanorgroup.fi'
      },
      { label: 'Phone', value: '+358 46 943 1354', href: 'tel:+358469431354' },
      { label: 'Location', value: 'Finland / EU', href: '#' }
    ],
    form: {
      title: 'Send us a project inquiry',
      subtitle: 'Tell us about your project, location, schedule and required service.',
      checklistTitle: 'When contacting us, please include:',
      checklist: ['Project type', 'Location', 'Required service', 'Preferred schedule'],
      name: 'Name',
      company: 'Company',
      email: 'Email',
      message: 'Message',
      submit: 'Send project inquiry',
      note: 'For project requests, please include vessel type, location, expected schedule and scope of work.'
    },
    business: {
      company: 'Titanor Group Oy',
      country: 'Finland',
      id: 'Y-tunnus: 3541307-5'
    }
  },
  fi: {
    langLabel: 'Suomi',
    nav: {
      home: 'Etusivu',
      services: 'Palvelut',
      contact: 'Yhteystiedot',
      cta: 'Ota yhteyttä'
    },
    hero: {
      eyebrow: 'Laivanrakennus, teräsrakenteet ja meritekniset palvelut',
      description:
        'Luotettavat ratkaisut laivanrakennukseen, alusten korjaukseen, teräsrakenteisiin ja teollisiin meriprojekteihin.',
      primary: 'Ota yhteyttä',
      secondary: 'Palvelumme',
      badge: 'Suomi / EU',
      statTopTitle: 'B2B',
      statBottomTitle: 'Teräs. Hitsaus. Korjaus.',
      statTop: 'fokus meri- ja teollisuushankkeissa',
      statBottom: 'Jäsennelty toteutus vaativiin telakkaprojekteihin.'
    },
    benefits: [
      {
        title: 'Kokemus',
        text: 'Pitkä kokemus laivanrakennuksesta ja teollisesta tuotannosta.',
        icon: '⚒'
      },
      {
        title: 'Laatu',
        text: 'Korkeat laatustandardit ja tarkkuus työn jokaisessa vaiheessa.',
        icon: '◎'
      },
      {
        title: 'Luotettavuus',
        text: 'Aikataulujen pitävyys ja yksilöllinen lähestymistapa jokaiseen projektiin.',
        icon: '⬡'
      },
      {
        title: 'Turvallisuus',
        text: 'Turvallisuusvaatimusten ja kansainvälisten standardien tarkka noudattaminen.',
        icon: '◌'
      },
      {
        title: 'Kansainvälinen toimintatapa',
        text: 'Toimimme asiakkaiden kanssa kaikkialla Euroopassa ja sen ulkopuolella.',
        icon: '◍'
      }
    ],
    servicesHeading: {
      kicker: 'Ratkaisut laivanrakennukseen ja meriteollisuuteen',
      title: 'Palvelut'
    },
    servicesCta: {
      text: 'Tarvitsetko tukea laivanrakennus- tai teräsrakenneprojektiin?',
      linkLabel: 'Ota yhteyttä: projects@titanorgroup.fi'
    },
    services: [
      {
        number: '01',
        title: 'Laivanrakennus',
        text: 'Rakentaminen, kokoonpano ja osallistuminen laivanrakennusprojekteihin.',
        image: serviceImages[0]
      },
      {
        number: '02',
        title: 'Teräsrakenteet',
        text: 'Metallirakenteiden valmistus ja asennus meri- ja teollisuusalalle.',
        image: serviceImages[1]
      },
      {
        number: '03',
        title: 'Hitsaus ja kokoonpano',
        text: 'Hitsaus-, asennus- ja esivalmistelutyöt.',
        image: serviceImages[2]
      },
      {
        number: '04',
        title: 'Aluskorjaus',
        text: 'Aluksen osien korjaus, huolto ja kunnostus.',
        image: serviceImages[3]
      },
      {
        number: '05',
        title: 'Tekninen tuki',
        text: 'Tukea projektien toteutukseen, dokumentointiin ja tekniseen koordinointiin.',
        image: serviceImages[4]
      }
    ],
    contactHeading: {
      kicker: 'TITANORGROUP',
      title: 'Yhteystiedot'
    },
    contacts: [
      { label: 'Yleiset tiedustelut', value: 'info@titanorgroup.fi', href: 'mailto:info@titanorgroup.fi' },
      {
        label: 'Projektit ja tarjoukset',
        value: 'projects@titanorgroup.fi',
        href: 'mailto:projects@titanorgroup.fi'
      },
      {
        label: 'Toimisto',
        value: 'office@titanorgroup.fi',
        href: 'mailto:office@titanorgroup.fi'
      },
      { label: 'Puhelin', value: '+358 46 943 1354', href: 'tel:+358469431354' },
      { label: 'Sijainti', value: 'Suomi / EU', href: '#' }
    ],
    form: {
      title: 'Lähetä meille projektikysely',
      subtitle: 'Kuvaile projektisi, sijainti, aikataulu ja tarvittava palvelu.',
      checklistTitle: 'Yhteydenotossa kerro mielellään:',
      checklist: ['Projektin tyyppi', 'Sijainti', 'Tarvittava palvelu', 'Toivottu aikataulu'],
      name: 'Nimi',
      company: 'Yritys',
      email: 'Sähköposti',
      message: 'Viesti',
      submit: 'Lähetä projektikysely',
      note: 'Projektipyynnöissä mainitse aluksen tyyppi, sijainti, tavoiteaikataulu ja työn laajuus.'
    },
    business: {
      company: 'Titanor Group Oy',
      country: 'Suomi',
      id: 'Y-tunnus: 3541307-5'
    }
  }
};