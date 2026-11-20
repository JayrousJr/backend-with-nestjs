import type { PrismaClient } from '@db';
import { PERMISSION_CATALOGUE } from './catalogue';

/**
 * Upsert every catalogue permission; mark permissions that vanished from
 * code inactive (never deleted — existing grants stay readable). Shared by
 * the boot-time sync and the seed/setup scripts.
 */
export async function syncPermissionCatalogue(
  prisma: Pick<PrismaClient, 'permission'>,
): Promise<{ upserted: number; retired: number }> {
  const now = new Date();
  const entries = Object.entries(PERMISSION_CATALOGUE);
  for (const [code, def] of entries) {
    await prisma.permission.upsert({
      where: { code },
      update: {
        module: def.module,
        description: def.description,
        allowedScopes: [...def.scopes],
        isActive: true,
        syncedAt: now,
      },
      create: {
        code,
        module: def.module,
        description: def.description,
        allowedScopes: [...def.scopes],
      },
    });
  }
  const { count } = await prisma.permission.updateMany({
    where: { code: { notIn: entries.map(([c]) => c) }, isActive: true },
    data: { isActive: false },
  });
  return { upserted: entries.length, retired: count };
}
