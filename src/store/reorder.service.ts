import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '@prisma';
import { NotificationsService } from '../notifications/notifications.service';
import { DepartmentsService } from '../org/departments.service';

/** Emitted when available stock reaches the reorder level (B2 §7, §13). */
export const REORDER_LEVEL_REACHED = 'stock.reorder_level_reached';

export type StockKey = { storeId: number; productId: number };

/**
 * Reorder alerts (B2 §7): when available stock reaches the reorder level,
 * the owning department's HOD is notified with a suggested quantity (up to
 * the maximum). For a sub-store the first suggestion is a transfer from the
 * main store. One alert per dip: cleared when stock rises above the level.
 * Services call `check()` after their transaction commits.
 */
@Injectable()
export class ReorderService {
  private readonly logger = new Logger(ReorderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly departments: DepartmentsService,
    private readonly events: EventEmitter2,
  ) {}

  /** Available (on hand − reserved, excluding in-transit) in a store. */
  async available(storeId: number, productId: number): Promise<number> {
    const [qty, assets] = await Promise.all([
      this.prisma.db.stockBalance.aggregate({
        where: {
          storeId,
          productId,
          location: { kind: { not: 'IN_TRANSIT' } },
        },
        _sum: { onHand: true, reserved: true },
      }),
      this.prisma.db.asset.count({
        where: { storeId, productId, status: 'IN_STORE' },
      }),
    ]);
    return (qty._sum.onHand ?? 0) - (qty._sum.reserved ?? 0) + assets;
  }

  async check(keys: StockKey[]) {
    const seen = new Set<string>();
    for (const k of keys) {
      const id = `${k.storeId}:${k.productId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        await this.checkOne(k);
      } catch (error) {
        this.logger.error(`Reorder check ${id}: ${error}`);
      }
    }
  }

  private async checkOne({ storeId, productId }: StockKey) {
    const setting = await this.prisma.db.stockSetting.findUnique({
      where: { storeId_productId: { storeId, productId } },
      include: {
        store: true,
        product: { include: { currentVersion: true } },
      },
    });
    if (!setting || setting.reorderLevel <= 0) return;
    const available = await this.available(storeId, productId);
    if (available > setting.reorderLevel) {
      if (setting.alertedAt) {
        await this.prisma.db.stockSetting.update({
          where: { id: setting.id },
          data: { alertedAt: null },
        });
      }
      return;
    }
    if (setting.alertedAt) return;
    await this.prisma.db.stockSetting.update({
      where: { id: setting.id },
      data: { alertedAt: new Date() },
    });

    const target = setting.maxLevel ?? setting.reorderLevel * 2;
    const suggested = Math.max(target - available, 1);
    let mainAvailable: number | null = null;
    if (setting.store.type === 'SUB') {
      const main = await this.prisma.db.store.findFirst({
        where: { type: 'MAIN', isActive: true },
      });
      if (main) mainAvailable = await this.available(main.id, productId);
    }
    const product = setting.product;
    const params = {
      product:
        `${product.code ?? ''} ${product.currentVersion?.name ?? ''}`.trim(),
      store: setting.store.name,
      available,
      suggested,
    };
    const headId = await this.departments.resolveHeadEmployeeId(
      product.owningDepartmentId,
    );
    const head = headId
      ? await this.prisma.db.user.findFirst({
          where: { employeeId: headId, status: 'ACTIVE' },
        })
      : null;
    if (head) {
      await this.notifications.notify(head.id, {
        type: 'WARNING',
        titleKey: 'notifications.reorder_title',
        messageKey:
          mainAvailable != null && mainAvailable >= suggested
            ? 'notifications.reorder_transfer_message'
            : 'notifications.reorder_message',
        params,
        link: `/store/stock?store=${setting.store.uniqueId}&below=yes`,
      });
    } else {
      this.logger.warn(
        `Reorder level reached for ${params.product} in ${params.store}; no HOD to notify`,
      );
    }
    this.events.emit(REORDER_LEVEL_REACHED, {
      storeId,
      productId,
      available,
      suggested,
      transferFromMain: mainAvailable != null && mainAvailable >= suggested,
    });
  }
}
