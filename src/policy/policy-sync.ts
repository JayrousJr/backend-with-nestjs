import type { Prisma, PrismaClient } from '@db';
import { POLICY_CATALOGUE } from './policy.catalogue';

/** Create missing policy settings; never overwrite administrator changes. */
export async function syncPolicyCatalogue(
  prisma: Pick<PrismaClient, 'policySetting'>,
): Promise<void> {
  for (const [code, def] of Object.entries(POLICY_CATALOGUE)) {
    const parameters =
      'parameters' in def
        ? (def.parameters as Prisma.InputJsonValue)
        : undefined;
    await prisma.policySetting.upsert({
      where: { code },
      update: { category: def.category, description: def.description },
      create: {
        code,
        category: def.category,
        description: def.description,
        enabled: def.enabled,
        parameters,
      },
    });
  }
}
