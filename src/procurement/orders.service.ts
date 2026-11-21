import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import type {
  Prisma,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderStatus,
} from '@db';
import { PrismaService, type DbTx } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PolicyService } from '../policy/policy.service';
import {
  APPROVAL_COMPLETED,
  WorkflowService,
  type ApprovalCompletedEvent,
} from '../workflow/workflow.service';
import { SourcingService, type LineRef } from './sourcing.service';
import { D, day, round2, vatParts } from './procurement.util';

const ISSUE_POINT = 'purchase_order.issue';
const AMEND_POINT = 'purchase_order.amendment';
const CANCEL_POINT = 'purchase_order.cancellation';
const LPO = 'PurchaseOrder';
const AMEND = 'PurchaseOrderAmendment';

/** Statuses in which goods can still be received. */
export const RECEIVABLE: PurchaseOrderStatus[] = [
  'ISSUED',
  'ACKNOWLEDGED',
  'AMENDMENT_PENDING',
  'PARTIALLY_RECEIVED',
];

export interface AmendInput {
  reason: string;
  deliveryDate?: string | null;
  instructions?: string | null;
  lines: {
    lineNo: number;
    quantity: number;
    unitPrice: number;
    description?: string | null;
  }[];
}

export interface CashPurchaseInput {
  vendorUniqueId?: string | null;
  shopName?: string | null;
  purchaseDate?: string | null;
  receiptFileUniqueIds: string[];
  lines: (LineRef & { quantity: number; unitPrice: number })[];
}

type Snapshot = {
  deliveryDate: string | null;
  instructions: string | null;
  lines: {
    lineNo: number;
    quantity: number;
    unitPrice: number;
    description: string | null;
  }[];
};

const total = (lines: { quantity: number; unitPrice: number }[]) =>
  round2(lines.reduce((n, l) => n + l.quantity * l.unitPrice, 0));

/**
 * LPOs (tender spec §9; requirements §4.7–§4.8): one per winning vendor per
 * tender, delivered to the main store. Issue via purchase_order.issue,
 * vendor acknowledgement, amendments as new revisions (CEO only when the
 * value increases), cancellation by the CEO with optional re-award.
 */
