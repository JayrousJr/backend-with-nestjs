import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { GoodsInspectionStatus, Prisma } from '@db';
import { PrismaService, type DbTx } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PolicyService } from '../policy/policy.service';
import { LedgerService } from '../store/ledger.service';
import { OrdersService, RECEIVABLE } from './orders.service';
import { D, day, fullName, vatParts } from './procurement.util';

export interface GrnInput {
  deliveryNoteNo?: string | null;
  deliveryNoteFileUniqueId?: string | null;
  note?: string | null;
  lines: {
    lineNo: number;
    deliveredQty: number;
    rejectedQty?: number;
    rejectReason?: string | null;
    photoFileUniqueIds?: string[];
    batchNumber?: string | null;
    expiryDate?: string | null;
    serialNumbers?: string[];
    warrantyMonths?: number | null;
  }[];
}

export interface InspectInput {
  results: { criterionId: number; pass: boolean; remark?: string | null }[];
  passedQty: number;
  failedSerials?: string[];
  remarks?: string | null;
  putawayLocationUniqueId?: string | null;
}

/**
 * Receiving and inspection (tender spec §10, store spec §2.1): GRN at the
 * main store only, into quarantine; inspection by the product's owning
 * department against the receiving criteria of the LPO's product version;
 * passed quantity is stocked in (assets tagged), failed goes to the
 * Rejected location and back to the vendor.
 */
