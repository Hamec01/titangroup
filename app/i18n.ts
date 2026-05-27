export const locales = ['fi', 'en', 'ru'] as const;

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
      badge: 'Finland / Europe',
      statTopTitle: 'B2B',
      statBottomTitle: 'Steel. Welding. Repair.',
      statTop: 'marine and industrial focus',
      statBottom: 'Structured delivery for demanding shipyard work'
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
      { label: 'Location', value: 'Finland / Europe', href: '#' }
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
      cta: 'Ota yhteytta'
    },
    hero: {
      eyebrow: 'Laivanrakennus, terasrakenteet ja meritekniikka',
      description:
        'Luotettavat ratkaisut laivanrakennukseen, alusten korjaukseen, terasrakenteisiin ja teollisiin meriprojekteihin.',
      primary: 'Ota yhteytta',
      secondary: 'Palvelumme',
      badge: 'Suomi / Eurooppa',
      statTopTitle: 'B2B',
      statBottomTitle: 'Teras. Hitsaus. Korjaus.',
      statTop: 'meri- ja teollisuusfokus',
      statBottom: 'Jasennelty toteutus vaativiin telakkatoihin'
    },
    benefits: [
      {
        title: 'Kokemus',
        text: 'Pitka kokemus laivanrakennuksesta ja teollisesta tuotannosta.',
        icon: '⚒'
      },
      {
        title: 'Laatu',
        text: 'Korkeat laatustandardit ja tarkkuus jokaisessa vaiheessa.',
        icon: '◎'
      },
      {
        title: 'Luotettavuus',
        text: 'Aikataulujen noudattaminen ja yksilollinen lahestymistapa jokaiseen projektiin.',
        icon: '⬡'
      },
      {
        title: 'Turvallisuus',
        text: 'Turvallisuusvaatimusten ja kansainvalisten standardien tarkka noudattaminen.',
        icon: '◌'
      },
      {
        title: 'Kansainvalinen toimintatapa',
        text: 'Toimimme asiakkaiden kanssa koko Euroopassa ja sen ulkopuolella.',
        icon: '◍'
      }
    ],
    servicesHeading: {
      kicker: 'Laivanrakennuksen ja meriteollisuuden ratkaisut',
      title: 'Palvelut'
    },
    servicesCta: {
      text: 'Tarvitsetko tukea laivanrakennus- tai terasrakenneprojektiin?',
      linkLabel: 'Ota yhteytta: projects@titanorgroup.fi'
    },
    services: [
      {
        number: '01',
        title: 'Laivanrakennus',
        text: 'Rakennus, kokoonpano ja osallistuminen laivanrakennusprojekteihin.',
        image: serviceImages[0]
      },
      {
        number: '02',
        title: 'Terasrakenteet',
        text: 'Metallirakenteiden valmistus ja asennus meri- ja teollisuusalalle.',
        image: serviceImages[1]
      },
      {
        number: '03',
        title: 'Hitsaus ja kokoonpano',
        text: 'Hitsaus-, asennus- ja esivalmistelutyot.',
        image: serviceImages[2]
      },
      {
        number: '04',
        title: 'Aluskorjaus',
        text: 'Alusosien korjaus, huolto ja kunnostus.',
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
      { label: 'Sahkoposti', value: 'info@titanorgroup.fi', href: 'mailto:info@titanorgroup.fi' },
      {
        label: 'Projektit',
        value: 'projects@titanorgroup.fi',
        href: 'mailto:projects@titanorgroup.fi'
      },
      {
        label: 'Toimisto',
        value: 'office@titanorgroup.fi',
        href: 'mailto:office@titanorgroup.fi'
      },
      { label: 'Puhelin', value: '+358 46 943 1354', href: 'tel:+358469431354' },
      { label: 'Sijainti', value: 'Suomi / Eurooppa', href: '#' }
    ],
    form: {
      title: 'Laheta meille projektikysely',
      subtitle: 'Kuvaile projekti, sijainti, aikataulu ja tarvittava palvelu.',
      checklistTitle: 'Yhteydenotossa kerro mielellaan:',
      checklist: ['Projektin tyyppi', 'Sijainti', 'Tarvittava palvelu', 'Toivottu aikataulu'],
      name: 'Nimi',
      company: 'Yritys',
      email: 'Sahkoposti',
      message: 'Viesti',
      submit: 'Laheta projektikysely',
      note: 'Projektipyynnoissa mainitse aluksen tyyppi, sijainti, tavoiteaikataulu ja tyon laajuus.'
    },
    business: {
      company: 'Titanor Group Oy',
      country: 'Suomi',
      id: 'Y-tunnus: 3541307-5'
    }
  },
  ru: {
    langLabel: 'Русский',
    nav: {
      home: 'Главная',
      services: 'Услуги',
      contact: 'Контакты',
      cta: 'Связаться'
    },
    hero: {
      eyebrow: 'Судостроение, металлоконструкции и морская инженерия',
      description:
        'Надежные решения для судостроения, ремонта судов, металлоконструкций и промышленных морских проектов.',
      primary: 'Связаться',
      secondary: 'Наши услуги',
      badge: 'Финляндия / Европа',
      statTopTitle: 'B2B',
      statBottomTitle: 'Сталь. Сварка. Ремонт.',
      statTop: 'фокус на морских и промышленных проектах',
      statBottom: 'Структурированная реализация сложных задач верфи'
    },
    benefits: [
      {
        title: 'Опыт',
        text: 'Многолетний опыт в судостроении и промышленном производстве.',
        icon: '⚒'
      },
      {
        title: 'Качество',
        text: 'Высокие стандарты качества и точность на каждом этапе работ.',
        icon: '◎'
      },
      {
        title: 'Надежность',
        text: 'Соблюдение сроков и индивидуальный подход к каждому проекту.',
        icon: '⬡'
      },
      {
        title: 'Безопасность',
        text: 'Строгое соблюдение норм безопасности и международных стандартов.',
        icon: '◌'
      },
      {
        title: 'Международный подход',
        text: 'Работаем с клиентами по всей Европе и за ее пределами.',
        icon: '◍'
      }
    ],
    servicesHeading: {
      kicker: 'Решения для судостроения и морской индустрии',
      title: 'Услуги'
    },
    servicesCta: {
      text: 'Нужна поддержка по судостроительному проекту или металлоконструкциям?',
      linkLabel: 'Свяжитесь: projects@titanorgroup.fi'
    },
    services: [
      {
        number: '01',
          title: 'Судостроение',
        text: 'Строительство, сборка и участие в судостроительных проектах.',
        image: serviceImages[0]
      },
      {
        number: '02',
          title: 'Металлоконструкции',
        text: 'Изготовление и монтаж металлических конструкций для морской и промышленной отрасли.',
        image: serviceImages[1]
      },
      {
        number: '03',
          title: 'Сварка и сборка',
        text: 'Сварочные, монтажные и подготовительные работы.',
        image: serviceImages[2]
      },
      {
        number: '04',
          title: 'Ремонт судов',
        text: 'Ремонт, обслуживание и восстановление судовых элементов.',
        image: serviceImages[3]
      },
      {
        number: '05',
          title: 'Техническая поддержка',
        text: 'Помощь в реализации проектов, документации и технической координации.',
        image: serviceImages[4]
      }
    ],
    contactHeading: {
      kicker: 'TITANORGROUP',
      title: 'Контакты'
    },
    contacts: [
      { label: 'Эл. почта', value: 'info@titanorgroup.fi', href: 'mailto:info@titanorgroup.fi' },
      {
        label: 'Проекты',
        value: 'projects@titanorgroup.fi',
        href: 'mailto:projects@titanorgroup.fi'
      },
      {
        label: 'Офис',
        value: 'office@titanorgroup.fi',
        href: 'mailto:office@titanorgroup.fi'
      },
      { label: 'Телефон', value: '+358 46 943 1354', href: 'tel:+358469431354' },
      { label: 'Локация', value: 'Финляндия / Европа', href: '#' }
    ],
    form: {
      title: 'Отправьте нам проектный запрос',
      subtitle: 'Расскажите о проекте, локации, сроках и нужной услуге.',
      checklistTitle: 'При обращении укажите:',
      checklist: ['Тип проекта', 'Локация', 'Нужная услуга', 'Желаемые сроки'],
      name: 'Имя',
      company: 'Компания',
      email: 'Email',
      message: 'Сообщение',
      submit: 'Отправить проектный запрос',
      note: 'Для проектных запросов укажите тип судна, локацию, ожидаемые сроки и объем работ.'
    },
    business: {
      company: 'Titanor Group Oy',
      country: 'Финляндия',
      id: 'Y-tunnus: 3541307-5'
    }
  }
};