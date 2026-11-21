import { Prisma } from '@db';
import { decryptSecret, encryptSecret } from '../auth/totp';

export const D = (v: Prisma.Decimal | number | string | null | undefined) =>
  v == null ? 0 : Number(v);

/** Amounts are VAT-inclusive; VAT shown separately (requirements §4.4). */
export const vatParts = (inclVat: number, ratePct: number) => {
  const excl = inclVat / (1 + ratePct / 100);
  return {
    excl: Math.round(excl * 100) / 100,
    vat: Math.round((inclVat - excl) * 100) / 100,
  };
};

export const round2 = (n: number) => Math.round(n * 100) / 100;

export const day = (s?: string | null) =>
  s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null;

export interface SealedLine {
  tenderLineId: number;
  unitPrice: number;
  deliveryDays: number;
  brand?: string | null;
  model?: string | null;
  countryOfOrigin?: string | null;
  compliance: { specId: number; complies: boolean; offered?: string | null }[];
  fileIds: number[];
}

/** Sealed bids: AES-256-GCM with the bid seal key until the opening. */
export const seal = (lines: SealedLine[], key: string) =>
  encryptSecret(JSON.stringify(lines), key);
export const unseal = (sealed: string | null, key: string): SealedLine[] =>
  sealed ? (JSON.parse(decryptSecret(sealed, key)) as SealedLine[]) : [];

export const fullName = (e: { firstName: string; lastName: string }) =>
  `${e.firstName} ${e.lastName}`;

/** A spec as text, e.g. "RAM ≥ 16 GB". */
export const specText = (s: {
  attribute: string;
  rule: string;
  value: string;
  valueMax: string | null;
  unit: string | null;
}) => {
  const u = s.unit ? ` ${s.unit}` : '';
  switch (s.rule) {
    case 'MIN':
      return `${s.attribute} ≥ ${s.value}${u}`;
    case 'MAX':
      return `${s.attribute} ≤ ${s.value}${u}`;
    case 'RANGE':
      return `${s.attribute} ${s.value}–${s.valueMax ?? ''}${u}`;
    case 'ONE_OF':
      return `${s.attribute}: one of ${s.value}`;
    case 'TEXT':
      return `${s.attribute}: ${s.value}`;
    default:
      return `${s.attribute} = ${s.value}${u}`;
  }
};
