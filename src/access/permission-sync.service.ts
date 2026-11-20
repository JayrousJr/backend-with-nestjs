import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '@prisma';
import { syncPermissionCatalogue } from './permission-sync';

/** Synchronises the code catalogue into the `permissions` table at boot. */
@Injectable()
export class PermissionSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PermissionSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    const { upserted, retired } = await syncPermissionCatalogue(
      this.prisma.dbRaw,
    );
    this.logger.log(
      `Permission catalogue synced: ${upserted} active, ${retired} retired`,
    );
  }
}
