import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  Asset,
  AssetCondition,
  AssetStatus,
  Prisma,
  StockTxnType,
} from '@db';
import { PrismaService, type DbTx } from '@prisma';
import { NumberingService } from '../numbering/numbering.service';

export interface TxnRef {
  type: StockTxnType;
  userId: number | null;
  referenceType?: string;
  referenceId?: string;
  reason?: string | null;
  beneficiary?: Prisma.InputJsonValue;
}

export const tagFor = (prefix: string, n: number) =>
  `AZM-${prefix}-${String(n).padStart(6, '0')}`;

/**
 * The only place stock changes (B2 §4): every change writes a ledger row in
 * the same transaction. The ledger is append-only (DB trigger) and stock can
 * never go negative (DB check + guarded updates).
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  /** Issue `count` new tags in a category series (printed before tagging). */
  async issueTags(
    prefix: string,
    count: number,
    userId: number | null,
    tx: DbTx,
  ) {
    const tags: {
      tag: string;
      prefix: string;
      number: number;
      issuedById: number | null;
    }[] = [];
    for (let i = 0; i < count; i++) {
      const n = await this.numbering.next(`TAG-${prefix}`, tx);
      tags.push({
        tag: tagFor(prefix, n),
        prefix,
        number: n,
        issuedById: userId,
      });
    }
    await tx.assetTag.createMany({ data: tags });
    return tx.assetTag.findMany({
      where: { tag: { in: tags.map((t) => t.tag) } },
      orderBy: { number: 'asc' },
    });
  }

  /** Change on-hand quantity of a quantity-tracked product at a location. */
  async moveQuantity(
    tx: DbTx,
    at: {
      storeId: number;
      locationId: number;
      productId: number;
      batchNumber?: string | null;
      expiryDate?: Date | null;
    },
    delta: number,
    ref: TxnRef,
  ) {
    if (!delta) return;
    const key = {
      storeId: at.storeId,
      locationId: at.locationId,
      productId: at.productId,
      batchNumber: at.batchNumber ?? '',
    };
    if (delta > 0) {
      await tx.stockBalance.upsert({
        where: { storeId_locationId_productId_batchNumber: key },
        update: {
          onHand: { increment: delta },
          ...(at.expiryDate ? { expiryDate: at.expiryDate } : {}),
        },
        create: { ...key, expiryDate: at.expiryDate ?? null, onHand: delta },
      });
    } else {
      // Only unreserved stock can leave (available = on hand − reserved).
      const rows = await tx.$queryRaw<{ id: number }[]>`
        UPDATE stock_balances SET on_hand = on_hand + ${delta}, updated_at = now()
        WHERE store_id = ${key.storeId} AND location_id = ${key.locationId}
          AND product_id = ${key.productId} AND batch_number = ${key.batchNumber}
          AND on_hand - reserved >= ${-delta}
        RETURNING id`;
      if (!rows.length)
        throw new BadRequestException('errors.stock_insufficient');
    }
    await tx.stockTransaction.create({
      data: {
        type: ref.type,
        userId: ref.userId,
        storeId: at.storeId,
        locationId: at.locationId,
        productId: at.productId,
        batchNumber: at.batchNumber || null,
        quantity: delta,
        referenceType: ref.referenceType,
        referenceId: ref.referenceId,
        reason: ref.reason ?? null,
        beneficiary: ref.beneficiary,
      },
    });
  }

  /** Create an asset (stock-in, opening balance, found / donated). */
  async createAsset(
    tx: DbTx,
    data: Omit<Prisma.AssetUncheckedCreateInput, 'tag' | 'tagId'> & {
      tagId: number;
    },
    ref: TxnRef,
  ) {
    const tag = await tx.assetTag.findUniqueOrThrow({
      where: { id: data.tagId },
    });
    const asset = await tx.asset.create({ data: { ...data, tag: tag.tag } });
    await tx.stockTransaction.create({
      data: {
        type: ref.type,
        userId: ref.userId,
        storeId: asset.storeId!,
        locationId: asset.locationId,
        productId: asset.productId,
        assetId: asset.id,
        quantity:
          asset.status === 'IN_STORE' || asset.status === 'RESERVED' ? 1 : 0,
        toStatus: asset.status,
        condition: asset.condition,
        referenceType: ref.referenceType,
        referenceId: ref.referenceId,
        reason: ref.reason ?? null,
      },
    });
    return asset;
  }

  /**
   * Record an asset movement / status change. On-hand counts +1 when the
   * asset comes into the store, −1 when it leaves.
   */
  async moveAsset(
    tx: DbTx,
    asset: Asset,
    to: {
      status?: AssetStatus;
      storeId?: number;
      locationId?: number | null;
      condition?: AssetCondition;
      custodianEmployeeId?: number | null;
    },
    ref: TxnRef,
  ) {
    const inStore = (s: AssetStatus) => s === 'IN_STORE' || s === 'RESERVED';
    const status = to.status ?? asset.status;
    const delta = (inStore(status) ? 1 : 0) - (inStore(asset.status) ? 1 : 0);
    const updated = await tx.asset.update({
      where: { id: asset.id },
      data: {
        status,
        storeId: to.storeId ?? asset.storeId,
        locationId:
          to.locationId === undefined ? asset.locationId : to.locationId,
        condition: to.condition ?? asset.condition,
        custodianEmployeeId:
          to.custodianEmployeeId === undefined
            ? asset.custodianEmployeeId
            : to.custodianEmployeeId,
      },
    });
    await tx.stockTransaction.create({
      data: {
        type: ref.type,
        userId: ref.userId,
        storeId: updated.storeId ?? asset.storeId!,
        locationId: asset.locationId,
        toLocationId:
          updated.locationId !== asset.locationId ? updated.locationId : null,
        productId: asset.productId,
        assetId: asset.id,
        quantity: delta,
        fromStatus: asset.status,
        toStatus: status,
        condition: updated.condition,
        referenceType: ref.referenceType,
        referenceId: ref.referenceId,
        reason: ref.reason ?? null,
        beneficiary: ref.beneficiary,
      },
    });
    return updated;
  }
}
