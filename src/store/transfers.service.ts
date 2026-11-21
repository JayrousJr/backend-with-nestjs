import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import type { Asset, AssetCondition, Prisma, TransferStatus } from '@db';
import { PrismaService, type DbTx } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  APPROVAL_COMPLETED,
  WorkflowService,
  type ApprovalCompletedEvent,
} from '../workflow/workflow.service';
import { LedgerService, type TxnRef } from './ledger.service';
import { ReorderService, type StockKey } from './reorder.service';
import { locationPath, StoresService } from './stores.service';
import type {
  CreateTransferInput,
  DispatchTransferInput,
  ReceiveTransferInput,
} from './transfers.types';

const POINT = 'transfer.approval';
const DISCREPANCY_POINT = 'transfer_discrepancy.approval';
const SUBJECT = 'Transfer';

export const TRANSFER_EVENTS = {
  DISPATCHED: 'transfer.dispatched',
  RECEIVED: 'transfer.received',
  DISCREPANCY: 'transfer.discrepancy',
} as const;

const INCLUDE = {
  fromStore: true,
  toStore: true,
  lines: { orderBy: { lineNo: 'asc' } },
} as const satisfies Prisma.TransferInclude;
type Row = Prisma.TransferGetPayload<{ include: typeof INCLUDE }>;

const OK_CONDITIONS: AssetCondition[] = ['GOOD', 'FAIR'];

/**
 * Store transfers (B2 §5): request → (approval) → reserve → dispatch
 * [in transit] → receive → discrepancy → completed. Quantities in transit
 * sit on the receiving store's In-transit location; assets in transit carry
 * the receiving store with status IN_TRANSIT. Kits travel as one.
 */