@Injectable()
export class ReceivingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly policy: PolicyService,
    private readonly ledger: LedgerService,
    private readonly orders: OrdersService,
  ) {}

  private async location(
    tx: DbTx,
    storeId: number,
    kind: 'RECEIVING' | 'REJECTED' | 'GENERAL',
    uniqueId?: string | null,
  ) {
    const loc = uniqueId
      ? await tx.storeLocation.findFirst({
          where: { uniqueId, storeId, kind: 'GENERAL', isActive: true },
        })
      : await tx.storeLocation.findFirst({
          where: { storeId, kind, isActive: true },
          orderBy: { code: 'asc' },
        });
    if (!loc)
      throw new BadRequestException({
        message: 'errors.location_missing',
        args: { kind },
      });
    return loc;
  }

  async receive(actor: CurrentUser, orderUniqueId: string, input: GrnInput) {
    const o = await this.prisma.db.purchaseOrder.findUnique({
      where: { uniqueId: orderUniqueId },
      include: { lines: true },
    });
    if (!o) throw new NotFoundException('errors.record_not_found');
    const store = await this.prisma.db.store.findUniqueOrThrow({
      where: { id: o.storeId },
    });
    if (store.type !== 'MAIN')
      throw new BadRequestException('errors.receive_main_store_only');
    await this.access.assert(actor, 'stock.receive', { storeId: store.id });
    if (!RECEIVABLE.includes(o.status))
      throw new BadRequestException('errors.lpo_not_receivable');
    await this.policy.enforceSod(
      'SOD_LPO_RECEIVE',
      o.issuedById === actor.id && o.kind === 'TENDER',
    );
    const lines = input.lines.filter((l) => l.deliveredQty > 0);
    if (!lines.length) throw new BadRequestException('errors.no_lines');
    const products = await this.prisma.db.product.findMany({
      where: { id: { in: o.lines.map((l) => l.productId) } },
    });
    const fileIds = async (ids?: string[] | null) =>
      ids?.length
        ? (
            await this.prisma.db.file.findMany({
              where: { uniqueId: { in: ids } },
            })
          ).map((f) => f.id)
        : [];
    const note = input.deliveryNoteFileUniqueId
      ? await this.prisma.db.file.findUnique({
          where: { uniqueId: input.deliveryNoteFileUniqueId },
        })
      : null;
    const prepared: (Prisma.GrnLineUncheckedCreateWithoutGrnInput & {
      productId: number;
      batch: string | null;
      expiry: Date | null;
    })[] = [];
    for (const l of lines) {
      const ol = o.lines.find((x) => x.lineNo === l.lineNo);
      if (!ol) throw new NotFoundException('errors.record_not_found');
      const p = products.find((x) => x.id === ol.productId)!;
      const rejected = Math.max(0, l.rejectedQty ?? 0);
      const received = l.deliveredQty - rejected;
      if (received < 0) throw new BadRequestException('errors.invalid_amount');
      const outstanding = ol.quantity - ol.receivedQty + ol.failedQty;
      if (received > outstanding)
        throw new BadRequestException({
          message: 'errors.grn_above_outstanding',
          args: { line: ol.lineNo, n: outstanding },
        });
      if (rejected > 0 && !l.rejectReason?.trim())
        throw new BadRequestException('errors.reason_required');
      const serials = (l.serialNumbers ?? [])
        .map((s) => s.trim())
        .filter(Boolean);
      if (p.trackingType === 'SERIALISED') {
        if (
          serials.length !== received ||
          new Set(serials).size !== serials.length
        )
          throw new BadRequestException({
            message: 'errors.grn_serials',
            args: { line: ol.lineNo, n: received },
          });
        const dup = await this.prisma.db.asset.findFirst({
          where: { productId: p.id, serialNumber: { in: serials } },
        });
        if (dup)
          throw new BadRequestException({
            message: 'errors.serial_exists',
            args: { serial: dup.serialNumber, tag: dup.tag },
          });
      }
      if (
        p.trackingType === 'BATCH' &&
        received > 0 &&
        (!l.batchNumber?.trim() || !l.expiryDate)
      )
        throw new BadRequestException({
          message: 'errors.grn_batch',
          args: { line: ol.lineNo },
        });
      prepared.push({
        orderLineId: ol.id,
        deliveredQty: l.deliveredQty,
        receivedQty: received,
        rejectedQty: rejected,
        rejectReason: l.rejectReason?.trim() || null,
        photoFileIds: await fileIds(l.photoFileUniqueIds),
        batchNumber: l.batchNumber?.trim() || null,
        expiryDate: day(l.expiryDate),
        serialNumbers: serials,
        warrantyMonths: l.warrantyMonths ?? null,
        productId: p.id,
        batch: l.batchNumber?.trim() || null,
        expiry: day(l.expiryDate),
      });
    }
    const grn = await this.prisma.db.$transaction(async (tx) => {
      const quarantine = await this.location(tx, store.id, 'RECEIVING');
      const g = await tx.grn.create({
        data: {
          number: await this.numbering.document('GRN', tx),
          orderId: o.id,
          storeId: store.id,
          deliveryNoteNo: input.deliveryNoteNo?.trim() || null,
          deliveryNoteFileId: note?.id ?? null,
          note: input.note?.trim() || null,
          receivedById: actor.id,
        },
      });
      for (const pl of prepared) {
        const { productId, batch, expiry, ...data } = pl;
        const gl = await tx.grnLine.create({ data: { ...data, grnId: g.id } });
        if (pl.receivedQty > 0) {
          await this.ledger.moveQuantity(
            tx,
            {
              storeId: store.id,
              locationId: quarantine.id,
              productId,
              batchNumber: batch,
              expiryDate: expiry,
            },
            pl.receivedQty,
            {
              type: 'RECEIVE_QUARANTINE',
              userId: actor.id,
              referenceType: 'Grn',
              referenceId: g.number,
            },
          );
          const p = products.find((x) => x.id === productId)!;
          await tx.goodsInspection.create({
            data: {
              number: await this.numbering.document('INS', tx),
              grnLineId: gl.id,
              departmentId: p.owningDepartmentId,
            },
          });
          await tx.purchaseOrderLine.update({
            where: { id: pl.orderLineId },
            data: { receivedQty: { increment: pl.receivedQty } },
          });
        }
      }
      await tx.purchaseOrder.update({
        where: { id: o.id },
        data: { status: await this.orders.receiptStatus(tx, o.id) },
      });
      await this.audit.log(
        {
          action: 'GRN_RECORDED',
          entityType: 'Grn',
          entityId: g.uniqueId,
          after: { number: g.number, lpo: o.number },
        },
        tx,
      );
      return g;
    });
    // Inspection is assigned to each owning department.
    const depts = [
      ...new Set(
        prepared
          .filter((p) => p.receivedQty > 0)
          .map(
            (p) =>
              products.find((x) => x.id === p.productId)!.owningDepartmentId,
          ),
      ),
    ];
    for (const d of depts)
      await this.notifyInspectors(d, grn.number, grn.uniqueId);
    // Everything refused at the door: nothing to inspect.
    if (!prepared.some((p) => p.receivedQty > 0))
      await this.prisma.db.grn.update({
        where: { id: grn.id },
        data: { status: 'COMPLETED' },
      });
    return this.getGrn(actor, grn.uniqueId);
  }

  private async notifyInspectors(
    departmentId: number,
    number: string,
    grnUniqueId: string,
  ) {
    const dept = await this.prisma.db.department.findUniqueOrThrow({
      where: { id: departmentId },
    });
    const ids = new Set<number>();
    const inspectors = await this.prisma.db.userRole.findMany({
      where: {
        contextType: 'DEPARTMENT',
        contextId: departmentId,
        user: { status: 'ACTIVE' },
        role: { grants: { some: { permissionCode: 'inspection.perform' } } },
      },
      select: { userId: true },
    });
    inspectors.forEach((i) => ids.add(i.userId));
    if (dept.headEmployeeId) {
      const hod = await this.prisma.db.user.findFirst({
        where: { employeeId: dept.headEmployeeId, status: 'ACTIVE' },
      });
      if (hod) ids.add(hod.id);
    }
    for (const id of ids)
      await this.notifications.notify(id, {
        titleKey: 'notifications.inspection_due_title',
        messageKey: 'notifications.inspection_due_message',
        params: { number },
        link: `/procurement/inspections?grn=${grnUniqueId}`,
      });
  }

  // ── inspection ──────────────────────────────────────────────────────────

  private async loadInspection(uniqueId: string) {
    const i = await this.prisma.db.goodsInspection.findUnique({
      where: { uniqueId },
    });
    if (!i) throw new NotFoundException('errors.record_not_found');
    const gl = await this.prisma.db.grnLine.findUniqueOrThrow({
      where: { id: i.grnLineId },
      include: { grn: true },
    });
    const ol = await this.prisma.db.purchaseOrderLine.findUniqueOrThrow({
      where: { id: gl.orderLineId },
      include: { order: true },
    });
    return { i, gl, ol };
  }

  async assign(actor: CurrentUser, uniqueId: string, userUniqueId: string) {
    const { i } = await this.loadInspection(uniqueId);
    await this.access.assert(actor, 'inspection.assign', {
      departmentId: i.departmentId,
    });
    if (!['PENDING', 'IN_PROGRESS'].includes(i.status))
      throw new BadRequestException('errors.inspection_done');
    const u = await this.prisma.db.user.findUnique({
      where: { uniqueId: userUniqueId },
      include: { employee: true },
    });
    if (!u || u.status !== 'ACTIVE')
      throw new NotFoundException('errors.record_not_found');
    await this.prisma.db.goodsInspection.update({
      where: { id: i.id },
      data: { assignedUserId: u.id, status: 'IN_PROGRESS' },
    });
    await this.notifications.notify(u.id, {
      titleKey: 'notifications.inspection_assigned_title',
      messageKey: 'notifications.inspection_assigned_message',
      params: { number: i.number },
      link: `/procurement/inspections/${i.uniqueId}`,
    });
    return this.getInspection(actor, uniqueId);
  }

  /** Users who raised the requests behind an LPO line (SOD_REQUEST_INSPECT). */
  private async requesters(ol: {
    tenderLineId: number | null;
    purchaseRequestLineId: number | null;
  }) {
    const prlIds = ol.purchaseRequestLineId
      ? [ol.purchaseRequestLineId]
      : (
          await this.prisma.db.tenderLineSource.findMany({
            where: { tenderLineId: ol.tenderLineId ?? -1 },
          })
        ).map((s) => s.purchaseRequestLineId);
    const prls = await this.prisma.db.purchaseRequestLine.findMany({
      where: { id: { in: prlIds } },
      include: { purchaseRequest: true, internalRequest: true },
    });
    return {
      prls,
      userIds: new Set(
        prls.flatMap((l) =>
          [
            l.purchaseRequest.createdByUserId,
            l.internalRequest?.createdByUserId,
          ].filter((x): x is number => !!x),
        ),
      ),
    };
  }

  async inspect(actor: CurrentUser, uniqueId: string, input: InspectInput) {
    const { i, gl, ol } = await this.loadInspection(uniqueId);
    if (!['PENDING', 'IN_PROGRESS'].includes(i.status))
      throw new BadRequestException('errors.inspection_done');
    await this.access.assert(actor, 'inspection.perform', {
      departmentId: i.departmentId,
      assignedUserIds: i.assignedUserId ? [i.assignedUserId] : [],
    });
    await this.policy.enforceSod(
      'SOD_RECEIVE_INSPECT',
      gl.grn.receivedById === actor.id,
    );
    const { prls, userIds } = await this.requesters(ol);
    await this.policy.enforceSod('SOD_REQUEST_INSPECT', userIds.has(actor.id));
    const criteria = await this.prisma.db.productCriterion.findMany({
      where: { versionId: ol.productVersionId },
      orderBy: { sortOrder: 'asc' },
    });
    if (
      criteria.some((c) => !input.results.some((r) => r.criterionId === c.id))
    )
      throw new BadRequestException('errors.inspection_incomplete');
    if (input.results.some((r) => !r.pass && !r.remark?.trim()))
      throw new BadRequestException('errors.inspection_fail_remark');
    const product = await this.prisma.db.product.findUniqueOrThrow({
      where: { id: ol.productId },
      include: { currentVersion: { include: { category: true } } },
    });
    const version = await this.prisma.db.productVersion.findUniqueOrThrow({
      where: { id: ol.productVersionId },
      include: { category: true },
    });
    let passed = input.passedQty;
    let failedSerials: string[] = [];
    if (product.trackingType === 'SERIALISED') {
      failedSerials = (input.failedSerials ?? []).filter((s) =>
        gl.serialNumbers.includes(s),
      );
      passed = gl.receivedQty - failedSerials.length;
    }
    if (passed < 0 || passed > gl.receivedQty)
      throw new BadRequestException('errors.invalid_amount');
    const failed = gl.receivedQty - passed;
    if (
      failed > 0 &&
      !input.remarks?.trim() &&
      input.results.every((r) => r.pass)
    )
      throw new BadRequestException('errors.inspection_fail_remark');
    const status: GoodsInspectionStatus =
      failed === 0 ? 'PASSED' : passed === 0 ? 'FAILED' : 'PARTIALLY_PASSED';
    const order = ol.order;
    const vendor = order.vendorId
      ? await this.prisma.db.vendor.findUnique({
          where: { id: order.vendorId },
        })
      : null;
    await this.prisma.db.$transaction(async (tx) => {
      const store = await tx.store.findUniqueOrThrow({
        where: { id: gl.grn.storeId },
      });
      const quarantine = await this.location(tx, store.id, 'RECEIVING');
      const ref = {
        userId: actor.id,
        referenceType: 'GoodsInspection',
        referenceId: i.number,
      };
      const at = {
        storeId: store.id,
        productId: ol.productId,
        batchNumber: gl.batchNumber,
        expiryDate: gl.expiryDate,
      };
      if (passed > 0) {
        await this.ledger.moveQuantity(
          tx,
          { ...at, locationId: quarantine.id },
          -passed,
          { ...ref, type: 'STOCK_IN' },
        );
        const putaway = await this.location(
          tx,
          store.id,
          'GENERAL',
          input.putawayLocationUniqueId,
        );
        if (product.trackingType === 'SERIALISED') {
          const serials = gl.serialNumbers.filter(
            (s) => !failedSerials.includes(s),
          );
          const tags = await this.ledger.issueTags(
            version.category.tagPrefix,
            serials.length,
            actor.id,
            tx,
          );
          const unitExcl = vatParts(D(ol.unitPrice), D(ol.vatRate)).excl;
          const warranty = gl.warrantyMonths
            ? (() => {
                const d = new Date(gl.grn.receivedAt);
                d.setMonth(d.getMonth() + gl.warrantyMonths);
                return day(d.toISOString());
              })()
            : null;
          for (const [n, serial] of serials.entries()) {
            await this.ledger.createAsset(
              tx,
              {
                tagId: tags[n].id,
                serialNumber: serial,
                brand: ol.brand,
                model: ol.model,
                productId: ol.productId,
                productVersionId: ol.productVersionId,
                owningDepartmentId: product.owningDepartmentId,
                source: 'PURCHASE',
                lpoRef: order.number,
                grnRef: gl.grn.number,
                inspectionRef: i.number,
                vendorRef: vendor?.number ?? order.shopName,
                purchasePrice: unitExcl,
                purchaseDate: day(gl.grn.receivedAt.toISOString()),
                warrantyExpiry: warranty,
                storeId: store.id,
                locationId: putaway.id,
                condition: 'GOOD',
                status: 'IN_STORE',
              },
              { ...ref, type: 'STOCK_IN' },
            );
          }
        } else {
          await this.ledger.moveQuantity(
            tx,
            { ...at, locationId: putaway.id },
            passed,
            { ...ref, type: 'STOCK_IN' },
          );
        }
      }
      if (failed > 0) {
        const rejected = await this.location(tx, store.id, 'REJECTED');
        await this.ledger.moveQuantity(
          tx,
          { ...at, locationId: quarantine.id },
          -failed,
          { ...ref, type: 'REJECT_TO_VENDOR', reason: 'Failed inspection' },
        );
        await this.ledger.moveQuantity(
          tx,
          { ...at, locationId: rejected.id },
          failed,
          {
            ...ref,
            type: 'REJECT_TO_VENDOR',
            reason: 'Failed inspection: waiting to go back to the vendor',
          },
        );
      }
      await tx.goodsInspection.update({
        where: { id: i.id },
        data: {
          status,
          inspectorUserId: actor.id,
          passedQty: passed,
          failedQty: failed,
          failedSerials,
          results: input.results.map((r) => ({
            criterionId: r.criterionId,
            text: criteria.find((c) => c.id === r.criterionId)?.text ?? '',
            pass: r.pass,
            remark: r.remark?.trim() || null,
          })) as Prisma.InputJsonValue,
          remarks: input.remarks?.trim() || null,
          completedAt: new Date(),
        },
      });
      await tx.purchaseOrderLine.update({
        where: { id: ol.id },
        data: {
          passedQty: { increment: passed },
          failedQty: { increment: failed },
        },
      });
      const open = await tx.goodsInspection.count({
        where: {
          grnLineId: {
            in: (await tx.grnLine.findMany({ where: { grnId: gl.grnId } })).map(
              (x) => x.id,
            ),
          },
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        },
      });
      if (!open)
        await tx.grn.update({
          where: { id: gl.grnId },
          data: { status: 'COMPLETED' },
        });
      await tx.purchaseOrder.update({
        where: { id: order.id },
        data: { status: await this.orders.receiptStatus(tx, order.id) },
      });
      // Request lines complete when their LPO line has passed in full.
      const line = await tx.purchaseOrderLine.findUniqueOrThrow({
        where: { id: ol.id },
      });
      if (line.passedQty >= line.quantity) {
        await tx.purchaseRequestLine.updateMany({
          where: { id: { in: prls.map((p) => p.id) } },
          data: { sourcingStatus: 'RECEIVED' },
        });
        for (const prId of new Set(prls.map((p) => p.purchaseRequestId))) {
          const left = await tx.purchaseRequestLine.count({
            where: {
              purchaseRequestId: prId,
              sourcingStatus: { notIn: ['RECEIVED', 'CANCELLED'] },
            },
          });
          if (!left)
            await tx.purchaseRequest.update({
              where: { id: prId },
              data: { status: 'COMPLETED' },
            });
        }
      }
      // Purchased goods for internal requests become deliverable from the store.
      if (passed > 0)
        await this.feedInternalRequests(tx, prls, passed, store.id);
      await this.audit.log(
        {
          action: 'GOODS_INSPECTED',
          entityType: 'GoodsInspection',
          entityId: i.uniqueId,
          after: { status, passed, failed },
        },
        tx,
      );
    });
    if (passed > 0) await this.proposeNext(prls, passed, order.number);
    return this.getInspection(actor, uniqueId);
  }

  private async feedInternalRequests(
    tx: DbTx,
    prls: { internalRequestId: number | null }[],
    passed: number,
    mainStoreId: number,
  ) {
    let left = passed;
    for (const l of prls) {
      if (!l.internalRequestId || left <= 0) continue;
      const ir = await tx.internalRequest.findUniqueOrThrow({
        where: { id: l.internalRequestId },
      });
      if (ir.status !== 'IN_PURCHASE' || ir.toPurchaseQty <= 0) continue;
      const n = Math.min(left, ir.toPurchaseQty);
      left -= n;
      await tx.internalRequest.update({
        where: { id: ir.id },
        data: {
          fromStoreQty: ir.fromStoreQty + n,
          toPurchaseQty: ir.toPurchaseQty - n,
          storeId:
            ir.storeId && ir.fromStoreQty > ir.deliveredQty
              ? ir.storeId
              : mainStoreId,
        },
      });
    }
  }

  /** Handover proposed when a line names an employee; transfer when served by another store. */
  private async proposeNext(
    prls: {
      internalRequestId: number | null;
      beneficiaryEmployeeId: number | null;
    }[],
    passed: number,
    lpo: string,
  ) {
    const irs = await this.prisma.db.internalRequest.findMany({
      where: {
        id: {
          in: prls
            .map((p) => p.internalRequestId)
            .filter((x): x is number => !!x),
        },
      },
    });
    for (const ir of irs) {
      const store = ir.storeId
        ? await this.prisma.db.store.findUnique({ where: { id: ir.storeId } })
        : null;
      const keepers = await this.prisma.db.userRole.findMany({
        where: {
          contextType: 'STORE',
          contextId: ir.storeId ?? -1,
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
      for (const id of new Set(keepers.map((k) => k.userId)))
        await this.notifications.notify(id, {
          titleKey: ir.beneficiaryEmployeeId
            ? 'notifications.handover_proposed_title'
            : 'notifications.issue_proposed_title',
          messageKey: ir.beneficiaryEmployeeId
            ? 'notifications.handover_proposed_message'
            : 'notifications.issue_proposed_message',
          params: { number: ir.number, lpo, store: store?.name ?? '' },
          link: `/requests/internal/${ir.uniqueId}`,
        });
    }
    void passed;
  }

  /** Failed goods leave the Rejected location back to the vendor. */
  async returnToVendor(actor: CurrentUser, uniqueId: string, note: string) {
    const { i, gl, ol } = await this.loadInspection(uniqueId);
    if (i.failedQty <= 0 || i.returnedToVendorAt)
      throw new BadRequestException('errors.nothing_to_return');
    await this.access.assert(actor, 'stock.receive', {
      storeId: gl.grn.storeId,
    });
    await this.prisma.db.$transaction(async (tx) => {
      const rejected = await this.location(tx, gl.grn.storeId, 'REJECTED');
      await this.ledger.moveQuantity(
        tx,
        {
          storeId: gl.grn.storeId,
          locationId: rejected.id,
          productId: ol.productId,
          batchNumber: gl.batchNumber,
        },
        -i.failedQty,
        {
          type: 'REJECT_TO_VENDOR',
          userId: actor.id,
          referenceType: 'GoodsInspection',
          referenceId: i.number,
          reason: note.trim() || 'Returned to vendor',
        },
      );
      await tx.goodsInspection.update({
        where: { id: i.id },
        data: { returnedToVendorAt: new Date() },
      });
      await this.audit.log(
        {
          action: 'GOODS_RETURNED_TO_VENDOR',
          entityType: 'GoodsInspection',
          entityId: i.uniqueId,
          after: { qty: i.failedQty, note },
        },
        tx,
      );
    });
    return this.getInspection(actor, uniqueId);
  }

  // ── queries ─────────────────────────────────────────────────────────────

  async listGrns(user: CurrentUser) {
    const s = await this.access.resolveScope(user, 'grn.view');
    const r = await this.access.resolveScope(user, 'stock.receive');
    const where: Prisma.GrnWhereInput = s.all
      ? {}
      : { storeId: { in: [...s.storeIds, ...r.storeIds] } };
    const rows = await this.prisma.db.grn.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      take: 200,
      include: { lines: true },
    });
    return Promise.all(rows.map((g) => this.presentGrn(g)));
  }

  async getGrn(user: CurrentUser, uniqueId: string) {
    const g = await this.prisma.db.grn.findUnique({
      where: { uniqueId },
      include: { lines: true },
    });
    if (!g) throw new NotFoundException('errors.record_not_found');
    const s = await this.access.resolveScope(user, 'grn.view');
    const r = await this.access.resolveScope(user, 'stock.receive');
    if (!s.all && ![...s.storeIds, ...r.storeIds].includes(g.storeId))
      throw new ForbiddenException('errors.forbidden');
    return this.presentGrn(g);
  }

  private async presentGrn(
    g: Prisma.GrnGetPayload<{ include: { lines: true } }>,
  ) {
    const [o, olines, store, receiver, files, inspections] = await Promise.all([
      this.prisma.db.purchaseOrder.findUniqueOrThrow({
        where: { id: g.orderId },
      }),
      this.prisma.db.purchaseOrderLine.findMany({
        where: { id: { in: g.lines.map((l) => l.orderLineId) } },
      }),
      this.prisma.db.store.findUniqueOrThrow({ where: { id: g.storeId } }),
      this.prisma.dbRaw.user.findUnique({
        where: { id: g.receivedById },
        include: { employee: true },
      }),
      this.prisma.db.file.findMany({
        where: {
          id: {
            in: [
              g.deliveryNoteFileId,
              ...g.lines.flatMap((l) => l.photoFileIds),
            ].filter((x): x is number => !!x),
          },
        },
      }),
      this.prisma.db.goodsInspection.findMany({
        where: { grnLineId: { in: g.lines.map((l) => l.id) } },
      }),
    ]);
    const [vendor, versions] = await Promise.all([
      o.vendorId
        ? this.prisma.db.vendor.findUnique({ where: { id: o.vendorId } })
        : null,
      this.prisma.db.productVersion.findMany({
        where: { id: { in: olines.map((l) => l.productVersionId) } },
      }),
    ]);
    const f = (id: number | null) => {
      const x = files.find((y) => y.id === id);
      return x
        ? { uniqueId: x.uniqueId, filename: x.filename, uri: x.uri }
        : null;
    };
    return {
      uniqueId: g.uniqueId,
      number: g.number,
      status: g.status,
      order: { uniqueId: o.uniqueId, number: o.number, kind: o.kind },
      vendor: vendor?.name ?? o.shopName ?? '',
      store: store.name,
      deliveryNoteNo: g.deliveryNoteNo,
      deliveryNote: f(g.deliveryNoteFileId),
      note: g.note,
      receivedBy: receiver ? fullName(receiver.employee) : '—',
      receivedAt: g.receivedAt,
      lines: g.lines.map((l) => {
        const ol = olines.find((x) => x.id === l.orderLineId)!;
        const ins = inspections.find((x) => x.grnLineId === l.id);
        return {
          lineNo: ol.lineNo,
          productName:
            versions.find((v) => v.id === ol.productVersionId)?.name ?? '',
          ordered: ol.quantity,
          deliveredQty: l.deliveredQty,
          receivedQty: l.receivedQty,
          rejectedQty: l.rejectedQty,
          rejectReason: l.rejectReason,
          photos: l.photoFileIds.map((id) => f(id)).filter((x) => !!x),
          batchNumber: l.batchNumber,
          expiryDate: l.expiryDate,
          serialNumbers: l.serialNumbers,
          inspection: ins
            ? {
                uniqueId: ins.uniqueId,
                number: ins.number,
                status: ins.status,
                passedQty: ins.passedQty,
                failedQty: ins.failedQty,
              }
            : null,
        };
      }),
    };
  }

  private async inspectionWhere(
    user: CurrentUser,
  ): Promise<Prisma.GoodsInspectionWhereInput> {
    const s = await this.access.resolveScope(user, 'inspection.view');
    if (s.all) return {};
    const p = await this.access.resolveScope(user, 'inspection.perform');
    const r = await this.access.resolveScope(user, 'stock.receive');
    const depts = [...new Set([...s.departmentIds, ...p.departmentIds])];
    // Owning department, assigned inspector, or the receiving store.
    const or: Prisma.GoodsInspectionWhereInput[] = [
      { departmentId: { in: depts } },
      { assignedUserId: user.id },
    ];
    if (r.all || r.storeIds.length) {
      const lines = await this.prisma.db.grnLine.findMany({
        where: r.all ? {} : { grn: { storeId: { in: r.storeIds } } },
        select: { id: true },
      });
      or.push({ grnLineId: { in: lines.map((l) => l.id) } });
    }
    return { OR: or };
  }

  async listInspections(
    user: CurrentUser,
    open?: boolean,
    grnUniqueId?: string,
  ) {
    const grn = grnUniqueId
      ? await this.prisma.db.grn.findUnique({
          where: { uniqueId: grnUniqueId },
          include: { lines: true },
        })
      : null;
    const rows = await this.prisma.db.goodsInspection.findMany({
      where: {
        AND: [
          await this.inspectionWhere(user),
          open ? { status: { in: ['PENDING', 'IN_PROGRESS'] } } : {},
          grn ? { grnLineId: { in: grn.lines.map((l) => l.id) } } : {},
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return Promise.all(rows.map((r) => this.presentInspection(user, r)));
  }

  async getInspection(user: CurrentUser, uniqueId: string) {
    const i = await this.prisma.db.goodsInspection.findUnique({
      where: { uniqueId },
    });
    if (!i) throw new NotFoundException('errors.record_not_found');
    const n = await this.prisma.db.goodsInspection.count({
      where: { AND: [{ id: i.id }, await this.inspectionWhere(user)] },
    });
    if (!n) throw new ForbiddenException('errors.forbidden');
    return this.presentInspection(user, i);
  }

  private async presentInspection(
    user: CurrentUser,
    i: Prisma.GoodsInspectionGetPayload<object>,
  ) {
    const gl = await this.prisma.db.grnLine.findUniqueOrThrow({
      where: { id: i.grnLineId },
      include: { grn: true },
    });
    const ol = await this.prisma.db.purchaseOrderLine.findUniqueOrThrow({
      where: { id: gl.orderLineId },
      include: { order: true },
    });
    const [version, product, criteria, dept, users, vendor] = await Promise.all(
      [
        this.prisma.db.productVersion.findUniqueOrThrow({
          where: { id: ol.productVersionId },
        }),
        this.prisma.db.product.findUniqueOrThrow({
          where: { id: ol.productId },
        }),
        this.prisma.db.productCriterion.findMany({
          where: { versionId: ol.productVersionId },
          orderBy: { sortOrder: 'asc' },
        }),
        this.prisma.db.department.findUniqueOrThrow({
          where: { id: i.departmentId },
        }),
        this.prisma.dbRaw.user.findMany({
          where: {
            id: {
              in: [i.assignedUserId, i.inspectorUserId].filter(
                (x): x is number => !!x,
              ),
            },
          },
          include: { employee: true },
        }),
        ol.order.vendorId
          ? this.prisma.db.vendor.findUnique({
              where: { id: ol.order.vendorId },
            })
          : null,
      ],
    );
    const name = (id: number | null) => {
      const u = users.find((x) => x.id === id);
      return u ? fullName(u.employee) : null;
    };
    const open = ['PENDING', 'IN_PROGRESS'].includes(i.status);
    const [perform, assign, ret] = await Promise.all([
      this.access.can(user, 'inspection.perform', {
        departmentId: i.departmentId,
        assignedUserIds: i.assignedUserId ? [i.assignedUserId] : [],
      }),
      this.access.can(user, 'inspection.assign', {
        departmentId: i.departmentId,
      }),
      this.access.can(user, 'stock.receive', { storeId: gl.grn.storeId }),
    ]);
    return {
      uniqueId: i.uniqueId,
      number: i.number,
      status: i.status,
      department: dept.name,
      grn: {
        uniqueId: gl.grn.uniqueId,
        number: gl.grn.number,
        receivedAt: gl.grn.receivedAt,
      },
      order: { uniqueId: ol.order.uniqueId, number: ol.order.number },
      vendor: vendor?.name ?? ol.order.shopName ?? '',
      productUniqueId: product.uniqueId,
      productName: version.name,
      productVersion: version.version,
      trackingType: product.trackingType,
      receivedQty: gl.receivedQty,
      serialNumbers: gl.serialNumbers,
      batchNumber: gl.batchNumber,
      criteria: criteria.map((c) => ({ id: c.id, text: c.text })),
      results: (i.results ?? []) as {
        criterionId: number;
        text: string;
        pass: boolean;
        remark: string | null;
      }[],
      passedQty: i.passedQty,
      failedQty: i.failedQty,
      failedSerials: i.failedSerials,
      remarks: i.remarks,
      assignedTo: name(i.assignedUserId),
      inspectedBy: name(i.inspectorUserId),
      completedAt: i.completedAt,
      returnedToVendorAt: i.returnedToVendorAt,
      createdAt: i.createdAt,
      can: {
        inspect: perform && open,
        assign: assign && open,
        returnToVendor: ret && i.failedQty > 0 && !i.returnedToVendorAt,
      },
    };
  }
}
