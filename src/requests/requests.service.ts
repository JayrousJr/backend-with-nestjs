import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { InternalRequestStatus, Prisma, PurchaseRequestStatus } from '@db';
import { PrismaService, type DbTx } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  APPROVAL_COMPLETED,
  WorkflowService,
  type ApprovalCompletedEvent,
} from '../workflow/workflow.service';

const IR_POINT = 'internal_request.approval';
const PR_POINT = 'purchase_request.approval';
const IR = 'InternalRequest';
const PR = 'PurchaseRequest';

/** Emitted when an internal request is fully delivered (B3 §12 InternalRequestFulfilled). */
export const INTERNAL_REQUEST_FULFILLED = 'internal_request.fulfilled';

export interface CreateInternalRequest {
  departmentUniqueId?: string;
  beneficiaryEmployeeUniqueId?: string;
  productUniqueId: string;
  quantity: number;
  requiredBy?: string;
  justification: string;
  productionRef?: string;
}

export interface CreatePurchaseRequest {
  departmentUniqueId?: string;
  justification: string;
  lines: {
    productUniqueId: string;
    quantity: number;
    beneficiaryEmployeeUniqueId?: string;
    productionRef?: string;
    internalRequestUniqueId?: string;
    note?: string;
  }[];
}

const day = (s?: string | null) =>
  s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null;

/**
 * Requests (tender spec §6, store spec §7). HODs raise internal requests to
 * the product's owning department, for a named employee or the department.
 * The owning department accepts (fully or partly), then serves from a store
 * or raises a purchase request for the missing quantity. Purchase requests
 * contain only the owning department's products and go through
 * `purchase_request.approval` (CEO → Procurement → CEO). No budget (#1).
 */
