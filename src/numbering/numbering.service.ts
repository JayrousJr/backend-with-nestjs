import { Injectable } from '@nestjs/common';
import { PrismaService, type DbTx } from '@prisma';

/** Current year in EAT (documents are numbered per AzamTV year). */
function eatYear(): number {
  return Number(
    new Intl.DateTimeFormat('en', {
      timeZone: 'Africa/Dar_es_Salaam',
      year: 'numeric',
    }).format(new Date()),
  );
}

/**
 * Gap-free document numbers (ADJ-2026-0001, tag series…). The counter row
 * is incremented atomically, so concurrent requests never share a number;
 * inside a transaction the number is only used if the transaction commits.
 */
@Injectable()
export class NumberingService {
  constructor(private readonly prisma: PrismaService) {}

  async next(key: string, tx?: DbTx): Promise<number> {
    const db = tx ?? this.prisma.db;
    const rows = await db.$queryRaw<{ value: number }[]>`
      INSERT INTO counters (key, value) VALUES (${key}, 1)
      ON CONFLICT (key) DO UPDATE SET value = counters.value + 1
      RETURNING value`;
    return Number(rows[0].value);
  }

  /** e.g. document('ADJ') → ADJ-2026-0001. */
  async document(prefix: string, tx?: DbTx, digits = 4): Promise<string> {
    const year = eatYear();
    const n = await this.next(`${prefix}-${year}`, tx);
    return `${prefix}-${year}-${String(n).padStart(digits, '0')}`;
  }
}
