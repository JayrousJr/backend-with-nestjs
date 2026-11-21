export { PrismaService } from './prisma.service';
export { PrismaModule } from './prisma.module';
export type { ExtendedPrismaClient } from './extensions/base-model.extension';
import type { Prisma } from '@db';
import type { ExtendedPrismaClient } from './extensions/base-model.extension';

/**
 * A transaction client from either the extended client (`prisma.db`) or the
 * raw one (`prisma.dbRaw`). Services take this so helpers work in both.
 */
export type DbTx =
  | Prisma.TransactionClient
  | Omit<
      ExtendedPrismaClient,
      '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
    >;

/**
 * OR of alternative filters where `{}` means "everything". Prisma drops an
 * empty object inside OR (it would otherwise match nothing), so a `{}`
 * alternative must make the whole condition `{}`.
 */
export function anyOf<W extends object>(
  parts: W[],
): W | { OR: W[] } | Record<string, never> {
  if (parts.some((p) => Object.keys(p).length === 0)) return {};
  return { OR: parts };
}
