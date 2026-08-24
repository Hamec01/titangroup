-- Titanor Time — migration: seed qualification catalog + admin notification permissions
--
-- Pure data (DML), no schema change. Idempotent: every INSERT is ON CONFLICT DO NOTHING keyed
-- on the stable unique column (QualificationDefinition.code / Permission.code / the
-- RolePermission pair), so reapplying this migration (or a future re-seed script hitting the
-- same rows) is always a no-op after the first successful run. "updatedAt" is set explicitly
-- (no DB-level default — Prisma's @updatedAt is an application-layer concern only).

-- Safety cards (scope EMPLOYEE, expiryMode REQUIRED — always shown as a matrix indicator)
INSERT INTO "QualificationDefinition"
  ("code", "category", "scope", "nameEn", "nameRu", "descriptionEn", "descriptionRu", "expiryMode", "sortOrder", "updatedAt")
VALUES
  ('OCCUPATIONAL_SAFETY_CARD', 'SAFETY_CARD', 'EMPLOYEE',
    'Occupational Safety Card', 'Карта техники безопасности',
    'Finnish occupational safety card (tyoturvallisuuskortti) confirming completion of workplace safety training.',
    'Карта техники безопасности (tyoturvallisuuskortti), подтверждающая прохождение обучения по охране труда.',
    'REQUIRED', 10, CURRENT_TIMESTAMP),
  ('HOT_WORK_CARD', 'SAFETY_CARD', 'EMPLOYEE',
    'Hot Work Card', 'Карта огневых работ',
    'Hot work card confirming fire-safety training required for welding, cutting and other hot work.',
    'Карта огневых работ, подтверждающая обучение пожарной безопасности для сварочных и других огневых работ.',
    'REQUIRED', 20, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Welder performance qualifications (scope EMPLOYEE, expiryMode REQUIRED — periodic revalidation)
INSERT INTO "QualificationDefinition"
  ("code", "category", "scope", "nameEn", "nameRu", "descriptionEn", "descriptionRu", "expiryMode", "sortOrder", "updatedAt")
VALUES
  ('EN_ISO_9606_1', 'WELDING_PERFORMANCE', 'EMPLOYEE',
    'EN ISO 9606-1', 'EN ISO 9606-1',
    'Welder qualification test - steels (EN ISO 9606-1).',
    'Аттестация сварщика - стали (EN ISO 9606-1).',
    'REQUIRED', 110, CURRENT_TIMESTAMP),
  ('EN_ISO_9606_2', 'WELDING_PERFORMANCE', 'EMPLOYEE',
    'EN ISO 9606-2', 'EN ISO 9606-2',
    'Welder qualification test - aluminium and aluminium alloys (EN ISO 9606-2).',
    'Аттестация сварщика - алюминий и его сплавы (EN ISO 9606-2).',
    'REQUIRED', 120, CURRENT_TIMESTAMP),
  ('EN_ISO_9606_3', 'WELDING_PERFORMANCE', 'EMPLOYEE',
    'EN ISO 9606-3', 'EN ISO 9606-3',
    'Welder qualification test - copper and copper alloys (EN ISO 9606-3).',
    'Аттестация сварщика - медь и её сплавы (EN ISO 9606-3).',
    'REQUIRED', 130, CURRENT_TIMESTAMP),
  ('EN_ISO_9606_4', 'WELDING_PERFORMANCE', 'EMPLOYEE',
    'EN ISO 9606-4', 'EN ISO 9606-4',
    'Welder qualification test - nickel and nickel alloys (EN ISO 9606-4).',
    'Аттестация сварщика - никель и его сплавы (EN ISO 9606-4).',
    'REQUIRED', 140, CURRENT_TIMESTAMP),
  ('EN_ISO_9606_5', 'WELDING_PERFORMANCE', 'EMPLOYEE',
    'EN ISO 9606-5', 'EN ISO 9606-5',
    'Welder qualification test - titanium, zirconium and their alloys (EN ISO 9606-5).',
    'Аттестация сварщика - титан, цирконий и их сплавы (EN ISO 9606-5).',
    'REQUIRED', 150, CURRENT_TIMESTAMP),
  ('EN_ISO_14732', 'WELDING_PERFORMANCE', 'EMPLOYEE',
    'EN ISO 14732', 'EN ISO 14732',
    'Qualification of welding operators and weld setters for mechanised and automatic welding (EN ISO 14732).',
    'Аттестация сварочных операторов и наладчиков для механизированной и автоматической сварки (EN ISO 14732).',
    'REQUIRED', 160, CURRENT_TIMESTAMP),
  ('EN_ISO_13585', 'WELDING_PERFORMANCE', 'EMPLOYEE',
    'EN ISO 13585', 'EN ISO 13585',
    'Brazer and brazing operator approval testing (EN ISO 13585).',
    'Аттестация паяльщиков и операторов пайки (EN ISO 13585).',
    'REQUIRED', 170, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- IIW / EWF personnel qualifications (scope EMPLOYEE, expiryMode OPTIONAL — diploma-style,
-- revalidation dates vary by scheme and are not always tracked)
INSERT INTO "QualificationDefinition"
  ("code", "category", "scope", "nameEn", "nameRu", "descriptionEn", "descriptionRu", "expiryMode", "sortOrder", "updatedAt")
VALUES
  ('IWE_EWE', 'WELDING_PERSONNEL', 'EMPLOYEE',
    'IWE / EWE', 'IWE / EWE',
    'International/European Welding Engineer personnel qualification.',
    'Международный/Европейский инженер-сварщик (IWE/EWE).',
    'OPTIONAL', 210, CURRENT_TIMESTAMP),
  ('IWT_EWT', 'WELDING_PERSONNEL', 'EMPLOYEE',
    'IWT / EWT', 'IWT / EWT',
    'International/European Welding Technologist personnel qualification.',
    'Международный/Европейский технолог сварочного производства (IWT/EWT).',
    'OPTIONAL', 220, CURRENT_TIMESTAMP),
  ('IWS_EWS', 'WELDING_PERSONNEL', 'EMPLOYEE',
    'IWS / EWS', 'IWS / EWS',
    'International/European Welding Specialist personnel qualification.',
    'Международный/Европейский специалист по сварке (IWS/EWS).',
    'OPTIONAL', 230, CURRENT_TIMESTAMP),
  ('IWP_EWP', 'WELDING_PERSONNEL', 'EMPLOYEE',
    'IWP / EWP', 'IWP / EWP',
    'International/European Welding Practitioner personnel qualification.',
    'Международный/Европейский практик сварочного производства (IWP/EWP).',
    'OPTIONAL', 240, CURRENT_TIMESTAMP),
  ('IWIP_EWIP', 'WELDING_PERSONNEL', 'EMPLOYEE',
    'IWIP / EWIP', 'IWIP / EWIP',
    'International/European Welding Inspection Personnel qualification.',
    'Международный/Европейский персонал по контролю сварных соединений (IWIP/EWIP).',
    'OPTIONAL', 250, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Industry references (scope COMPANY_REFERENCE per task spec — never a personal employee
-- certificate by default; expiryMode NONE, these are regulatory/standard references, not
-- individually-expiring personal credentials in this slice)
INSERT INTO "QualificationDefinition"
  ("code", "category", "scope", "nameEn", "nameRu", "descriptionEn", "descriptionRu", "expiryMode", "sortOrder", "updatedAt")
VALUES
  ('PED_2014_68_EU', 'INDUSTRY_REFERENCE', 'COMPANY_REFERENCE',
    'PED 2014/68/EU', 'PED 2014/68/EU',
    'EU Pressure Equipment Directive 2014/68/EU - company-level regulatory reference.',
    'Директива ЕС по оборудованию, работающему под давлением 2014/68/EU - справочный стандарт компании.',
    'NONE', 310, CURRENT_TIMESTAMP),
  ('EN_15085', 'INDUSTRY_REFERENCE', 'COMPANY_REFERENCE',
    'EN 15085', 'EN 15085',
    'EN 15085 - welding of railway vehicles and components, company certification reference.',
    'EN 15085 - сварка железнодорожных транспортных средств и компонентов, справочный стандарт компании.',
    'NONE', 320, CURRENT_TIMESTAMP),
  ('EN_1090', 'INDUSTRY_REFERENCE', 'COMPANY_REFERENCE',
    'EN 1090', 'EN 1090',
    'EN 1090 - execution of steel and aluminium structures, company certification reference.',
    'EN 1090 - изготовление стальных и алюминиевых конструкций, справочный стандарт компании.',
    'NONE', 330, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Company reference (scope COMPANY_REFERENCE mandatory per task spec)
INSERT INTO "QualificationDefinition"
  ("code", "category", "scope", "nameEn", "nameRu", "descriptionEn", "descriptionRu", "expiryMode", "sortOrder", "updatedAt")
VALUES
  ('EN_ISO_3834', 'COMPANY_REFERENCE', 'COMPANY_REFERENCE',
    'EN ISO 3834', 'EN ISO 3834',
    'EN ISO 3834 - quality requirements for fusion welding of metallic materials, company certification reference.',
    'EN ISO 3834 - требования к качеству сварки плавлением металлических материалов, справочный стандарт компании.',
    'NONE', 410, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Admin Notification Center permissions (ADMIN + SUPER_ADMIN only; WORKER/FOREMAN never get these)
INSERT INTO "Permission" ("code", "description") VALUES
  ('admin.notification.read', 'Read the admin notification center (drawer/badge) - docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN'),
  ('admin.notification.dismiss', 'Dismiss a notification for the acting admin only (per-user dismissal, never affects other admins) - held by ADMIN and SUPER_ADMIN')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code IN ('admin.notification.read', 'admin.notification.dismiss')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