@Injectable()
export class RequestsService implements OnModuleInit {
  private readonly logger = new Logger(RequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    // A request may reference a submitted product but cannot be approved until it is Active.
    this.workflow.registerGuard(IR_POINT, async (_actor, request, d) => {
      if (d.decision !== 'APPROVE') return;
      const ir = await this.prisma.db.internalRequest.findUnique({
        where: { uniqueId: request.subjectId },
      });
      const p =
        ir &&
        (await this.prisma.db.product.findUnique({
          where: { id: ir.productId },
        }));
      if (p && p.status !== 'ACTIVE')
        throw new BadRequestException('errors.product_not_active');
    });
    this.workflow.registerGuard(PR_POINT, async (_actor, request, d) => {
      if (d.decision !== 'APPROVE' || !d.lastStep) return;
      const pr = await this.prisma.db.purchaseRequest.findUnique({
        where: { uniqueId: request.subjectId },
        include: { lines: true },
      });
      const products = await this.prisma.db.product.findMany({
        where: { id: { in: pr?.lines.map((l) => l.productId) ?? [] } },
      });
      if (products.some((p) => p.status !== 'ACTIVE')) {
        throw new BadRequestException('errors.product_not_active');
      }
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async department(actor: CurrentUser, uniqueId?: string) {
    const d = uniqueId
      ? await this.prisma.db.department.findUnique({ where: { uniqueId } })
      : await this.prisma.db.department.findUnique({
          where: { id: actor.departmentId },
        });
    if (!d || !d.isActive)
      throw new BadRequestException('errors.department_not_found');
    return d;
  }

  private async deptTree(id: number) {
    const children = await this.prisma.db.department.findMany({
      where: { parentId: id },
      select: { id: true },
    });
    return [id, ...children.map((c) => c.id)];
  }

  private async loadIr(uniqueId: string, tx?: DbTx) {
    const r = await (tx ?? this.prisma.db).internalRequest.findUnique({
      where: { uniqueId },
    });
    if (!r) throw new NotFoundException('errors.record_not_found');
    const product = await (tx ?? this.prisma.db).product.findUniqueOrThrow({
      where: { id: r.productId },
    });
    return { r, product };
  }

  // ── internal requests ────────────────────────────────────────────────────

  async createInternal(actor: CurrentUser, input: CreateInternalRequest) {
    const dept = await this.department(actor, input.departmentUniqueId);
    await this.access.assert(actor, 'internal_request.create', {
      departmentId: dept.id,
    });
    const product = await this.prisma.db.product.findUnique({
      where: { uniqueId: input.productUniqueId },
      include: {
        currentVersion: true,
        versions: { orderBy: { version: 'desc' }, take: 1 },
      },
    });
    if (
      !product ||
      !['ACTIVE', 'SUBMITTED', 'IN_REVIEW'].includes(product.status)
    ) {
      throw new BadRequestException('errors.request_product');
    }
    let employeeId: number | null = null;
    if (input.beneficiaryEmployeeUniqueId) {
      const e = await this.prisma.db.employee.findUnique({
        where: { uniqueId: input.beneficiaryEmployeeUniqueId },
      });
      const tree = await this.deptTree(dept.id);
      if (!e || e.status === 'EXITED' || !tree.includes(e.departmentId)) {
        throw new BadRequestException('errors.request_beneficiary');
      }
      employeeId = e.id;
    }
    if (input.quantity < 1)
      throw new BadRequestException('errors.request_quantity');
    const version = product.currentVersion ?? product.versions[0];
    const r = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.numbering.document('IR', tx);
      const ir = await tx.internalRequest.create({
        data: {
          number,
          requestingDepartmentId: dept.id,
          beneficiaryEmployeeId: employeeId,
          productId: product.id,
          productVersionId: version.id,
          quantity: input.quantity,
          requiredBy: day(input.requiredBy),
          justification: input.justification.trim(),
          productionRef: input.productionRef?.trim() || null,
          createdByUserId: actor.id,
        },
      });
      await this.audit.log(
        {
          action: 'internal_request.create',
          entityType: IR,
          entityId: number,
          after: {
            product: product.code,
            quantity: input.quantity,
            beneficiary: employeeId,
          },
        },
        tx,
      );
      return ir;
    });
    return this.getInternal(actor, r.uniqueId);
  }

  async updateInternal(
    actor: CurrentUser,
    uniqueId: string,
    input: { quantity: number; requiredBy?: string; justification: string },
  ) {
    const { r } = await this.loadIr(uniqueId);
    if (r.status !== 'DRAFT' && r.status !== 'RETURNED')
      throw new BadRequestException('errors.request_status');
    await this.access.assert(actor, 'internal_request.create', {
      departmentId: r.requestingDepartmentId,
    });
    if (input.quantity < 1)
      throw new BadRequestException('errors.request_quantity');
    await this.prisma.db.$transaction(async (tx) => {
      await tx.internalRequest.update({
        where: { id: r.id },
        data: {
          quantity: input.quantity,
          requiredBy: day(input.requiredBy),
          justification: input.justification.trim(),
        },
      });
      await this.audit.log(
        {
          action: 'internal_request.update',
          entityType: IR,
          entityId: r.number,
          before: r,
          after: input,
        },
        tx,
      );
    });
    return this.getInternal(actor, uniqueId);
  }

  async submitInternal(actor: CurrentUser, uniqueId: string) {
    const { r, product } = await this.loadIr(uniqueId);
    if (r.status !== 'DRAFT' && r.status !== 'RETURNED')
      throw new BadRequestException('errors.request_status');
    await this.access.assert(actor, 'internal_request.submit', {
      departmentId: r.requestingDepartmentId,
    });
    const ownProduct = (
      await this.deptTree(product.owningDepartmentId)
    ).includes(r.requestingDepartmentId);
    const dept = await this.prisma.db.department.findUniqueOrThrow({
      where: { id: r.requestingDepartmentId },
    });
    await this.prisma.db.$transaction(async (tx) => {
      if (ownProduct) {
        // The requesting department owns the product: no acceptance step.
        if (product.status !== 'ACTIVE')
          throw new BadRequestException('errors.product_not_active');
        await tx.internalRequest.update({
          where: { id: r.id },
          data: {
            status: 'ACCEPTED',
            submittedAt: new Date(),
            acceptedAt: new Date(),
            acceptedQty: r.quantity,
          },
        });
      } else {
        await tx.internalRequest.update({
          where: { id: r.id },
          data: {
            status: 'SUBMITTED',
            submittedAt: new Date(),
            acceptedQty: null,
            acceptNote: null,
          },
        });
        const req = await this.workflow.start(
          {
            pointCode: IR_POINT,
            subjectType: IR,
            subjectId: r.uniqueId,
            subjectDepartmentId: product.owningDepartmentId,
            title: `Internal request ${r.number} from ${dept.name}: ${r.quantity} × ${product.code ?? ''}`,
            requesterUserId: actor.id,
            context: { quantity: r.quantity, requestingDepartment: dept.code },
          },
          tx,
        );
        await tx.internalRequest.update({
          where: { id: r.id },
          data: { approvalRequestId: req.id },
        });
      }
      await this.audit.log(
        {
          action: 'internal_request.submit',
          entityType: IR,
          entityId: r.number,
          after: { ownProduct },
        },
        tx,
      );
    });
    return this.getInternal(actor, uniqueId);
  }

  /** Owning department accepts, fully or partly (reason required for partial). */
  async acceptInternal(
    actor: CurrentUser,
    uniqueId: string,
    quantity: number,
    note?: string,
  ) {
    const { r } = await this.loadIr(uniqueId);
    if (r.status !== 'SUBMITTED' || !r.approvalRequestId)
      throw new BadRequestException('errors.request_status');
    if (quantity < 1 || quantity > r.quantity)
      throw new BadRequestException('errors.request_quantity');
    if (quantity < r.quantity && !note?.trim())
      throw new BadRequestException('errors.reason_required');
    const req = await this.prisma.db.approvalRequest.findUniqueOrThrow({
      where: { id: r.approvalRequestId },
    });
    await this.prisma.db.internalRequest.update({
      where: { id: r.id },
      data: { acceptedQty: quantity, acceptNote: note?.trim() || null },
    });
    try {
      await this.workflow.decide(
        actor,
        req.uniqueId,
        'APPROVE',
        quantity < r.quantity
          ? `Accepted ${quantity} of ${r.quantity}: ${note}`
          : note?.trim() || undefined,
      );
    } catch (error) {
      await this.prisma.db.internalRequest.update({
        where: { id: r.id },
        data: { acceptedQty: null, acceptNote: null },
      });
      throw error;
    }
    return this.getInternal(actor, uniqueId);
  }

  /** Owning department: how much comes from a store, how much is bought. */
  async planInternal(
    actor: CurrentUser,
    uniqueId: string,
    input: {
      storeUniqueId?: string;
      fromStoreQty: number;
      toPurchaseQty: number;
    },
  ) {
    const { r, product } = await this.loadIr(uniqueId);
    if (r.status !== 'ACCEPTED')
      throw new BadRequestException('errors.request_status');
    await this.access.assert(actor, 'internal_request.fulfil', {
      departmentId: product.owningDepartmentId,
    });
    const accepted = r.acceptedQty ?? r.quantity;
    if (
      input.fromStoreQty < 0 ||
      input.toPurchaseQty < 0 ||
      input.fromStoreQty + input.toPurchaseQty !== accepted
    ) {
      throw new BadRequestException({
        message: 'errors.request_plan',
        args: { n: accepted },
      });
    }
    const store = input.storeUniqueId
      ? await this.prisma.db.store.findUnique({
          where: { uniqueId: input.storeUniqueId },
        })
      : null;
    if (input.fromStoreQty > 0 && !store)
      throw new BadRequestException('errors.store_required');
    const status: InternalRequestStatus =
      input.toPurchaseQty > 0 ? 'IN_PURCHASE' : 'FULFILLED_FROM_STORE';
    await this.prisma.db.$transaction(async (tx) => {
      await tx.internalRequest.update({
        where: { id: r.id },
        data: {
          status,
          storeId: store?.id ?? null,
          fromStoreQty: input.fromStoreQty,
          toPurchaseQty: input.toPurchaseQty,
        },
      });
      await this.audit.log(
        {
          action: 'internal_request.plan',
          entityType: IR,
          entityId: r.number,
          after: { ...input, status },
        },
        tx,
      );
    });
    if (store && input.fromStoreQty > 0) {
      const keepers = await this.prisma.db.userRole.findMany({
        where: {
          contextType: 'STORE',
          contextId: store.id,
          user: { status: 'ACTIVE' },
          role: {
            grants: {
              some: {
                permissionCode: { in: ['stock.issue', 'handover.prepare'] },
              },
            },
          },
        },
        select: { userId: true },
      });
      for (const userId of new Set(keepers.map((k) => k.userId))) {
        await this.notifications.notify(userId, {
          titleKey: 'notifications.request_to_deliver_title',
          messageKey: 'notifications.request_to_deliver_message',
          params: {
            number: r.number,
            quantity: input.fromStoreQty,
            product: product.code ?? '',
          },
          link: `/requests/internal/${r.uniqueId}`,
        });
      }
    }
    return this.getInternal(actor, uniqueId);
  }

  /**
   * Delivery from the store (issue voucher or handover) against the request.
   * Called inside the delivering transaction.
   */
  async recordDelivery(
    tx: DbTx,
    internalRequestId: number,
    productId: number,
    qty: number,
  ) {
    const r = await tx.internalRequest.findUniqueOrThrow({
      where: { id: internalRequestId },
    });
    if (r.productId !== productId)
      throw new BadRequestException('errors.request_delivery_product');
    if (!['FULFILLED_FROM_STORE', 'IN_PURCHASE'].includes(r.status)) {
      throw new BadRequestException('errors.request_status');
    }
    const accepted = r.acceptedQty ?? r.quantity;
    const delivered = r.deliveredQty + qty;
    if (delivered > accepted)
      throw new BadRequestException('errors.request_delivery_too_many');
    await tx.internalRequest.update({
      where: { id: r.id },
      data: {
        deliveredQty: delivered,
        ...(delivered >= accepted ? { status: 'DELIVERED' } : {}),
      },
    });
    if (delivered >= accepted) {
      await this.notifications.notify(r.createdByUserId, {
        type: 'SUCCESS',
        titleKey: 'notifications.request_delivered_title',
        messageKey: 'notifications.request_delivered_message',
        params: { number: r.number },
        link: `/requests/internal/${r.uniqueId}`,
      });
    }
    return r;
  }

  /** Undo a delivery (handover cancelled before acknowledgement). */
  async reverseDelivery(tx: DbTx, internalRequestId: number, qty: number) {
    const r = await tx.internalRequest.findUniqueOrThrow({
      where: { id: internalRequestId },
    });
    const delivered = Math.max(r.deliveredQty - qty, 0);
    await tx.internalRequest.update({
      where: { id: r.id },
      data: {
        deliveredQty: delivered,
        ...(r.status === 'DELIVERED'
          ? {
              status:
                r.toPurchaseQty > 0 ? 'IN_PURCHASE' : 'FULFILLED_FROM_STORE',
            }
          : {}),
      },
    });
  }

  async closeInternal(actor: CurrentUser, uniqueId: string) {
    const { r } = await this.loadIr(uniqueId);
    if (r.status !== 'DELIVERED')
      throw new BadRequestException('errors.request_status');
    await this.access.assert(actor, 'internal_request.create', {
      departmentId: r.requestingDepartmentId,
    });
    await this.prisma.db.$transaction(async (tx) => {
      await tx.internalRequest.update({
        where: { id: r.id },
        data: { status: 'CLOSED' },
      });
      await this.audit.log(
        {
          action: 'internal_request.close',
          entityType: IR,
          entityId: r.number,
        },
        tx,
      );
    });
    return this.getInternal(actor, uniqueId);
  }

  async cancelInternal(actor: CurrentUser, uniqueId: string, reason: string) {
    const { r } = await this.loadIr(uniqueId);
    if (
      ![
        'DRAFT',
        'SUBMITTED',
        'RETURNED',
        'ACCEPTED',
        'FULFILLED_FROM_STORE',
        'IN_PURCHASE',
      ].includes(r.status) ||
      r.deliveredQty > 0
    ) {
      throw new BadRequestException('errors.request_status');
    }
    await this.access.assert(actor, 'internal_request.cancel', {
      departmentId: r.requestingDepartmentId,
    });
    if (!reason?.trim())
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      await tx.internalRequest.update({
        where: { id: r.id },
        data: { status: 'CANCELLED' },
      });
      if (r.status === 'SUBMITTED' && r.approvalRequestId) {
        await this.workflow.cancel(r.approvalRequestId, reason, tx);
      }
      await this.audit.log(
        {
          action: 'internal_request.cancel',
          entityType: IR,
          entityId: r.number,
          after: { reason },
        },
        tx,
      );
    });
    return this.getInternal(actor, uniqueId);
  }

  // ── purchase requests ────────────────────────────────────────────────────

  async createPurchase(actor: CurrentUser, input: CreatePurchaseRequest) {
    const dept = await this.department(actor, input.departmentUniqueId);
    await this.access.assert(actor, 'purchase_request.create', {
      departmentId: dept.id,
    });
    const tree = await this.deptTree(dept.id);
    if (!input.lines.length)
      throw new BadRequestException('errors.request_quantity');
    const lines: Prisma.PurchaseRequestLineCreateWithoutPurchaseRequestInput[] =
      [];
    for (const [i, l] of input.lines.entries()) {
      const fail = (m: string) =>
        new BadRequestException({ message: m, args: { line: i + 1 } });
      const p = await this.prisma.db.product.findUnique({
        where: { uniqueId: l.productUniqueId },
        include: {
          currentVersion: true,
          versions: { orderBy: { version: 'desc' }, take: 1 },
        },
      });
      if (
        !p ||
        !tree.includes(p.owningDepartmentId) ||
        !['ACTIVE', 'SUBMITTED', 'IN_REVIEW'].includes(p.status)
      ) {
        throw fail('errors.purchase_line_product');
      }
      if (l.quantity < 1) throw fail('errors.request_quantity');
      let ir: {
        id: number;
        beneficiaryEmployeeId: number | null;
        requestingDepartmentId: number;
        productionRef: string | null;
      } | null = null;
      if (l.internalRequestUniqueId) {
        const found = await this.prisma.db.internalRequest.findUnique({
          where: { uniqueId: l.internalRequestUniqueId },
          include: { purchaseLines: { include: { purchaseRequest: true } } },
        });
        const linked =
          found?.purchaseLines
            .filter(
              (x) =>
                !['CANCELLED', 'REJECTED'].includes(x.purchaseRequest.status),
            )
            .reduce((n, x) => n + x.quantity, 0) ?? 0;
        if (
          !found ||
          found.status !== 'IN_PURCHASE' ||
          found.productId !== p.id ||
          l.quantity > found.toPurchaseQty - linked
        ) {
          throw fail('errors.purchase_line_internal');
        }
        ir = found;
      }
      let employeeId = ir?.beneficiaryEmployeeId ?? null;
      if (!ir && l.beneficiaryEmployeeUniqueId) {
        const e = await this.prisma.db.employee.findUnique({
          where: { uniqueId: l.beneficiaryEmployeeUniqueId },
        });
        if (!e) throw fail('errors.request_beneficiary');
        employeeId = e.id;
      }
      lines.push({
        lineNo: i + 1,
        productId: p.id,
        productVersionId: (p.currentVersion ?? p.versions[0]).id,
        quantity: l.quantity,
        beneficiaryEmployeeId: employeeId,
        beneficiaryDepartmentId:
          ir?.requestingDepartmentId ?? (employeeId ? null : dept.id),
        productionRef: ir?.productionRef ?? (l.productionRef?.trim() || null),
        internalRequest: ir ? { connect: { id: ir.id } } : undefined,
        note: l.note?.trim() || null,
      });
    }
    const pr = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.numbering.document('REQ', tx);
      const x = await tx.purchaseRequest.create({
        data: {
          number,
          departmentId: dept.id,
          justification: input.justification.trim(),
          createdByUserId: actor.id,
          lines: { create: lines },
        },
      });
      await this.audit.log(
        {
          action: 'purchase_request.create',
          entityType: PR,
          entityId: number,
          after: { lines: lines.length },
        },
        tx,
      );
      return x;
    });
    return this.getPurchase(actor, pr.uniqueId);
  }

  async submitPurchase(actor: CurrentUser, uniqueId: string) {
    const pr = await this.prisma.db.purchaseRequest.findUnique({
      where: { uniqueId },
      include: { lines: true },
    });
    if (!pr) throw new NotFoundException('errors.record_not_found');
    if (pr.status !== 'DRAFT' && pr.status !== 'RETURNED')
      throw new BadRequestException('errors.request_status');
    await this.access.assert(actor, 'purchase_request.submit', {
      departmentId: pr.departmentId,
    });
    const dept = await this.prisma.db.department.findUniqueOrThrow({
      where: { id: pr.departmentId },
    });
    await this.prisma.db.$transaction(async (tx) => {
      await tx.purchaseRequest.update({
        where: { id: pr.id },
        data: { status: 'IN_APPROVAL', submittedAt: new Date() },
      });
      const req = await this.workflow.start(
        {
          pointCode: PR_POINT,
          subjectType: PR,
          subjectId: pr.uniqueId,
          subjectDepartmentId: pr.departmentId,
          title: `Purchase request ${pr.number} — ${dept.name} (${pr.lines.length} lines)`,
          requesterUserId: actor.id,
          context: { department: dept.code, lines: pr.lines.length },
        },
        tx,
      );
      await tx.purchaseRequest.update({
        where: { id: pr.id },
        data: { approvalRequestId: req.id },
      });
      await this.audit.log(
        {
          action: 'purchase_request.submit',
          entityType: PR,
          entityId: pr.number,
        },
        tx,
      );
    });
    return this.getPurchase(actor, uniqueId);
  }

  async cancelPurchase(actor: CurrentUser, uniqueId: string, reason: string) {
    const pr = await this.prisma.db.purchaseRequest.findUnique({
      where: { uniqueId },
    });
    if (!pr) throw new NotFoundException('errors.record_not_found');
    if (!['DRAFT', 'RETURNED', 'IN_APPROVAL'].includes(pr.status))
      throw new BadRequestException('errors.request_status');
    await this.access.assert(actor, 'purchase_request.cancel', {
      departmentId: pr.departmentId,
    });
    if (!reason?.trim())
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      await tx.purchaseRequest.update({
        where: { id: pr.id },
        data: { status: 'CANCELLED' },
      });
      if (pr.status === 'IN_APPROVAL' && pr.approvalRequestId) {
        await this.workflow.cancel(pr.approvalRequestId, reason, tx);
      }
      await this.audit.log(
        {
          action: 'purchase_request.cancel',
          entityType: PR,
          entityId: pr.number,
          after: { reason },
        },
        tx,
      );
    });
    return this.getPurchase(actor, uniqueId);
  }

  // ── workflow events ──────────────────────────────────────────────────────

  @OnEvent(APPROVAL_COMPLETED, { async: true })
  async onCompleted(e: ApprovalCompletedEvent) {
    if (e.pointCode === IR_POINT && e.subjectType === IR) {
      const map: Record<
        ApprovalCompletedEvent['status'],
        InternalRequestStatus
      > = {
        APPROVED: 'ACCEPTED',
        REJECTED: 'REJECTED',
        RETURNED: 'RETURNED',
        CANCELLED: 'CANCELLED',
      };
      const r = await this.prisma.db.internalRequest.findUnique({
        where: { uniqueId: e.subjectId },
      });
      if (!r || r.status !== 'SUBMITTED') return;
      await this.prisma.db.internalRequest.update({
        where: { id: r.id },
        data: {
          status: map[e.status],
          ...(e.status === 'APPROVED'
            ? {
                acceptedQty: r.acceptedQty ?? r.quantity,
                acceptedAt: new Date(),
              }
            : {}),
        },
      });
    } else if (e.pointCode === PR_POINT && e.subjectType === PR) {
      const map: Record<
        ApprovalCompletedEvent['status'],
        PurchaseRequestStatus
      > = {
        APPROVED: 'APPROVED',
        REJECTED: 'REJECTED',
        RETURNED: 'RETURNED',
        CANCELLED: 'CANCELLED',
      };
      await this.prisma.db.purchaseRequest.updateMany({
        where: { uniqueId: e.subjectId, status: 'IN_APPROVAL' },
        data: { status: map[e.status], decidedAt: new Date() },
      });
    }
  }

  // ── queries ──────────────────────────────────────────────────────────────

  private async irWhere(
    user: CurrentUser,
  ): Promise<Prisma.InternalRequestWhereInput> {
    const s = await this.access.resolveScope(user, 'internal_request.view');
    if (s.all) return {};
    const or: Prisma.InternalRequestWhereInput[] = [
      { createdByUserId: user.id },
    ];
    if (s.departmentIds.length) {
      or.push(
        { requestingDepartmentId: { in: s.departmentIds } },
        {
          productId: {
            in: (
              await this.prisma.db.product.findMany({
                where: { owningDepartmentId: { in: s.departmentIds } },
                select: { id: true },
              })
            ).map((p) => p.id),
          },
        },
      );
    }
    if (s.ownRecords && user.employeeId)
      or.push({ beneficiaryEmployeeId: user.employeeId });
    // Approvers reach the request from their inbox.
    const tasks = await this.prisma.db.approvalAssignment.findMany({
      where: { userId: user.id },
      select: { requestId: true },
    });
    if (tasks.length)
      or.push({ approvalRequestId: { in: tasks.map((t) => t.requestId) } });
    return { OR: or };
  }

  async listInternal(
    user: CurrentUser,
    filter: {
      view?: 'mine' | 'owning' | 'deliver' | 'all';
      statuses?: InternalRequestStatus[];
    } = {},
  ) {
    const and: Prisma.InternalRequestWhereInput[] = [await this.irWhere(user)];
    const own = await this.access.resolveScope(user, 'internal_request.create');
    const fulfil = await this.access.resolveScope(
      user,
      'internal_request.fulfil',
    );
    if (filter.view === 'mine') {
      and.push({
        OR: [
          { createdByUserId: user.id },
          { requestingDepartmentId: { in: own.departmentIds } },
        ],
      });
    } else if (filter.view === 'owning') {
      const ids = (
        await this.prisma.db.product.findMany({
          where: { owningDepartmentId: { in: fulfil.departmentIds } },
          select: { id: true },
        })
      ).map((p) => p.id);
      and.push({ productId: { in: ids } });
    } else if (filter.view === 'deliver') {
      const stores = [
        ...(await this.access.resolveScope(user, 'stock.issue')).storeIds,
        ...(await this.access.resolveScope(user, 'handover.prepare')).storeIds,
      ];
      and.push({
        status: { in: ['FULFILLED_FROM_STORE', 'IN_PURCHASE'] },
        fromStoreQty: { gt: 0 },
        ...(stores.length ? { storeId: { in: stores } } : {}),
      });
    }
    if (filter.statuses?.length) and.push({ status: { in: filter.statuses } });
    const rows = await this.prisma.db.internalRequest.findMany({
      where: { AND: and },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const list = await this.presentInternal(user, rows);
    return filter.view === 'deliver'
      ? list.filter((r) => r.deliveredQty < r.fromStoreQty)
      : list;
  }

  async getInternal(user: CurrentUser, uniqueId: string) {
    const { r } = await this.loadIr(uniqueId);
    const n = await this.prisma.db.internalRequest.count({
      where: { AND: [{ id: r.id }, await this.irWhere(user)] },
    });
    if (!n) throw new ForbiddenException('errors.forbidden');
    return (await this.presentInternal(user, [r]))[0];
  }

  private async presentInternal(
    user: CurrentUser,
    rows: Prisma.InternalRequestGetPayload<object>[],
  ) {
    const ids = <T>(f: (r: (typeof rows)[number]) => T | null) => [
      ...new Set(rows.map(f).filter((x): x is T => x != null)),
    ];
    const [products, depts, emps, stores, reqs, users] = await Promise.all([
      this.prisma.db.product.findMany({
        where: { id: { in: ids((r) => r.productId) } },
        include: { owningDepartment: true, currentVersion: true },
      }),
      this.prisma.db.department.findMany({
        where: { id: { in: ids((r) => r.requestingDepartmentId) } },
      }),
      this.prisma.db.employee.findMany({
        where: { id: { in: ids((r) => r.beneficiaryEmployeeId) } },
      }),
      this.prisma.db.store.findMany({
        where: { id: { in: ids((r) => r.storeId) } },
      }),
      this.prisma.db.approvalRequest.findMany({
        where: { id: { in: ids((r) => r.approvalRequestId) } },
        select: { id: true, uniqueId: true },
      }),
      this.prisma.dbRaw.user.findMany({
        where: { id: { in: ids((r) => r.createdByUserId) } },
        include: { employee: true },
      }),
    ]);
    const versions = await this.prisma.db.productVersion.findMany({
      where: { id: { in: ids((r) => r.productVersionId) } },
    });
    const by = <T extends { id: number }>(l: T[]) =>
      new Map(l.map((x) => [x.id, x]));
    const [pB, dB, eB, sB, rB, uB, vB] = [
      by(products),
      by(depts),
      by(emps),
      by(stores),
      by(reqs),
      by(users),
      by(versions),
    ];
    return Promise.all(
      rows.map(async (r) => {
        const p = pB.get(r.productId)!;
        const e = r.beneficiaryEmployeeId
          ? eB.get(r.beneficiaryEmployeeId)
          : undefined;
        const s = r.storeId ? sB.get(r.storeId) : undefined;
        const u = uB.get(r.createdByUserId);
        const [create, cancel, fulfil, prCreate] = await Promise.all([
          this.access.can(user, 'internal_request.create', {
            departmentId: r.requestingDepartmentId,
          }),
          this.access.can(user, 'internal_request.cancel', {
            departmentId: r.requestingDepartmentId,
          }),
          this.access.can(user, 'internal_request.fulfil', {
            departmentId: p.owningDepartmentId,
          }),
          this.access.can(user, 'purchase_request.create', {
            departmentId: p.owningDepartmentId,
          }),
        ]);
        const assigned = r.approvalRequestId
          ? (await this.prisma.db.approvalAssignment.count({
              where: {
                requestId: r.approvalRequestId,
                userId: user.id,
                active: true,
              },
            })) > 0
          : false;
        return {
          uniqueId: r.uniqueId,
          number: r.number,
          status: r.status,
          requestingDepartment: {
            uniqueId: dB.get(r.requestingDepartmentId)!.uniqueId,
            code: dB.get(r.requestingDepartmentId)!.code,
            name: dB.get(r.requestingDepartmentId)!.name,
          },
          owningDepartment: {
            uniqueId: p.owningDepartment.uniqueId,
            code: p.owningDepartment.code,
            name: p.owningDepartment.name,
          },
          beneficiary: e
            ? {
                uniqueId: e.uniqueId,
                employeeNumber: e.employeeNumber,
                fullName: `${e.firstName} ${e.lastName}`,
                companyEmail: e.companyEmail,
              }
            : null,
          product: {
            uniqueId: p.uniqueId,
            code: p.code,
            name:
              vB.get(r.productVersionId)?.name ?? p.currentVersion?.name ?? '—',
            unit: p.currentVersion?.unit ?? '',
            trackingType: p.trackingType,
            status: p.status,
          },
          quantity: r.quantity,
          requiredBy: r.requiredBy,
          justification: r.justification,
          productionRef: r.productionRef,
          createdBy: u ? `${u.employee.firstName} ${u.employee.lastName}` : '—',
          createdAt: r.createdAt,
          submittedAt: r.submittedAt,
          acceptedAt: r.acceptedAt,
          acceptedQty: r.acceptedQty,
          acceptNote: r.acceptNote,
          store: s
            ? { uniqueId: s.uniqueId, code: s.code, name: s.name }
            : null,
          fromStoreQty: r.fromStoreQty,
          toPurchaseQty: r.toPurchaseQty,
          deliveredQty: r.deliveredQty,
          approvalRequestUniqueId: r.approvalRequestId
            ? (rB.get(r.approvalRequestId)?.uniqueId ?? null)
            : null,
          can: {
            edit: create && (r.status === 'DRAFT' || r.status === 'RETURNED'),
            submit: create && (r.status === 'DRAFT' || r.status === 'RETURNED'),
            accept: assigned && r.status === 'SUBMITTED',
            plan: fulfil && r.status === 'ACCEPTED',
            purchase: prCreate && r.status === 'IN_PURCHASE',
            close: create && r.status === 'DELIVERED',
            cancel:
              cancel &&
              r.deliveredQty === 0 &&
              [
                'DRAFT',
                'SUBMITTED',
                'RETURNED',
                'ACCEPTED',
                'FULFILLED_FROM_STORE',
                'IN_PURCHASE',
              ].includes(r.status),
          },
        };
      }),
    );
  }

  private async prWhere(
    user: CurrentUser,
  ): Promise<Prisma.PurchaseRequestWhereInput> {
    const s = await this.access.resolveScope(user, 'purchase_request.view');
    if (s.all) return {};
    const or: Prisma.PurchaseRequestWhereInput[] = [
      { createdByUserId: user.id },
    ];
    if (s.departmentIds.length)
      or.push({ departmentId: { in: s.departmentIds } });
    const tasks = await this.prisma.db.approvalAssignment.findMany({
      where: { userId: user.id },
      select: { requestId: true },
    });
    if (tasks.length)
      or.push({ approvalRequestId: { in: tasks.map((t) => t.requestId) } });
    return { OR: or };
  }

  async listPurchase(user: CurrentUser, statuses?: PurchaseRequestStatus[]) {
    const rows = await this.prisma.db.purchaseRequest.findMany({
      where: {
        AND: [
          await this.prWhere(user),
          statuses?.length ? { status: { in: statuses } } : {},
        ],
      },
      include: { lines: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.presentPurchase(user, rows);
  }

  async getPurchase(user: CurrentUser, uniqueId: string) {
    const pr = await this.prisma.db.purchaseRequest.findUnique({
      where: { uniqueId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!pr) throw new NotFoundException('errors.record_not_found');
    const n = await this.prisma.db.purchaseRequest.count({
      where: { AND: [{ id: pr.id }, await this.prWhere(user)] },
    });
    if (!n) throw new ForbiddenException('errors.forbidden');
    return (await this.presentPurchase(user, [pr]))[0];
  }

  private async presentPurchase(
    user: CurrentUser,
    rows: Prisma.PurchaseRequestGetPayload<{ include: { lines: true } }>[],
  ) {
    const lines = rows.flatMap((r) => r.lines);
    const [depts, products, versions, emps, irs, reqs, users] =
      await Promise.all([
        this.prisma.db.department.findMany({
          where: {
            id: {
              in: [
                ...rows.map((r) => r.departmentId),
                ...lines
                  .map((l) => l.beneficiaryDepartmentId)
                  .filter((x): x is number => !!x),
              ],
            },
          },
        }),
        this.prisma.db.product.findMany({
          where: { id: { in: lines.map((l) => l.productId) } },
          include: { currentVersion: true },
        }),
        this.prisma.db.productVersion.findMany({
          where: { id: { in: lines.map((l) => l.productVersionId) } },
        }),
        this.prisma.db.employee.findMany({
          where: {
            id: {
              in: lines
                .map((l) => l.beneficiaryEmployeeId)
                .filter((x): x is number => !!x),
            },
          },
        }),
        this.prisma.db.internalRequest.findMany({
          where: {
            id: {
              in: lines
                .map((l) => l.internalRequestId)
                .filter((x): x is number => !!x),
            },
          },
        }),
        this.prisma.db.approvalRequest.findMany({
          where: {
            id: {
              in: rows
                .map((r) => r.approvalRequestId)
                .filter((x): x is number => !!x),
            },
          },
          select: { id: true, uniqueId: true },
        }),
        this.prisma.dbRaw.user.findMany({
          where: { id: { in: rows.map((r) => r.createdByUserId) } },
          include: { employee: true },
        }),
      ]);
    const by = <T extends { id: number }>(l: T[]) =>
      new Map(l.map((x) => [x.id, x]));
    const [dB, pB, vB, eB, iB, rB, uB] = [
      by(depts),
      by(products),
      by(versions),
      by(emps),
      by(irs),
      by(reqs),
      by(users),
    ];
    return Promise.all(
      rows.map(async (r) => {
        const d = dB.get(r.departmentId)!;
        const u = uB.get(r.createdByUserId);
        const [submit, cancel] = await Promise.all([
          this.access.can(user, 'purchase_request.submit', {
            departmentId: r.departmentId,
          }),
          this.access.can(user, 'purchase_request.cancel', {
            departmentId: r.departmentId,
          }),
        ]);
        return {
          uniqueId: r.uniqueId,
          number: r.number,
          status: r.status,
          department: { uniqueId: d.uniqueId, code: d.code, name: d.name },
          justification: r.justification,
          createdBy: u ? `${u.employee.firstName} ${u.employee.lastName}` : '—',
          createdAt: r.createdAt,
          submittedAt: r.submittedAt,
          decidedAt: r.decidedAt,
          approvalRequestUniqueId: r.approvalRequestId
            ? (rB.get(r.approvalRequestId)?.uniqueId ?? null)
            : null,
          lineCount: r.lines.length,
          lines: r.lines.map((l) => {
            const p = pB.get(l.productId)!;
            const e = l.beneficiaryEmployeeId
              ? eB.get(l.beneficiaryEmployeeId)
              : undefined;
            const bd = l.beneficiaryDepartmentId
              ? dB.get(l.beneficiaryDepartmentId)
              : undefined;
            const ir = l.internalRequestId
              ? iB.get(l.internalRequestId)
              : undefined;
            return {
              lineNo: l.lineNo,
              productUniqueId: p.uniqueId,
              productCode: p.code,
              productName: vB.get(l.productVersionId)?.name ?? '—',
              productStatus: p.status,
              unit: p.currentVersion?.unit ?? '',
              quantity: l.quantity,
              beneficiary: e
                ? `${e.firstName} ${e.lastName} (${e.employeeNumber})`
                : (bd?.name ?? l.productionRef ?? null),
              internalRequestNumber: ir?.number ?? null,
              internalRequestUniqueId: ir?.uniqueId ?? null,
              note: l.note,
            };
          }),
          can: {
            submit: submit && (r.status === 'DRAFT' || r.status === 'RETURNED'),
            cancel:
              cancel && ['DRAFT', 'RETURNED', 'IN_APPROVAL'].includes(r.status),
          },
        };
      }),
    );
  }
}