@Injectable()
export class TransfersService implements OnModuleInit {
  private readonly logger = new Logger(TransfersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly ledger: LedgerService,
    private readonly stores: StoresService,
    private readonly reorder: ReorderService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit() {
    // The person who dispatched cannot approve writing off what went missing.
    this.workflow.registerGuard(
      DISCREPANCY_POINT,
      async (actor, request, d) => {
        if (d.decision !== 'APPROVE') return;
        const tr = await this.prisma.db.transfer.findUnique({
          where: { uniqueId: request.subjectId },
        });
        await this.policy.enforceSod(
          'SOD_TRANSFER_SELF_RECEIVE',
          !!tr && tr.dispatchedByUserId === actor.id,
        );
      },
    );
  }

  private ref(
    tr: { number: string },
    userId: number | null,
    reason?: string,
  ): TxnRef {
    return {
      type: 'TRANSFER_DISPATCH',
      userId,
      referenceType: SUBJECT,
      referenceId: tr.number,
      reason,
    };
  }

  private async load(uniqueId: string, tx?: DbTx) {
    const t = await (tx ?? this.prisma.db).transfer.findUnique({
      where: { uniqueId },
      include: INCLUDE,
    });
    if (!t) throw new NotFoundException('errors.record_not_found');
    return t;
  }

  /** The asset plus its kit components that sit with it in the store. */
  private async withComponents(tx: DbTx, asset: Asset) {
    const comps = asset.isKit
      ? await tx.asset.findMany({
          where: {
            parentAssetId: asset.id,
            storeId: asset.storeId,
            status: asset.status,
          },
        })
      : [];
    return [asset, ...comps];
  }

  // ── create ───────────────────────────────────────────────────────────────

  async create(actor: CurrentUser, input: CreateTransferInput) {
    const [from, to] = await Promise.all([
      this.stores.byUniqueId(input.fromStoreUniqueId),
      this.stores.byUniqueId(input.toStoreUniqueId),
    ]);
    if (from.id === to.id)
      throw new BadRequestException('errors.transfer_same_store');
    if (!from.isActive || !to.isActive)
      throw new BadRequestException('errors.store_not_found');
    const canFrom = await this.access.can(actor, 'transfer.create', {
      storeId: from.id,
    });
    const canTo = await this.access.can(actor, 'transfer.create', {
      storeId: to.id,
    });
    if (!canFrom && !canTo) throw new ForbiddenException('errors.forbidden');

    const lines: Prisma.TransferLineCreateWithoutTransferInput[] = [];
    const seenAssets = new Set<number>();
    for (const [i, l] of input.lines.entries()) {
      const fail = (message: string, args: Record<string, unknown> = {}) =>
        new BadRequestException({ message, args: { line: i + 1, ...args } });
      if (l.assetUniqueId) {
        const a = await this.prisma.db.asset.findUnique({
          where: { uniqueId: l.assetUniqueId },
          include: { parent: true },
        });
        if (
          !a ||
          a.storeId !== from.id ||
          a.status !== 'IN_STORE' ||
          !OK_CONDITIONS.includes(a.condition)
        ) {
          throw fail('errors.transfer_line_asset');
        }
        if (a.parent)
          throw fail('errors.transfer_line_component', { kit: a.parent.tag });
        if (seenAssets.has(a.id)) throw fail('errors.transfer_line_asset');
        seenAssets.add(a.id);
        lines.push({
          lineNo: i + 1,
          productId: a.productId,
          assetId: a.id,
          quantity: 1,
          fromLocationId: a.locationId,
        });
      } else {
        const p = l.productUniqueId
          ? await this.prisma.db.product.findUnique({
              where: { uniqueId: l.productUniqueId },
            })
          : null;
        const loc = l.fromLocationUniqueId
          ? await this.prisma.db.storeLocation.findUnique({
              where: { uniqueId: l.fromLocationUniqueId },
            })
          : null;
        if (
          !p ||
          !p.trackingType ||
          p.trackingType === 'SERIALISED' ||
          !loc ||
          loc.storeId !== from.id ||
          !(l.quantity && l.quantity > 0)
        ) {
          throw fail('errors.transfer_line_quantity');
        }
        const bal = await this.prisma.db.stockBalance.findUnique({
          where: {
            storeId_locationId_productId_batchNumber: {
              storeId: from.id,
              locationId: loc.id,
              productId: p.id,
              batchNumber: l.batchNumber ?? '',
            },
          },
        });
        const available = bal ? bal.onHand - bal.reserved : 0;
        if (available < l.quantity)
          throw fail('errors.transfer_line_available', { available });
        lines.push({
          lineNo: i + 1,
          productId: p.id,
          quantity: l.quantity,
          fromLocationId: loc.id,
          batchNumber: l.batchNumber || null,
        });
      }
    }

    const tr = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.numbering.document('TRF', tx);
      const t = await tx.transfer.create({
        data: {
          number,
          fromStoreId: from.id,
          toStoreId: to.id,
          reason: input.reason,
          note: input.note?.trim() || null,
          requestedByUserId: actor.id,
          lines: { create: lines },
        },
      });
      const req = await this.workflow.start(
        {
          pointCode: POINT,
          subjectType: SUBJECT,
          subjectId: t.uniqueId,
          subjectDepartmentId: from.managingDepartmentId,
          title: `Transfer ${number}: ${from.name} → ${to.name} (${lines.length} lines)`,
          requesterUserId: actor.id,
          context: {
            reason: input.reason,
            from: from.code,
            to: to.code,
            lines: lines.length,
          },
        },
        tx,
      );
      await tx.transfer.update({
        where: { id: t.id },
        data: { approvalRequestId: req.id },
      });
      await this.audit.log(
        {
          action: 'transfer.create',
          entityType: SUBJECT,
          entityId: number,
          after: {
            from: from.code,
            to: to.code,
            reason: input.reason,
            lines: lines.length,
          },
        },
        tx,
      );
      return t;
    });
    return this.get(actor, tr.uniqueId);
  }

  // ── approval → reservation ───────────────────────────────────────────────

  @OnEvent(APPROVAL_COMPLETED, { async: true })
  async onCompleted(e: ApprovalCompletedEvent) {
    if (e.subjectType !== SUBJECT) return;
    if (e.pointCode === POINT) await this.onApproval(e);
    else if (e.pointCode === DISCREPANCY_POINT)
      await this.onDiscrepancyDecided(e);
  }

  private async onApproval(e: ApprovalCompletedEvent) {
    if (e.status !== 'APPROVED') {
      // Conditional update waits for the creating transaction.
      await this.prisma.db.transfer.updateMany({
        where: { uniqueId: e.subjectId, status: 'REQUESTED' },
        data: { status: e.status === 'CANCELLED' ? 'CANCELLED' : 'REJECTED' },
      });
      return;
    }
    const moved = await this.prisma.db.transfer.updateMany({
      where: { uniqueId: e.subjectId, status: 'REQUESTED' },
      data: { status: 'APPROVED' },
    });
    if (!moved.count) return;
    const keys: StockKey[] = [];
    try {
      await this.prisma.db.$transaction(async (tx) => {
        const t = await this.load(e.subjectId, tx);
        for (const l of t.lines) {
          const ref = {
            ...this.ref(t, e.deciderUserId ?? null),
            type: 'RESERVE' as const,
          };
          if (l.assetId) {
            const a = await tx.asset.findUniqueOrThrow({
              where: { id: l.assetId },
            });
            if (a.status !== 'IN_STORE' || a.storeId !== t.fromStoreId) {
              throw new Error(
                `Line ${l.lineNo}: ${a.tag} is no longer in store`,
              );
            }
            for (const x of await this.withComponents(tx, a)) {
              await this.ledger.moveAsset(tx, x, { status: 'RESERVED' }, ref);
            }
          } else {
            await this.ledger.reserveQuantity(
              tx,
              {
                storeId: t.fromStoreId,
                locationId: l.fromLocationId!,
                productId: l.productId,
                batchNumber: l.batchNumber,
              },
              l.quantity,
              ref,
            );
            await tx.transferLine.update({
              where: { id: l.id },
              data: { reserved: l.quantity },
            });
          }
          keys.push({ storeId: t.fromStoreId, productId: l.productId });
        }
      });
    } catch (error) {
      const message =
        error instanceof BadRequestException
          ? 'Not enough available stock to reserve'
          : error instanceof Error
            ? error.message
            : String(error);
      this.logger.warn(
        `Transfer ${e.subjectId} could not be reserved: ${message}`,
      );
      const t = await this.prisma.db.transfer.update({
        where: { uniqueId: e.subjectId },
        data: { status: 'CANCELLED', problem: `Cancelled: ${message}` },
      });
      await this.notifications.notify(t.requestedByUserId, {
        type: 'WARNING',
        titleKey: 'notifications.transfer_cancelled_title',
        messageKey: 'notifications.transfer_cancelled_message',
        params: { number: t.number },
        link: `/store/transfers/${t.uniqueId}`,
      });
      return;
    }
    await this.reorder.check(keys);
  }

  /** Release whatever is reserved (cancel before dispatch). */
  private async release(tx: DbTx, t: Row, userId: number) {
    for (const l of t.lines) {
      const ref = { ...this.ref(t, userId), type: 'RELEASE' as const };
      if (l.assetId) {
        const a = await tx.asset.findUniqueOrThrow({
          where: { id: l.assetId },
        });
        if (a.status === 'RESERVED') {
          for (const x of await this.withComponents(tx, a)) {
            await this.ledger.moveAsset(tx, x, { status: 'IN_STORE' }, ref);
          }
        }
      } else if (l.reserved > 0) {
        await this.ledger.releaseQuantity(
          tx,
          {
            storeId: t.fromStoreId,
            locationId: l.fromLocationId!,
            productId: l.productId,
            batchNumber: l.batchNumber,
          },
          l.reserved,
          ref,
        );
        await tx.transferLine.update({
          where: { id: l.id },
          data: { reserved: 0 },
        });
      }
    }
  }

  async cancel(actor: CurrentUser, uniqueId: string, reason: string) {
    const t = await this.load(uniqueId);
    if (t.status !== 'REQUESTED' && t.status !== 'APPROVED') {
      throw new BadRequestException('errors.transfer_status');
    }
    const may =
      t.requestedByUserId === actor.id ||
      (await this.access.can(actor, 'transfer.create', {
        storeId: t.fromStoreId,
      })) ||
      (await this.access.can(actor, 'transfer.create', {
        storeId: t.toStoreId,
      }));
    if (!may) throw new ForbiddenException('errors.forbidden');
    if (!reason?.trim())
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      await tx.transfer.update({
        where: { id: t.id },
        data: { status: 'CANCELLED' },
      });
      if (t.status === 'APPROVED') await this.release(tx, t, actor.id);
      else if (t.approvalRequestId)
        await this.workflow.cancel(t.approvalRequestId, reason, tx);
      await this.audit.log(
        {
          action: 'transfer.cancel',
          entityType: SUBJECT,
          entityId: t.number,
          after: { reason },
        },
        tx,
      );
    });
    await this.reorder.check(
      t.lines.map((l) => ({ storeId: t.fromStoreId, productId: l.productId })),
    );
    return this.get(actor, uniqueId);
  }

  // ── dispatch ─────────────────────────────────────────────────────────────

  async dispatch(
    actor: CurrentUser,
    uniqueId: string,
    input: DispatchTransferInput,
  ) {
    const t = await this.load(uniqueId);
    if (t.status !== 'APPROVED')
      throw new BadRequestException('errors.transfer_status');
    await this.access.assert(actor, 'transfer.dispatch', {
      storeId: t.fromStoreId,
    });
    let vehicleId: number | null = null;
    if (input.vehicleAssetUniqueId) {
      const v = await this.prisma.db.asset.findUnique({
        where: { uniqueId: input.vehicleAssetUniqueId },
        include: { product: true },
      });
      if (!v || !v.product.isVehicle)
        throw new BadRequestException('errors.vehicle_not_found');
      vehicleId = v.id;
    }
    const byLine = new Map(input.lines.map((l) => [l.lineNo, l]));
    const transit = await this.stores.systemLocation(t.toStoreId, 'IN_TRANSIT');
    await this.prisma.db.$transaction(
      async (tx) => {
        for (const l of t.lines) {
          const d = byLine.get(l.lineNo);
          const qty = d?.quantity ?? l.quantity;
          if (qty < 0 || qty > l.quantity) {
            throw new BadRequestException({
              message: 'errors.transfer_dispatch_too_many',
              args: { line: l.lineNo },
            });
          }
          const ref = this.ref(t, actor.id, d?.note);
          if (l.assetId) {
            const a = await tx.asset.findUniqueOrThrow({
              where: { id: l.assetId },
            });
            const group = await this.withComponents(tx, a);
            if (qty === 0) {
              for (const x of group)
                await this.ledger.moveAsset(
                  tx,
                  x,
                  { status: 'IN_STORE' },
                  { ...ref, type: 'RELEASE' },
                );
            } else {
              const condition = d?.condition ?? a.condition;
              for (const x of group) {
                await this.ledger.moveAsset(
                  tx,
                  x,
                  {
                    status: 'IN_TRANSIT',
                    storeId: t.toStoreId,
                    locationId: transit.id,
                    ...(x.id === a.id ? { condition } : {}),
                  },
                  ref,
                );
              }
            }
            await tx.transferLine.update({
              where: { id: l.id },
              data: {
                dispatchedQty: qty,
                dispatchCondition: qty ? (d?.condition ?? a.condition) : null,
              },
            });
          } else {
            const at = {
              storeId: t.fromStoreId,
              locationId: l.fromLocationId!,
              productId: l.productId,
              batchNumber: l.batchNumber,
            };
            await this.ledger.releaseQuantity(tx, at, l.reserved, {
              ...ref,
              type: 'RELEASE',
            });
            if (qty > 0) {
              await this.ledger.moveQuantity(tx, at, -qty, ref);
              await this.ledger.moveQuantity(
                tx,
                {
                  storeId: t.toStoreId,
                  locationId: transit.id,
                  productId: l.productId,
                  batchNumber: l.batchNumber,
                },
                qty,
                ref,
              );
            }
            await tx.transferLine.update({
              where: { id: l.id },
              data: { reserved: 0, dispatchedQty: qty },
            });
          }
        }
        await tx.transfer.update({
          where: { id: t.id },
          data: {
            status: 'DISPATCHED',
            dispatchedByUserId: actor.id,
            dispatchedAt: new Date(),
            carriedBy: input.carriedBy?.trim() || null,
            vehicleAssetId: vehicleId,
            expectedArrival: input.expectedArrival
              ? new Date(input.expectedArrival)
              : null,
          },
        });
        await this.audit.log(
          {
            action: 'transfer.dispatch',
            entityType: SUBJECT,
            entityId: t.number,
            after: {
              carriedBy: input.carriedBy,
              expectedArrival: input.expectedArrival,
            },
          },
          tx,
        );
      },
      { timeout: 60_000 },
    );
    await this.notifyStore(
      t.toStoreId,
      'notifications.transfer_dispatched_title',
      'notifications.transfer_dispatched_message',
      t,
    );
    this.events.emit(TRANSFER_EVENTS.DISPATCHED, { transferId: t.id });
    await this.reorder.check(
      t.lines.map((l) => ({ storeId: t.fromStoreId, productId: l.productId })),
    );
    return this.get(actor, uniqueId);
  }

  // ── receive ──────────────────────────────────────────────────────────────

  async receive(
    actor: CurrentUser,
    uniqueId: string,
    input: ReceiveTransferInput,
  ) {
    const t = await this.load(uniqueId);
    if (t.status !== 'DISPATCHED' && t.status !== 'DISCREPANCY') {
      throw new BadRequestException('errors.transfer_status');
    }
    await this.access.assert(actor, 'transfer.receive', {
      storeId: t.toStoreId,
    });
    // SOD_TRANSFER_SELF_RECEIVE: sender and receiver are different people.
    await this.policy.enforceSod(
      'SOD_TRANSFER_SELF_RECEIVE',
      t.dispatchedByUserId === actor.id,
    );
    const transit = await this.stores.systemLocation(t.toStoreId, 'IN_TRANSIT');
    const locations = await this.prisma.db.storeLocation.findMany({
      where: { storeId: t.toStoreId, kind: 'GENERAL', isActive: true },
    });
    const locBy = new Map(locations.map((l) => [l.uniqueId, l]));
    const byLine = new Map(input.lines.map((l) => [l.lineNo, l]));
    let short = false;
    await this.prisma.db.$transaction(
      async (tx) => {
        for (const l of t.lines) {
          const dispatched = l.dispatchedQty ?? 0;
          const already = l.receivedQty ?? 0;
          const open = dispatched - already;
          const r = byLine.get(l.lineNo);
          const qty = r ? r.quantity : 0;
          if (qty < 0 || qty > open) {
            throw new BadRequestException({
              message: 'errors.transfer_receive_too_many',
              args: { line: l.lineNo },
            });
          }
          if (qty > 0) {
            const loc = r?.toLocationUniqueId
              ? locBy.get(r.toLocationUniqueId)
              : undefined;
            if (!loc)
              throw new BadRequestException('errors.location_not_found');
            const ref = {
              ...this.ref(t, actor.id, r?.note),
              type: 'TRANSFER_RECEIVE' as const,
            };
            if (l.assetId) {
              const a = await tx.asset.findUniqueOrThrow({
                where: { id: l.assetId },
              });
              for (const x of await this.withComponents(tx, a)) {
                await this.ledger.moveAsset(
                  tx,
                  x,
                  {
                    status: 'IN_STORE',
                    locationId: loc.id,
                    ...(x.id === a.id && r?.condition
                      ? { condition: r.condition }
                      : {}),
                  },
                  ref,
                );
              }
            } else {
              await this.ledger.moveQuantity(
                tx,
                {
                  storeId: t.toStoreId,
                  locationId: transit.id,
                  productId: l.productId,
                  batchNumber: l.batchNumber,
                },
                -qty,
                ref,
              );
              await this.ledger.moveQuantity(
                tx,
                {
                  storeId: t.toStoreId,
                  locationId: loc.id,
                  productId: l.productId,
                  batchNumber: l.batchNumber,
                },
                qty,
                ref,
              );
            }
            await tx.transferLine.update({
              where: { id: l.id },
              data: {
                receivedQty: already + qty,
                receivedCondition: r?.condition ?? null,
                toLocationId: loc.id,
                note: r?.note?.trim() || l.note,
              },
            });
          }
          if (already + qty < dispatched) short = true;
        }
        await tx.transfer.update({
          where: { id: t.id },
          data: {
            status: short ? 'DISCREPANCY' : 'COMPLETED',
            receivedByUserId: actor.id,
            receivedAt: new Date(),
            discrepancyNote: input.note?.trim() || t.discrepancyNote,
          },
        });
        // All in after a discrepancy was raised: withdraw the write-off request.
        if (!short && t.discrepancyRequestId) {
          await this.workflow.cancel(
            t.discrepancyRequestId,
            'Everything was received',
            tx,
          );
          await tx.transfer.update({
            where: { id: t.id },
            data: { discrepancyRequestId: null },
          });
        }
        if (short && !t.discrepancyRequestId) {
          const req = await this.workflow.start(
            {
              pointCode: DISCREPANCY_POINT,
              subjectType: SUBJECT,
              subjectId: t.uniqueId,
              subjectDepartmentId: t.toStore.managingDepartmentId,
              title: `Transfer discrepancy ${t.number}: ${t.fromStore.name} → ${t.toStore.name}`,
              requesterUserId: actor.id,
              context: { from: t.fromStore.code, to: t.toStore.code },
            },
            tx,
          );
          await tx.transfer.update({
            where: { id: t.id },
            data: { discrepancyRequestId: req.id },
          });
        }
        await this.audit.log(
          {
            action: short ? 'transfer.receive_short' : 'transfer.receive',
            entityType: SUBJECT,
            entityId: t.number,
            after: { lines: input.lines, note: input.note },
          },
          tx,
        );
      },
      { timeout: 60_000 },
    );
    await this.notifications.notify(t.requestedByUserId, {
      type: short ? 'WARNING' : 'SUCCESS',
      titleKey: short
        ? 'notifications.transfer_discrepancy_title'
        : 'notifications.transfer_received_title',
      messageKey: 'notifications.transfer_received_message',
      params: { number: t.number, store: t.toStore.name },
      link: `/store/transfers/${t.uniqueId}`,
    });
    this.events.emit(
      short ? TRANSFER_EVENTS.DISCREPANCY : TRANSFER_EVENTS.RECEIVED,
      { transferId: t.id },
    );
    await this.reorder.check(
      t.lines.map((l) => ({ storeId: t.toStoreId, productId: l.productId })),
    );
    return this.get(actor, uniqueId);
  }

  /** Discrepancy approved: write off what never arrived (assets → missing). */
  private async onDiscrepancyDecided(e: ApprovalCompletedEvent) {
    const t = await this.load(e.subjectId);
    if (t.status !== 'DISCREPANCY') return;
    if (e.status !== 'APPROVED') {
      // Rejected / returned: investigate further; a new request is raised on the next receipt.
      await this.prisma.db.transfer.update({
        where: { id: t.id },
        data: { discrepancyRequestId: null },
      });
      return;
    }
    const transit = await this.stores.systemLocation(t.toStoreId, 'IN_TRANSIT');
    await this.prisma.db.$transaction(async (tx) => {
      for (const l of t.lines) {
        const missing = (l.dispatchedQty ?? 0) - (l.receivedQty ?? 0);
        if (missing <= 0) continue;
        const ref: TxnRef = {
          type: 'ADJUSTMENT',
          userId: e.deciderUserId ?? null,
          referenceType: SUBJECT,
          referenceId: t.number,
          reason: 'Transfer discrepancy written off',
        };
        if (l.assetId) {
          const a = await tx.asset.findUniqueOrThrow({
            where: { id: l.assetId },
          });
          for (const x of await this.withComponents(tx, a)) {
            await this.ledger.moveAsset(
              tx,
              x,
              { status: 'MISSING', locationId: null },
              ref,
            );
          }
        } else {
          await this.ledger.moveQuantity(
            tx,
            {
              storeId: t.toStoreId,
              locationId: transit.id,
              productId: l.productId,
              batchNumber: l.batchNumber,
            },
            -missing,
            ref,
          );
        }
      }
      await tx.transfer.update({
        where: { id: t.id },
        data: { status: 'COMPLETED' },
      });
      await this.audit.log(
        {
          action: 'transfer.discrepancy_written_off',
          entityType: SUBJECT,
          entityId: t.number,
        },
        tx,
      );
    });
  }

  // ── reminders ────────────────────────────────────────────────────────────

  /** Overdue receipts remind both storekeepers (daily, 08:00 EAT). */
  @Cron('0 8 * * *', { timeZone: 'Africa/Dar_es_Salaam' })
  async remindOverdue() {
    const now = new Date();
    const startOfDay = new Date(now.getTime() - 20 * 3600_000);
    const overdue = await this.prisma.db.transfer.findMany({
      where: {
        status: 'DISPATCHED',
        expectedArrival: { lt: now },
        OR: [{ remindedAt: null }, { remindedAt: { lt: startOfDay } }],
      },
      include: INCLUDE,
    });
    for (const t of overdue) {
      for (const storeId of [t.fromStoreId, t.toStoreId]) {
        await this.notifyStore(
          storeId,
          'notifications.transfer_overdue_title',
          'notifications.transfer_overdue_message',
          t,
          'WARNING',
        );
      }
      await this.prisma.db.transfer.update({
        where: { id: t.id },
        data: { remindedAt: now },
      });
    }
    return overdue.length;
  }

  private async notifyStore(
    storeId: number,
    titleKey: string,
    messageKey: string,
    t: Row,
    type: 'INFO' | 'WARNING' = 'INFO',
  ) {
    for (const userId of await this.stores.keeperUserIds(storeId)) {
      await this.notifications.notify(userId, {
        type,
        titleKey,
        messageKey,
        params: {
          number: t.number,
          from: t.fromStore.name,
          to: t.toStore.name,
        },
        link: `/store/transfers/${t.uniqueId}`,
      });
    }
  }

  // ── queries ──────────────────────────────────────────────────────────────

  private async visibleWhere(
    user: CurrentUser,
  ): Promise<Prisma.TransferWhereInput> {
    const scope = await this.stores.stockScope(user);
    if (scope.all || (await this.access.can(user, 'store.manage'))) return {};
    const or: Prisma.TransferWhereInput[] = [{ requestedByUserId: user.id }];
    if (scope.storeIds.length) {
      or.push(
        { fromStoreId: { in: scope.storeIds } },
        { toStoreId: { in: scope.storeIds } },
      );
    }
    return { OR: or };
  }

  async list(
    user: CurrentUser,
    storeUniqueId?: string,
    statuses?: TransferStatus[],
  ) {
    const store = storeUniqueId
      ? await this.stores.byUniqueId(storeUniqueId)
      : null;
    const rows = await this.prisma.db.transfer.findMany({
      where: {
        AND: [
          await this.visibleWhere(user),
          store
            ? { OR: [{ fromStoreId: store.id }, { toStoreId: store.id }] }
            : {},
          statuses?.length ? { status: { in: statuses } } : {},
        ],
      },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.present(user, rows, false);
  }

  async get(user: CurrentUser, uniqueId: string) {
    const t = await this.load(uniqueId);
    const n = await this.prisma.db.transfer.count({
      where: { AND: [{ id: t.id }, await this.visibleWhere(user)] },
    });
    if (!n) {
      const reqIds = [t.approvalRequestId, t.discrepancyRequestId].filter(
        (x): x is number => !!x,
      );
      const assigned = await this.prisma.db.approvalAssignment.count({
        where: { requestId: { in: reqIds }, userId: user.id },
      });
      if (!assigned) throw new ForbiddenException('errors.forbidden');
    }
    return (await this.present(user, [t], true))[0];
  }

  private async present(user: CurrentUser, rows: Row[], withLines: boolean) {
    const userIds = rows
      .flatMap((r) => [
        r.requestedByUserId,
        r.dispatchedByUserId,
        r.receivedByUserId,
      ])
      .filter((x): x is number => !!x);
    const users = await this.prisma.dbRaw.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      include: { employee: true },
    });
    const nameBy = new Map(
      users.map((u) => [
        u.id,
        `${u.employee.firstName} ${u.employee.lastName}`,
      ]),
    );
    const reqIds = rows
      .flatMap((r) => [r.approvalRequestId, r.discrepancyRequestId])
      .filter((x): x is number => !!x);
    const reqs = await this.prisma.db.approvalRequest.findMany({
      where: { id: { in: reqIds } },
      select: { id: true, uniqueId: true },
    });
    const reqBy = new Map(reqs.map((r) => [r.id, r.uniqueId]));
    const productIds = [
      ...new Set(rows.flatMap((r) => r.lines.map((l) => l.productId))),
    ];
    const assetIds = rows
      .flatMap((r) => [...r.lines.map((l) => l.assetId), r.vehicleAssetId])
      .filter((x): x is number => !!x);
    const [products, assets, locations] = withLines
      ? await Promise.all([
          this.prisma.db.product.findMany({
            where: { id: { in: productIds } },
            include: { currentVersion: true },
          }),
          this.prisma.db.asset.findMany({
            where: { id: { in: assetIds } },
            include: { components: { select: { tag: true } }, vehicle: true },
          }),
          this.prisma.db.storeLocation.findMany({
            where: {
              storeId: {
                in: rows.flatMap((r) => [r.fromStoreId, r.toStoreId]),
              },
            },
          }),
        ])
      : [[], [], []];
    const pBy = new Map(products.map((p) => [p.id, p]));
    const aBy = new Map(assets.map((a) => [a.id, a]));
    const lBy = new Map(locations.map((l) => [l.id, l]));
    const can = async (
      perm: 'transfer.dispatch' | 'transfer.receive' | 'transfer.create',
      storeId: number,
    ) => this.access.can(user, perm, { storeId });
    return Promise.all(
      rows.map(async (t) => {
        const [dispatch, receive, createFrom, createTo] = await Promise.all([
          can('transfer.dispatch', t.fromStoreId),
          can('transfer.receive', t.toStoreId),
          can('transfer.create', t.fromStoreId),
          can('transfer.create', t.toStoreId),
        ]);
        const vehicle = t.vehicleAssetId
          ? aBy.get(t.vehicleAssetId)
          : undefined;
        return {
          uniqueId: t.uniqueId,
          number: t.number,
          status: t.status,
          reason: t.reason,
          note: t.note,
          problem: t.problem,
          fromStore: {
            uniqueId: t.fromStore.uniqueId,
            code: t.fromStore.code,
            name: t.fromStore.name,
          },
          toStore: {
            uniqueId: t.toStore.uniqueId,
            code: t.toStore.code,
            name: t.toStore.name,
          },
          requestedBy: nameBy.get(t.requestedByUserId) ?? '—',
          dispatchedBy: t.dispatchedByUserId
            ? (nameBy.get(t.dispatchedByUserId) ?? null)
            : null,
          dispatchedAt: t.dispatchedAt,
          carriedBy: t.carriedBy,
          vehicle: vehicle
            ? (vehicle.vehicle?.registrationNumber ?? vehicle.tag)
            : null,
          expectedArrival: t.expectedArrival,
          receivedBy: t.receivedByUserId
            ? (nameBy.get(t.receivedByUserId) ?? null)
            : null,
          receivedAt: t.receivedAt,
          discrepancyNote: t.discrepancyNote,
          createdAt: t.createdAt,
          approvalRequestUniqueId: t.approvalRequestId
            ? (reqBy.get(t.approvalRequestId) ?? null)
            : null,
          discrepancyRequestUniqueId: t.discrepancyRequestId
            ? (reqBy.get(t.discrepancyRequestId) ?? null)
            : null,
          lineCount: t.lines.length,
          overdue:
            t.status === 'DISPATCHED' &&
            !!t.expectedArrival &&
            t.expectedArrival < new Date(),
          lines: withLines
            ? t.lines.map((l) => {
                const a = l.assetId ? aBy.get(l.assetId) : undefined;
                const p = pBy.get(l.productId);
                const from = l.fromLocationId
                  ? lBy.get(l.fromLocationId)
                  : undefined;
                const to = l.toLocationId ? lBy.get(l.toLocationId) : undefined;
                return {
                  lineNo: l.lineNo,
                  productUniqueId: p?.uniqueId ?? '',
                  productCode: p?.code ?? null,
                  productName: p?.currentVersion?.name ?? '—',
                  assetUniqueId: a?.uniqueId ?? null,
                  assetTag: a?.tag ?? null,
                  components: a?.components.map((c) => c.tag) ?? [],
                  batchNumber: l.batchNumber,
                  quantity: l.quantity,
                  fromLocation: from ? locationPath(from, locations) : null,
                  dispatchedQty: l.dispatchedQty,
                  dispatchCondition: l.dispatchCondition,
                  receivedQty: l.receivedQty,
                  receivedCondition: l.receivedCondition,
                  toLocation: to ? locationPath(to, locations) : null,
                  note: l.note,
                };
              })
            : [],
          can: {
            dispatch: dispatch && t.status === 'APPROVED',
            receive:
              receive &&
              (t.status === 'DISPATCHED' || t.status === 'DISCREPANCY'),
            cancel:
              (t.status === 'REQUESTED' || t.status === 'APPROVED') &&
              (t.requestedByUserId === user.id || createFrom || createTo),
          },
        };
      }),
    );
  }
}
