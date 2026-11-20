/**
 * Product categories (tender spec §5.4) with a starter receiving-criteria
 * library. AzamTV supplies the real criteria as setup data; these are
 * editable defaults.
 */
const GENERAL = [
  'Quantity matches the LPO and the delivery note',
  'No visible physical damage; packaging intact',
  'Brand / model match the specification',
];
const ASSET = [
  ...GENERAL,
  'Serial number present and recorded',
  'Powers on and passes a functional test',
  'Accessories and manuals as specified are included',
];

export const SEED_CATEGORIES: {
  code: string;
  name: string;
  tagPrefix: string;
  criteria: string[];
}[] = [
  { code: 'CAM', name: 'Cameras & Lenses', tagPrefix: 'CAM', criteria: ASSET },
  { code: 'AUD', name: 'Audio', tagPrefix: 'AUD', criteria: ASSET },
  { code: 'LGT', name: 'Lighting', tagPrefix: 'LGT', criteria: ASSET },
  {
    code: 'TXOB',
    name: 'Transmission & OB',
    tagPrefix: 'TXB',
    criteria: ASSET,
  },
  { code: 'ICT', name: 'IT & Networking', tagPrefix: 'ICT', criteria: ASSET },
  {
    code: 'CBL',
    name: 'Cables & Accessories',
    tagPrefix: 'CBL',
    criteria: [...GENERAL, 'Connectors and length as specified'],
  },
  {
    code: 'VEH',
    name: 'Vehicles & Spares',
    tagPrefix: 'VEH',
    criteria: [
      ...GENERAL,
      'Registration, chassis and engine numbers match the documents',
      'Insurance and road licence documents handed over',
    ],
  },
  { code: 'FUR', name: 'Furniture', tagPrefix: 'FUR', criteria: GENERAL },
  { code: 'STA', name: 'Stationery', tagPrefix: 'STA', criteria: GENERAL },
  {
    code: 'CNS',
    name: 'Consumables',
    tagPrefix: 'CNS',
    criteria: [...GENERAL, 'Expiry date at least 6 months away (where marked)'],
  },
];