@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly policy: PolicyService,
    private readonly workflow: WorkflowService,
    private readonly sourcing: SourcingService,
  ) {}

  onModuleInit() {
    // The standstill period (when enabled) runs from the award letters.
    this.workflow.registerGuard(ISSUE_POINT, async (_a, request, d) => {
      if (d.decision !== 'APPROVE' || !d.lastStep) return;
      const o = await this.prisma.db.purchaseOrder.findUnique({
        where: { uniqueId: request.subjectId },
      });
      if (o) await this.assertStandstill(o);
    });
  }

  private async mainStore(tx?: DbTx) {
    const s = await (tx ?? this.prisma.db).store.findFirst({
      where: { type: 'MAIN', isActive: true },
    });
    if (!s) throw new BadRequestException('errors.no_main_store');
    return s;
  }

  private async assertStandstill(o: PurchaseOrder) {
    if (!o.tenderId) return;
    const t = await this.prisma.db.tender.findUniqueOrThrow({
      where: { id: o.tenderId },
    });
    const snap = (
      (t.policySnapshot ?? {}) as Record<
        string,
        { enabled?: boolean; days?: number }
      >
    ).PROC_STANDSTILL;
    if (!snap?.enabled) return;
    if (!t.lettersSentAt)
      throw new BadRequestException('errors.letters_not_sent');
    const ends = new Date(t.lettersSentAt.getTime() + (snap.days ?? 0) * 864e5);
    if (ends > new Date())
      throw new BadRequestException({
        message: 'errors.standstill_running',
        args: { until: ends.toISOString().slice(0, 10) },
      });
  }

  // ── from award ──────────────────────────────────────────────────────────

  /** One draft LPO per winning vendor with every item it won (no retyping). */
  async createFromAward(actor: CurrentUser, tenderUniqueId: string) {
    const t = await this.prisma.db.tender.findUnique({
      where: { uniqueId: tenderUniqueId },
      include: { lines: true, bids: { include: { lines: true } } },
    });
    if (!t) throw new NotFoundException('errors.record_not_found');
    if (t.status !== 'AWARDED')
      throw new BadRequestException('errors.tender_not_awarded');
    const existing = await this.prisma.db.purchaseOrderLine.findMany({
      where: {
        tenderLineId: { in: t.lines.map((l) => l.id) },
        order: { status: { not: 'CANCELLED' } },
      },
    });
    const byVendor = new Map<
      number,
      {
        tl: (typeof t.lines)[number];
        bl: (typeof t.bids)[number]['lines'][number];
      }[]
    >();
    for (const tl of t.lines) {
      if (!tl.awardBidLineId || existing.some((e) => e.tenderLineId === tl.id))
        continue;
      const bid = t.bids.find((b) =>
        b.lines.some((l) => l.id === tl.awardBidLineId),
      )!;
      const bl = bid.lines.find((l) => l.id === tl.awardBidLineId)!;
      byVendor.set(bid.vendorId, [
        ...(byVendor.get(bid.vendorId) ?? []),
        { tl, bl },
      ]);
    }
    if (!byVendor.size)
      throw new BadRequestException('errors.nothing_to_order');
    const created = await this.prisma.db.$transaction(async (tx) => {
      const store = await this.mainStore(tx);
      const out: string[] = [];
      for (const [vendorId, items] of byVendor) {
        out.push(
          await this.createOrder(
            tx,
            actor,
            t.id,
            vendorId,
            store.id,
            items.map(({ tl, bl }) => ({ tl, bl, quantity: tl.quantity })),
          ),
        );
      }
      return out;
    });
    return Promise.all(created.map((id) => this.get(actor, id)));
  }

  private async createOrder(
    tx: DbTx,
    actor: CurrentUser,
    tenderId: number,
    vendorId: number,
    storeId: number,
    items: {
      tl: { id: number; productId: number; productVersionId: number };
      bl: {
        id: number;
        unitPrice: Prisma.Decimal;
        negotiatedPrice: Prisma.Decimal | null;
        negotiatedDays: number | null;
        deliveryDays: number;
        vatRate: Prisma.Decimal;
        brand: string | null;
        model: string | null;
      };
      quantity: number;
    }[],
  ) {
    const days = Math.max(
      ...items.map(({ bl }) => bl.negotiatedDays ?? bl.deliveryDays),
    );
    const deliveryDate = new Date();
    deliveryDate.setUTCDate(deliveryDate.getUTCDate() + days);
    const o = await tx.purchaseOrder.create({
      data: {
        number: await this.numbering.document('LPO', tx),
        kind: 'TENDER',
        tenderId,
        vendorId,
        storeId,
        deliveryDate: day(deliveryDate.toISOString()),
        createdById: actor.id,
        lines: {
          create: items.map(({ tl, bl, quantity }, i) => {
            const price = D(bl.negotiatedPrice ?? bl.unitPrice);
            return {
              lineNo: i + 1,
              tenderLineId: tl.id,
              bidLineId: bl.id,
              productId: tl.productId,
              productVersionId: tl.productVersionId,
              brand: bl.brand,
              model: bl.model,
              quantity,
              unitPrice: price,
              vatRate: bl.vatRate,
              awardedUnitPrice: price,
              awardedQuantity: quantity,
              deliveryDays: bl.negotiatedDays ?? bl.deliveryDays,
            };
          }),
        },
      },
    });
    await this.audit.log(
      {
        action: 'LPO_CREATED',
        entityType: LPO,
        entityId: o.uniqueId,
        after: { number: o.number },
      },
      tx,
    );
    return o.uniqueId;
  }

  private async load(uniqueId: string) {
    const o = await this.prisma.db.purchaseOrder.findUnique({
      where: { uniqueId },
      include: {
        lines: { orderBy: { lineNo: 'asc' } },
        amendments: { orderBy: { revision: 'asc' } },
      },
    });
    if (!o) throw new NotFoundException('errors.record_not_found');
    return o;
  }

  async update(
    actor: CurrentUser,
    uniqueId: string,
    input: { deliveryDate?: string | null; instructions?: string | null },
  ) {
    const o = await this.load(uniqueId);
    if (o.status !== 'DRAFT')
      throw new BadRequestException('errors.lpo_not_draft');
    await this.prisma.db.purchaseOrder.update({
      where: { id: o.id },
      data: {
        deliveryDate: day(input.deliveryDate),
        instructions: input.instructions?.trim() || null,
      },
    });
    return this.get(actor, uniqueId);
  }

  /** Send for issue (purchase_order.issue). The submitter is "who issued" (SOD_LPO_RECEIVE). */
  async issue(actor: CurrentUser, uniqueId: string) {
    const o = await this.load(uniqueId);
    if (o.status !== 'DRAFT')
      throw new BadRequestException('errors.lpo_not_draft');
    await this.assertStandstill(o);
    await this.prisma.db.$transaction(async (tx) => {
      const req = await this.workflow.start(
        {
          pointCode: ISSUE_POINT,
          subjectType: LPO,
          subjectId: o.uniqueId,
          title: `Issue ${o.number}`,
          requesterUserId: actor.id,
          context: {
            amount: total(
              o.lines.map((l) => ({
                quantity: l.quantity,
                unitPrice: D(l.unitPrice),
              })),
            ),
          },
        },
        tx,
      );
      await tx.purchaseOrder.update({
        where: { id: o.id },
        data: {
          status: 'IN_APPROVAL',
          issueApprovalId: req.id,
          issuedById: actor.id,
        },
      });
    });
    await this.audit.log({
      action: 'LPO_SUBMITTED',
      entityType: LPO,
      entityId: o.uniqueId,
    });
    return this.get(actor, uniqueId);
  }

  private async markRequestLines(
    tx: DbTx,
    o: PurchaseOrder & { lines: PurchaseOrderLine[] },
    status: 'ORDERED' | 'RECEIVED' | 'OPEN',
  ) {
    const tlIds = o.lines
      .map((l) => l.tenderLineId)
      .filter((x): x is number => !!x);
    const sources = await tx.tenderLineSource.findMany({
      where: { tenderLineId: { in: tlIds } },
    });
    const ids = [
      ...sources.map((s) => s.purchaseRequestLineId),
      ...o.lines
        .map((l) => l.purchaseRequestLineId)
        .filter((x): x is number => !!x),
    ];
    await tx.purchaseRequestLine.updateMany({
      where: { id: { in: ids } },
      data: { sourcingStatus: status },
    });
    if (status === 'RECEIVED') {
      const prIds = (
        await tx.purchaseRequestLine.findMany({
          where: { id: { in: ids } },
          select: { purchaseRequestId: true },
        })
      ).map((x) => x.purchaseRequestId);
      for (const prId of new Set(prIds)) {
        const open = await tx.purchaseRequestLine.count({
          where: {
            purchaseRequestId: prId,
            sourcingStatus: { notIn: ['RECEIVED', 'CANCELLED'] },
          },
        });
        if (!open)
          await tx.purchaseRequest.update({
            where: { id: prId },
            data: { status: 'COMPLETED' },
          });
      }
    }
  }

  @OnEvent(APPROVAL_COMPLETED, { async: true })
  async onCompleted(e: ApprovalCompletedEvent) {
    if (e.subjectType === LPO && e.pointCode === ISSUE_POINT) {
      const o = await this.load(e.subjectId).catch(() => null);
      if (!o || o.status !== 'IN_APPROVAL') return;
      if (e.status !== 'APPROVED') {
        await this.prisma.db.purchaseOrder.update({
          where: { id: o.id },
          data: { status: 'DRAFT', issueApprovalId: null },
        });
        return;
      }
      await this.prisma.db.$transaction(async (tx) => {
        await tx.purchaseOrder.update({
          where: { id: o.id },
          data: { status: 'ISSUED', issuedAt: new Date() },
        });
        await this.markRequestLines(tx, o, 'ORDERED');
      });
      await this.audit.log({
        action: 'LPO_ISSUED',
        entityType: LPO,
        entityId: o.uniqueId,
      });
      if (o.vendorId) {
        const v = await this.prisma.db.vendor.findUniqueOrThrow({
          where: { id: o.vendorId },
        });
        await this.sourcing.vendorNotify(v.id, v.email, {
          type: 'LPO',
          title: `LPO ${o.number} issued`,
          body: `AzamTV has issued LPO ${o.number}. Delivery to the AzamTV main store${o.deliveryDate ? ` by ${o.deliveryDate.toISOString().slice(0, 10)}` : ''}. Please acknowledge it on the portal.`,
          link: `/portal/orders/${o.uniqueId}`,
        });
      }
      await this.notifyKeepers(o.storeId, {
        titleKey: 'notifications.lpo_issued_title',
        messageKey: 'notifications.lpo_issued_message',
        params: { number: o.number },
        link: `/procurement/orders/${o.uniqueId}`,
      });
      return;
    }
    if (e.subjectType === AMEND && e.pointCode === AMEND_POINT) {
      const a = await this.prisma.db.purchaseOrderAmendment.findUnique({
        where: { uniqueId: e.subjectId },
        include: { order: true },
      });
      if (!a || a.status !== 'IN_APPROVAL') return;
      if (e.status !== 'APPROVED') {
        await this.prisma.db.$transaction(async (tx) => {
          await tx.purchaseOrderAmendment.update({
            where: { id: a.id },
            data: { status: 'REJECTED' },
          });
          await tx.purchaseOrder.update({
            where: { id: a.orderId },
            data: { status: await this.receiptStatus(tx, a.orderId, true) },
          });
        });
        return;
      }
      if (a.order.kind === 'CASH') {
        await this.applyAmendment(a.id);
        return;
      }
      await this.prisma.db.purchaseOrderAmendment.update({
        where: { id: a.id },
        data: { status: 'AWAITING_ACKNOWLEDGEMENT' },
      });
      const v = await this.prisma.db.vendor.findUniqueOrThrow({
        where: { id: a.order.vendorId! },
      });
      await this.sourcing.vendorNotify(v.id, v.email, {
        type: 'LPO_AMENDMENT',
        title: `LPO ${a.order.number} amended (rev ${a.revision})`,
        body: `Reason: ${a.reason}. Please review and acknowledge the new version; until then the previous version stays in force.`,
        link: `/portal/orders/${a.order.uniqueId}`,
      });
      return;
    }
    if (e.subjectType === LPO && e.pointCode === CANCEL_POINT) {
      const o = await this.load(e.subjectId).catch(() => null);
      if (!o || !o.cancelApprovalId) return;
      if (e.status !== 'APPROVED') {
        await this.prisma.db.purchaseOrder.update({
          where: { id: o.id },
          data: {
            cancelApprovalId: null,
            cancelReason: null,
            reawardRequested: false,
          },
        });
        return;
      }
      await this.cancelApproved(o);
    }
  }

  // ── vendor acknowledgement ──────────────────────────────────────────────

  async acknowledge(vendorId: number, uniqueId: string, by: string) {
    const o = await this.load(uniqueId);
    if (o.vendorId !== vendorId)
      throw new ForbiddenException('errors.forbidden');
    const pending = o.amendments.find(
      (a) => a.status === 'AWAITING_ACKNOWLEDGEMENT',
    );
    if (pending) {
      await this.prisma.db.purchaseOrderAmendment.update({
        where: { id: pending.id },
        data: { acknowledgedAt: new Date() },
      });
      // Acknowledging the new version also acknowledges the LPO itself.
      if (!o.acknowledgedAt)
        await this.prisma.db.purchaseOrder.update({
          where: { id: o.id },
          data: { acknowledgedAt: new Date(), acknowledgedBy: by },
        });
      await this.applyAmendment(pending.id);
      await this.audit.log({
        action: 'LPO_AMENDMENT_ACKNOWLEDGED',
        entityType: LPO,
        entityId: o.uniqueId,
        after: { by, revision: pending.revision },
      });
      return;
    }
    if (o.status !== 'ISSUED')
      throw new BadRequestException('errors.lpo_not_issued');
    await this.prisma.db.purchaseOrder.update({
      where: { id: o.id },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(),
        acknowledgedBy: by,
      },
    });
    await this.audit.log({
      action: 'LPO_ACKNOWLEDGED',
      entityType: LPO,
      entityId: o.uniqueId,
      after: { by },
    });
  }

  // ── amendments (§9) ─────────────────────────────────────────────────────

  private snapshot(
    o: PurchaseOrder & { lines: PurchaseOrderLine[] },
  ): Snapshot {
    return {
      deliveryDate: o.deliveryDate?.toISOString().slice(0, 10) ?? null,
      instructions: o.instructions,
      lines: o.lines.map((l) => ({
        lineNo: l.lineNo,
        quantity: l.quantity,
        unitPrice: D(l.unitPrice),
        description: l.description,
      })),
    };
  }

  async amend(actor: CurrentUser, uniqueId: string, input: AmendInput) {
    const o = await this.load(uniqueId);
    if (!['ISSUED', 'ACKNOWLEDGED'].includes(o.status))
      throw new BadRequestException('errors.lpo_not_amendable');
    if (input.reason.trim().length < 5)
      throw new BadRequestException('errors.reason_required');
    const before = this.snapshot(o);
    const after: Snapshot = {
      deliveryDate:
        input.deliveryDate === undefined
          ? before.deliveryDate
          : input.deliveryDate || null,
      instructions:
        input.instructions === undefined
          ? before.instructions
          : input.instructions?.trim() || null,
      lines: before.lines.map((b) => {
        const n = input.lines.find((x) => x.lineNo === b.lineNo);
        return n
          ? {
              lineNo: b.lineNo,
              quantity: n.quantity,
              unitPrice: n.unitPrice,
              description: n.description?.trim() || b.description,
            }
          : b;
      }),
    };
    if (input.lines.some((n) => !o.lines.some((l) => l.lineNo === n.lineNo)))
      throw new BadRequestException('errors.amend_new_item');
    for (const l of o.lines) {
      const n = after.lines.find((x) => x.lineNo === l.lineNo)!;
      if (n.quantity < l.receivedQty - l.failedQty)
        throw new BadRequestException({
          message: 'errors.amend_below_received',
          args: { line: l.lineNo },
        });
      // Within the awarded tender line only: never above the awarded price or quantity.
      if (l.awardedQuantity != null && n.quantity > l.awardedQuantity)
        throw new BadRequestException({
          message: 'errors.amend_above_award_qty',
          args: { line: l.lineNo },
        });
      if (l.awardedUnitPrice != null && n.unitPrice > D(l.awardedUnitPrice))
        throw new BadRequestException({
          message: 'errors.amend_above_award_price',
          args: { line: l.lineNo },
        });
      if (n.quantity < 0 || n.unitPrice <= 0)
        throw new BadRequestException('errors.invalid_amount');
    }
    if (JSON.stringify(before) === JSON.stringify(after))
      throw new BadRequestException('errors.nothing_changed');
    const increases = total(after.lines) > total(before.lines);
    await this.prisma.db.$transaction(async (tx) => {
      // Revision numbers are never reused, even by rejected attempts.
      const a = await tx.purchaseOrderAmendment.create({
        data: {
          orderId: o.id,
          revision:
            Math.max(o.revision, ...o.amendments.map((x) => x.revision)) + 1,
          reason: input.reason.trim(),
          before: before as unknown as Prisma.InputJsonValue,
          after: after as unknown as Prisma.InputJsonValue,
          increasesValue: increases,
          createdById: actor.id,
        },
      });
      const req = await this.workflow.start(
        {
          pointCode: AMEND_POINT,
          subjectType: AMEND,
          subjectId: a.uniqueId,
          title: `Amend ${o.number} (rev ${a.revision})`,
          requesterUserId: actor.id,
          context: { increasesValue: increases, amount: total(after.lines) },
        },
        tx,
      );
      await tx.purchaseOrderAmendment.update({
        where: { id: a.id },
        data: { approvalRequestId: req.id },
      });
      await tx.purchaseOrder.update({
        where: { id: o.id },
        data: { status: 'AMENDMENT_PENDING' },
      });
      await this.audit.log(
        {
          action: 'LPO_AMENDMENT_PROPOSED',
          entityType: LPO,
          entityId: o.uniqueId,
          before,
          after: { ...after, reason: input.reason },
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  private async applyAmendment(amendmentId: number) {
    await this.prisma.db.$transaction(async (tx) => {
      const a = await tx.purchaseOrderAmendment.findUniqueOrThrow({
        where: { id: amendmentId },
      });
      const after = a.after as unknown as Snapshot;
      for (const l of after.lines) {
        await tx.purchaseOrderLine.updateMany({
          where: { orderId: a.orderId, lineNo: l.lineNo },
          data: {
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            description: l.description,
          },
        });
      }
      await tx.purchaseOrder.update({
        where: { id: a.orderId },
        data: {
          revision: a.revision,
          deliveryDate: day(after.deliveryDate),
          instructions: after.instructions,
        },
      });
      await tx.purchaseOrderAmendment.update({
        where: { id: a.id },
        data: { status: 'APPLIED', appliedAt: new Date() },
      });
      await tx.purchaseOrder.update({
        where: { id: a.orderId },
        data: { status: await this.receiptStatus(tx, a.orderId, true) },
      });
    });
  }

  /** Outstanding = ordered − (received − failed returned to vendor). */
  async receiptStatus(
    tx: DbTx,
    orderId: number,
    afterAmendment = false,
  ): Promise<PurchaseOrderStatus> {
    const o = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: true, amendments: true },
    });
    if (!afterAmendment && o.status === 'AMENDMENT_PENDING')
      return 'AMENDMENT_PENDING';
    if (
      o.amendments.some(
        (a) =>
          a.status === 'IN_APPROVAL' || a.status === 'AWAITING_ACKNOWLEDGEMENT',
      )
    )
      return 'AMENDMENT_PENDING';
    const all = o.lines.every((l) => l.passedQty >= l.quantity);
    const any = o.lines.some((l) => l.receivedQty > 0);
    if (all) return o.status === 'CLOSED' ? 'CLOSED' : 'RECEIVED';
    if (any) return 'PARTIALLY_RECEIVED';
    return o.acknowledgedAt || o.kind === 'CASH'
      ? o.kind === 'CASH'
        ? 'ISSUED'
        : 'ACKNOWLEDGED'
      : 'ISSUED';
  }

  // ── cancellation and re-award ───────────────────────────────────────────

  async requestCancel(
    actor: CurrentUser,
    uniqueId: string,
    reason: string,
    reaward: boolean,
  ) {
    const o = await this.load(uniqueId);
    if (o.status === 'DRAFT') {
      await this.prisma.db.$transaction(async (tx) => {
        await tx.purchaseOrder.update({
          where: { id: o.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelReason: reason.trim(),
          },
        });
      });
      return this.get(actor, uniqueId);
    }
    if (
      !['ISSUED', 'ACKNOWLEDGED'].includes(o.status) ||
      o.lines.some((l) => l.receivedQty > 0)
    )
      throw new BadRequestException('errors.lpo_not_cancellable');
    if (reason.trim().length < 5)
      throw new BadRequestException('errors.reason_required');
    if (o.cancelApprovalId)
      throw new BadRequestException('errors.already_pending');
    await this.prisma.db.$transaction(async (tx) => {
      const req = await this.workflow.start(
        {
          pointCode: CANCEL_POINT,
          subjectType: LPO,
          subjectId: o.uniqueId,
          title: `Cancel ${o.number}: ${reason.trim()}`,
          requesterUserId: actor.id,
        },
        tx,
      );
      await tx.purchaseOrder.update({
        where: { id: o.id },
        data: {
          cancelApprovalId: req.id,
          cancelReason: reason.trim(),
          reawardRequested: reaward,
        },
      });
    });
    return this.get(actor, uniqueId);
  }

  private async cancelApproved(
    o: PurchaseOrder & { lines: PurchaseOrderLine[] },
  ) {
    const reawarded: string[] = [];
    await this.prisma.db.$transaction(async (tx) => {
      await tx.purchaseOrder.update({
        where: { id: o.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await this.audit.log(
        {
          action: 'LPO_CANCELLED',
          entityType: LPO,
          entityId: o.uniqueId,
          after: { reason: o.cancelReason },
        },
        tx,
      );
      if (!o.tenderId) {
        await this.markRequestLines(tx, o, 'OPEN');
        return;
      }
      if (!o.reawardRequested) {
        await this.markRequestLines(tx, o, 'OPEN');
        return;
      }
      // Re-award each item to the next-ranked compliant offer of another vendor.
      const store = await this.mainStore(tx);
      const byVendor = new Map<
        number,
        {
          tl: { id: number; productId: number; productVersionId: number };
          bl: Prisma.BidLineGetPayload<object>;
          quantity: number;
        }[]
      >();
      const notReawarded: PurchaseOrderLine[] = [];
      for (const l of o.lines) {
        const tl = await tx.tenderLine.findUniqueOrThrow({
          where: { id: l.tenderLineId! },
        });
        const next = await tx.bidLine.findFirst({
          where: {
            tenderLineId: tl.id,
            compliant: true,
            bid: { vendorId: { not: o.vendorId! }, status: 'OPENED' },
            rank: { not: null },
          },
          include: { bid: true },
          orderBy: { rank: 'asc' },
        });
        if (!next) {
          notReawarded.push(l);
          continue;
        }
        await tx.tenderLine.update({
          where: { id: tl.id },
          data: {
            awardBidLineId: next.id,
            awardReason: `Re-awarded after cancellation of ${o.number}`,
          },
        });
        byVendor.set(next.bid.vendorId, [
          ...(byVendor.get(next.bid.vendorId) ?? []),
          { tl, bl: next, quantity: l.quantity },
        ]);
      }
      for (const [vendorId, items] of byVendor) {
        reawarded.push(
          await this.createOrder(
            tx,
            { id: o.createdById } as CurrentUser,
            o.tenderId,
            vendorId,
            store.id,
            items,
          ),
        );
      }
      if (notReawarded.length)
        await this.markRequestLines(tx, { ...o, lines: notReawarded }, 'OPEN');
    });
    if (o.vendorId) {
      const v = await this.prisma.db.vendor.findUniqueOrThrow({
        where: { id: o.vendorId },
      });
      await this.sourcing.vendorNotify(v.id, v.email, {
        type: 'LPO_CANCELLED',
        title: `LPO ${o.number} cancelled`,
        body: o.cancelReason ?? '',
      });
    }
    if (reawarded.length)
      this.logger.log(
        `${o.number} cancelled; re-award drafts: ${reawarded.length}`,
      );
  }

  // ── cash purchase (§4.7) ────────────────────────────────────────────────

  async recordCash(actor: CurrentUser, input: CashPurchaseInput) {
    if (!input.lines.length) throw new BadRequestException('errors.no_lines');
    if (!input.vendorUniqueId && !input.shopName?.trim())
      throw new BadRequestException('errors.shop_required');
    if (!input.receiptFileUniqueIds.length)
      throw new BadRequestException('errors.receipt_required');
    const prs = await this.prisma.db.purchaseRequest.findMany({
      where: {
        uniqueId: { in: input.lines.map((l) => l.purchaseRequestUniqueId) },
      },
      include: { lines: true },
    });
    const lines = input.lines.map((i) => {
      const pr = prs.find((p) => p.uniqueId === i.purchaseRequestUniqueId);
      const l = pr?.lines.find((x) => x.lineNo === i.lineNo);
      if (!pr || !l) throw new NotFoundException('errors.record_not_found');
      if (l.route !== 'CASH' || l.sourcingStatus !== 'OPEN')
        throw new BadRequestException('errors.line_not_cash');
      if (i.quantity <= 0 || i.quantity > l.quantity || i.unitPrice <= 0)
        throw new BadRequestException('errors.invalid_amount');
      return { l, i };
    });
    const vendor = input.vendorUniqueId
      ? await this.prisma.db.vendor.findUnique({
          where: { uniqueId: input.vendorUniqueId },
        })
      : null;
    const files = await this.prisma.db.file.findMany({
      where: { uniqueId: { in: input.receiptFileUniqueIds } },
    });
    const products = await this.prisma.db.product.findMany({
      where: { id: { in: lines.map((x) => x.l.productId) } },
    });
    const id = await this.prisma.db.$transaction(async (tx) => {
      const store = await this.mainStore(tx);
      const o = await tx.purchaseOrder.create({
        data: {
          number: await this.numbering.document('LPO', tx),
          kind: 'CASH',
          status: 'ISSUED',
          vendorId: vendor?.id ?? null,
          shopName: vendor ? null : input.shopName!.trim(),
          storeId: store.id,
          deliveryDate:
            day(input.purchaseDate) ?? day(new Date().toISOString()),
          receiptFileIds: files.map((f) => f.id),
          issuedAt: new Date(),
          issuedById: actor.id,
          createdById: actor.id,
          lines: {
            create: lines.map(({ l, i }, n) => ({
              lineNo: n + 1,
              purchaseRequestLineId: l.id,
              productId: l.productId,
              productVersionId: l.productVersionId,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              vatRate: D(
                products.find((p) => p.id === l.productId)?.vatRate ?? 18,
              ),
            })),
          },
        },
      });
      await tx.purchaseRequestLine.updateMany({
        where: { id: { in: lines.map((x) => x.l.id) } },
        data: { sourcingStatus: 'ORDERED' },
      });
      await this.audit.log(
        {
          action: 'CASH_PURCHASE_RECORDED',
          entityType: LPO,
          entityId: o.uniqueId,
          after: { number: o.number },
        },
        tx,
      );
      return o.uniqueId;
    });
    return this.get(actor, id);
  }

  private async notifyKeepers(
    storeId: number,
    input: Parameters<NotificationsService['notify']>[1],
  ) {
    const roles = await this.prisma.db.userRole.findMany({
      where: {
        contextType: 'STORE',
        contextId: storeId,
        role: { grants: { some: { permissionCode: 'stock.receive' } } },
        user: { status: 'ACTIVE' },
      },
      select: { userId: true },
    });
    for (const id of new Set(roles.map((r) => r.userId)))
      await this.notifications.notify(id, input);
  }

  /** Overdue deliveries flagged daily (08:00 EAT) to Purchasing. */
  @Cron('0 8 * * *', { timeZone: 'Africa/Dar_es_Salaam' })
  async overdue() {
    const today = day(new Date().toISOString())!;
    const rows = await this.prisma.db.purchaseOrder.findMany({
      where: {
        status: { in: RECEIVABLE },
        deliveryDate: { lt: today },
        kind: 'TENDER',
      },
    });
    if (!rows.length) return;
    const users = await this.access.usersWithPermission('lpo.create');
    for (const o of rows)
      for (const u of users)
        await this.notifications.notify(u, {
          titleKey: 'notifications.lpo_overdue_title',
          messageKey: 'notifications.lpo_overdue_message',
          params: {
            number: o.number,
            date: o.deliveryDate!.toISOString().slice(0, 10),
          },
          link: `/procurement/orders/${o.uniqueId}`,
        });
  }

  // ── queries ─────────────────────────────────────────────────────────────

  private async orderWhere(
    user: CurrentUser,
  ): Promise<Prisma.PurchaseOrderWhereInput> {
    const s = await this.access.resolveScope(user, 'lpo.view');
    if (s.all) return {};
    if (!s.departmentIds.length) return { id: -1 };
    const products = await this.prisma.db.product.findMany({
      where: { owningDepartmentId: { in: s.departmentIds } },
      select: { id: true },
    });
    return {
      lines: { some: { productId: { in: products.map((p) => p.id) } } },
    };
  }

  async list(
    user: CurrentUser,
    statuses?: PurchaseOrderStatus[],
    vendorId?: number,
  ) {
    const rows = await this.prisma.db.purchaseOrder.findMany({
      where: {
        AND: [
          vendorId
            ? { vendorId, status: { notIn: ['DRAFT', 'IN_APPROVAL'] } }
            : await this.orderWhere(user),
          statuses?.length ? { status: { in: statuses } } : {},
        ],
      },
      include: { lines: { orderBy: { lineNo: 'asc' } }, amendments: true },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return this.present(user, rows, !!vendorId);
  }

  async get(user: CurrentUser, uniqueId: string, vendorId?: number) {
    const o = await this.load(uniqueId);
    if (vendorId) {
      if (
        o.vendorId !== vendorId ||
        ['DRAFT', 'IN_APPROVAL'].includes(o.status)
      )
        throw new ForbiddenException('errors.forbidden');
    } else {
      const n = await this.prisma.db.purchaseOrder.count({
        where: { AND: [{ id: o.id }, await this.orderWhere(user)] },
      });
      if (!n) throw new ForbiddenException('errors.forbidden');
    }
    return (await this.present(user, [o], !!vendorId))[0];
  }

  async present(
    user: CurrentUser,
    rows: Prisma.PurchaseOrderGetPayload<{
      include: { lines: true; amendments: true };
    }>[],
    forVendor = false,
  ) {
    const lines = rows.flatMap((r) => r.lines);
    const [
      vendors,
      versions,
      products,
      tenders,
      stores,
      approvals,
      files,
      grns,
      invoices,
    ] = await Promise.all([
      this.prisma.db.vendor.findMany({
        where: {
          id: {
            in: rows.map((r) => r.vendorId).filter((x): x is number => !!x),
          },
        },
      }),
      this.prisma.db.productVersion.findMany({
        where: { id: { in: lines.map((l) => l.productVersionId) } },
      }),
      this.prisma.db.product.findMany({
        where: { id: { in: lines.map((l) => l.productId) } },
        include: { owningDepartment: true },
      }),
      this.prisma.db.tender.findMany({
        where: {
          id: {
            in: rows.map((r) => r.tenderId).filter((x): x is number => !!x),
          },
        },
      }),
      this.prisma.db.store.findMany({
        where: { id: { in: rows.map((r) => r.storeId) } },
      }),
      this.prisma.db.approvalRequest.findMany({
        where: {
          id: {
            in: [
              ...rows.flatMap((r) => [r.issueApprovalId, r.cancelApprovalId]),
              ...rows.flatMap((r) =>
                r.amendments.map((a) => a.approvalRequestId),
              ),
            ].filter((x): x is number => !!x),
          },
        },
      }),
      this.prisma.db.file.findMany({
        where: { id: { in: rows.flatMap((r) => r.receiptFileIds) } },
      }),
      this.prisma.db.grn.findMany({
        where: { orderId: { in: rows.map((r) => r.id) } },
        orderBy: { receivedAt: 'asc' },
      }),
      this.prisma.db.invoice.findMany({
        where: { orderId: { in: rows.map((r) => r.id) } },
      }),
    ]);
    const apB = new Map(approvals.map((a) => [a.id, a]));
    const [cIssue, cAmend, cCancel, cReceive, cInvoice] = forVendor
      ? [false, false, false, false, false]
      : await Promise.all([
          this.access.hasAny(user, 'lpo.issue'),
          this.access.hasAny(user, 'lpo.amend'),
          this.access.hasAny(user, 'lpo.cancel'),
          this.access.can(user, 'stock.receive', { storeId: rows[0]?.storeId }),
          this.access.hasAny(user, 'invoice.register'),
        ]);
    const today = day(new Date().toISOString())!;
    return rows.map((o) => {
      const v = o.vendorId
        ? vendors.find((x) => x.id === o.vendorId)
        : undefined;
      const ls = o.lines.map((l) => {
        const p = products.find((x) => x.id === l.productId)!;
        const ver = versions.find((x) => x.id === l.productVersionId)!;
        const price = D(l.unitPrice);
        const parts = vatParts(price * l.quantity, D(l.vatRate));
        return {
          lineNo: l.lineNo,
          productUniqueId: p.uniqueId,
          productCode: p.code,
          productName: ver.name,
          owningDepartment: p.owningDepartment.name,
          trackingType: p.trackingType,
          unit: ver.unit,
          description: l.description,
          brand: l.brand,
          model: l.model,
          quantity: l.quantity,
          unitPrice: price,
          vatRate: D(l.vatRate),
          lineTotal: round2(price * l.quantity),
          lineExclVat: parts.excl,
          lineVat: parts.vat,
          awardedUnitPrice:
            l.awardedUnitPrice == null ? null : D(l.awardedUnitPrice),
          awardedQuantity: l.awardedQuantity,
          receivedQty: l.receivedQty,
          passedQty: l.passedQty,
          failedQty: l.failedQty,
          outstandingQty: Math.max(0, l.quantity - l.receivedQty + l.failedQty),
        };
      });
      const totalIncl = round2(ls.reduce((n, l) => n + l.lineTotal, 0));
      const totalVat = round2(ls.reduce((n, l) => n + l.lineVat, 0));
      const pending = o.amendments.find(
        (a) =>
          a.status === 'IN_APPROVAL' || a.status === 'AWAITING_ACKNOWLEDGEMENT',
      );
      const anyReceived = o.lines.some((l) => l.receivedQty > 0);
      return {
        uniqueId: o.uniqueId,
        number: o.number,
        kind: o.kind,
        status: o.status,
        revision: o.revision,
        vendor: v
          ? {
              uniqueId: v.uniqueId,
              name: v.name,
              number: v.number,
              email: v.email,
              tin: v.tin,
              address: v.address,
            }
          : null,
        shopName: o.shopName,
        tender: o.tenderId
          ? (() => {
              const t = tenders.find((x) => x.id === o.tenderId)!;
              return { uniqueId: t.uniqueId, number: t.number, title: t.title };
            })()
          : null,
        store: (() => {
          const s = stores.find((x) => x.id === o.storeId)!;
          return { uniqueId: s.uniqueId, name: s.name, address: s.address };
        })(),
        deliveryDate: o.deliveryDate,
        overdue:
          !!o.deliveryDate &&
          o.deliveryDate < today &&
          RECEIVABLE.includes(o.status),
        instructions: o.instructions,
        issuedAt: o.issuedAt,
        acknowledgedAt: o.acknowledgedAt,
        acknowledgedBy: o.acknowledgedBy,
        cancelReason: o.cancelReason,
        cancelledAt: o.cancelledAt,
        createdAt: o.createdAt,
        totalInclVat: totalIncl,
        totalVat,
        totalExclVat: round2(totalIncl - totalVat),
        lines: ls,
        receipts: forVendor
          ? []
          : o.receiptFileIds
              .map((id) => files.find((f) => f.id === id))
              .filter((f) => !!f)
              .map((f) => ({
                uniqueId: f.uniqueId,
                filename: f.filename,
                uri: f.uri,
              })),
        approvalUniqueId:
          !forVendor && o.issueApprovalId
            ? (apB.get(o.issueApprovalId)?.uniqueId ?? null)
            : null,
        cancelApprovalUniqueId:
          !forVendor && o.cancelApprovalId
            ? (apB.get(o.cancelApprovalId)?.uniqueId ?? null)
            : null,
        amendments: o.amendments
          .filter(
            (a) =>
              !forVendor ||
              ['AWAITING_ACKNOWLEDGEMENT', 'APPLIED'].includes(a.status),
          )
          .map((a) => ({
            uniqueId: a.uniqueId,
            revision: a.revision,
            status: a.status,
            reason: a.reason,
            increasesValue: a.increasesValue,
            before: a.before as unknown as Snapshot,
            after: a.after as unknown as Snapshot,
            createdAt: a.createdAt,
            appliedAt: a.appliedAt,
            approvalUniqueId:
              !forVendor && a.approvalRequestId
                ? (apB.get(a.approvalRequestId)?.uniqueId ?? null)
                : null,
          })),
        grns: forVendor
          ? []
          : grns
              .filter((g) => g.orderId === o.id)
              .map((g) => ({
                uniqueId: g.uniqueId,
                number: g.number,
                status: g.status,
                receivedAt: g.receivedAt,
              })),
        invoices: forVendor
          ? []
          : invoices
              .filter((i) => i.orderId === o.id)
              .map((i) => ({
                uniqueId: i.uniqueId,
                vendorInvoiceNo: i.vendorInvoiceNo,
                status: i.status,
                amountInclVat: D(i.amountInclVat),
              })),
        can: {
          edit: cIssue && o.status === 'DRAFT',
          issue: cIssue && o.status === 'DRAFT',
          amend:
            cAmend && ['ISSUED', 'ACKNOWLEDGED'].includes(o.status) && !pending,
          cancel:
            cCancel &&
            (o.status === 'DRAFT' ||
              (['ISSUED', 'ACKNOWLEDGED'].includes(o.status) &&
                !anyReceived &&
                !o.cancelApprovalId)),
          receive: cReceive && RECEIVABLE.includes(o.status),
          registerInvoice:
            cInvoice &&
            o.kind === 'TENDER' &&
            [
              'ISSUED',
              'ACKNOWLEDGED',
              'AMENDMENT_PENDING',
              'PARTIALLY_RECEIVED',
              'RECEIVED',
            ].includes(o.status),
          acknowledge:
            forVendor &&
            (o.status === 'ISSUED' ||
              o.amendments.some(
                (a) => a.status === 'AWAITING_ACKNOWLEDGEMENT',
              )),
        },
      };
    });
  }
}
