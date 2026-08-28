-- Titanor Time — T13.1: seed the profession catalog.
--
-- Pure data (DML), no schema change. Idempotent: every INSERT is ON CONFLICT ("code") DO NOTHING,
-- so reapplying this migration (or a future re-seed) is a no-op after the first run. "updatedAt"
-- is set explicitly (no DB default — Prisma's @updatedAt is application-layer only), same as the
-- qualification catalog seed.
--
-- Two categories. The same display name in each (e.g. "Welder") is a DISTINCT catalog entry with
-- its own code — SHIP_WELDER vs CON_WELDER — per T13 spec §12. Codes are stable: never reuse a
-- retired code for a different profession. Professions are NEVER added automatically from
-- certificates.

INSERT INTO "ProfessionDefinition" ("code", "category", "nameEn", "nameRu", "sortOrder", "updatedAt") VALUES
  -- Shipbuilding
  ('SHIP_WELDER',            'SHIPBUILDING', 'Welder',                       'Сварщик',                              10, CURRENT_TIMESTAMP),
  ('SHIP_PIPE_WELDER',       'SHIPBUILDING', 'Pipe welder',                  'Сварщик труб',                         20, CURRENT_TIMESTAMP),
  ('SHIP_PLATER',            'SHIPBUILDING', 'Plater / Ship fitter',         'Судосборщик',                          30, CURRENT_TIMESTAMP),
  ('SHIP_PIPE_FITTER',       'SHIPBUILDING', 'Pipe fitter',                  'Трубопроводчик',                       40, CURRENT_TIMESTAMP),
  ('SHIP_MECHANICAL_FITTER', 'SHIPBUILDING', 'Mechanical fitter',            'Слесарь-механик',                      50, CURRENT_TIMESTAMP),
  ('SHIP_OUTFITTING_FITTER', 'SHIPBUILDING', 'Outfitting fitter',            'Монтажник насыщения',                  60, CURRENT_TIMESTAMP),
  ('SHIP_INTERIOR_FITTER',   'SHIPBUILDING', 'Interior fitter',              'Монтажник интерьера',                  70, CURRENT_TIMESTAMP),
  ('SHIP_ELECTRICIAN',       'SHIPBUILDING', 'Electrician',                  'Электромонтажник',                     80, CURRENT_TIMESTAMP),
  ('SHIP_HVAC_INSTALLER',    'SHIPBUILDING', 'HVAC / ventilation installer', 'Монтажник вентиляции',                 90, CURRENT_TIMESTAMP),
  ('SHIP_INSULATOR',         'SHIPBUILDING', 'Technical insulator',          'Изолировщик',                         100, CURRENT_TIMESTAMP),
  ('SHIP_PAINTER',           'SHIPBUILDING', 'Industrial painter',           'Промышленный маляр',                  110, CURRENT_TIMESTAMP),
  ('SHIP_SCAFFOLDER',        'SHIPBUILDING', 'Scaffolder',                   'Монтажник лесов',                     120, CURRENT_TIMESTAMP),
  ('SHIP_CNC_OPERATOR',      'SHIPBUILDING', 'CNC / plasma operator',        'Оператор ЧПУ / плазменной резки',     130, CURRENT_TIMESTAMP),
  ('SHIP_CRANE_OPERATOR',    'SHIPBUILDING', 'Crane operator',               'Крановщик',                           140, CURRENT_TIMESTAMP),
  ('SHIP_WAREHOUSE',         'SHIPBUILDING', 'Warehouse worker',             'Кладовщик',                           150, CURRENT_TIMESTAMP),
  ('SHIP_LOGISTICS',         'SHIPBUILDING', 'Logistics worker',             'Работник логистики',                  160, CURRENT_TIMESTAMP),
  ('SHIP_QUALITY_INSPECTOR', 'SHIPBUILDING', 'Quality inspector',            'Контролёр качества',                  170, CURRENT_TIMESTAMP),
  ('SHIP_NDT_INSPECTOR',     'SHIPBUILDING', 'NDT inspector',                'Дефектоскопист (НК)',                 180, CURRENT_TIMESTAMP),
  ('SHIP_FOREMAN',           'SHIPBUILDING', 'Foreman',                      'Бригадир',                            190, CURRENT_TIMESTAMP),
  -- Construction
  ('CON_CONSTRUCTION_WORKER','CONSTRUCTION', 'Construction worker',          'Разнорабочий (строительство)',         10, CURRENT_TIMESTAMP),
  ('CON_CARPENTER',          'CONSTRUCTION', 'Carpenter',                    'Плотник',                              20, CURRENT_TIMESTAMP),
  ('CON_FORMWORK_CARPENTER', 'CONSTRUCTION', 'Formwork carpenter',           'Опалубщик',                            30, CURRENT_TIMESTAMP),
  ('CON_REBAR_WORKER',       'CONSTRUCTION', 'Rebar worker',                 'Арматурщик',                           40, CURRENT_TIMESTAMP),
  ('CON_CONCRETE_WORKER',    'CONSTRUCTION', 'Concrete worker',              'Бетонщик',                             50, CURRENT_TIMESTAMP),
  ('CON_BRICKLAYER',         'CONSTRUCTION', 'Bricklayer',                   'Каменщик',                             60, CURRENT_TIMESTAMP),
  ('CON_PLASTERER',          'CONSTRUCTION', 'Plasterer',                    'Штукатур',                             70, CURRENT_TIMESTAMP),
  ('CON_PAINTER',            'CONSTRUCTION', 'Painter',                      'Маляр',                                80, CURRENT_TIMESTAMP),
  ('CON_TILER',              'CONSTRUCTION', 'Tiler',                        'Плиточник',                            90, CURRENT_TIMESTAMP),
  ('CON_FLOOR_LAYER',        'CONSTRUCTION', 'Floor layer',                  'Укладчик напольных покрытий',         100, CURRENT_TIMESTAMP),
  ('CON_ROOFER',             'CONSTRUCTION', 'Roofer',                       'Кровельщик',                          110, CURRENT_TIMESTAMP),
  ('CON_GLAZIER',            'CONSTRUCTION', 'Glazier',                      'Стекольщик',                          120, CURRENT_TIMESTAMP),
  ('CON_WINDOW_DOOR_FITTER', 'CONSTRUCTION', 'Window and door fitter',       'Монтажник окон и дверей',             130, CURRENT_TIMESTAMP),
  ('CON_ELEMENT_INSTALLER',  'CONSTRUCTION', 'Prefabricated element installer','Монтажник ЖБ-конструкций',          140, CURRENT_TIMESTAMP),
  ('CON_SCAFFOLDER',         'CONSTRUCTION', 'Scaffolder',                   'Монтажник лесов',                     150, CURRENT_TIMESTAMP),
  ('CON_ELECTRICIAN',        'CONSTRUCTION', 'Electrician',                  'Электрик',                            160, CURRENT_TIMESTAMP),
  ('CON_HVAC_INSTALLER',     'CONSTRUCTION', 'HVAC installer',               'Монтажник ОВиК',                      170, CURRENT_TIMESTAMP),
  ('CON_PLUMBER',            'CONSTRUCTION', 'Plumber',                      'Сантехник',                           180, CURRENT_TIMESTAMP),
  ('CON_WELDER',             'CONSTRUCTION', 'Welder',                       'Сварщик',                             190, CURRENT_TIMESTAMP),
  ('CON_INSULATOR',          'CONSTRUCTION', 'Technical insulator',          'Изолировщик',                         200, CURRENT_TIMESTAMP),
  ('CON_EARTHMOVING_WORKER', 'CONSTRUCTION', 'Earthmoving worker',           'Рабочий земляных работ',              210, CURRENT_TIMESTAMP),
  ('CON_EXCAVATOR_OPERATOR', 'CONSTRUCTION', 'Excavator operator',           'Экскаваторщик',                       220, CURRENT_TIMESTAMP),
  ('CON_CRANE_OPERATOR',     'CONSTRUCTION', 'Crane operator',               'Крановщик',                           230, CURRENT_TIMESTAMP),
  ('CON_FOREMAN',            'CONSTRUCTION', 'Foreman',                      'Бригадир',                            240, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
