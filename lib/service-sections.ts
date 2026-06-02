export const serviceSections = [
  'shipbuilding',
  'steelStructures',
  'welding',
  'repair',
  'interior'
] as const;

export type ServiceSection = (typeof serviceSections)[number];
