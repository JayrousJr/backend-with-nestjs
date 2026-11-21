import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { fullName } from './procurement.util';

const SUBJECTS = [
  'PurchaseRequest',
  'Tender',
  'PurchaseOrder',
  'Grn',
  'Invoice',
] as const;
export type DocSubject = (typeof SUBJECTS)[number];

export interface PurchaseFileEvent {
  at: Date;
  kind: string;
  title: string;
  detail?: string | null;
  ref?: string | null;
  link?: string | null;
  actor?: string | null;
}

/**
 * Purchase file (requirements §5): one timeline per purchase with every
 * step, actor, timestamp and document, from the request to the payment.
 */
@Injectable()
export class PurchaseFileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private async subjectId(type: DocSubject, uniqueId: string) {
    const db = this.prisma.db;
    const row =
      type === 'PurchaseRequest'
        ? await db.purchaseRequest.findUnique({ where: { uniqueId } })
        : type === 'Tender'
          ? await db.tender.findUnique({ where: { uniqueId } })
          : type === 'PurchaseOrder'
            ? await db.purchaseOrder.findUnique({ where: { uniqueId } })
            : type === 'Grn'
              ? await db.grn.findUnique({ where: { uniqueId } })
              : await db.invoice.findUnique({ where: { uniqueId } });
    if (!row) throw new NotFoundException('errors.record_not_found');
    return row.id;
  }

  async attach(
    actor: CurrentUser,
    type: DocSubject,
    uniqueId: string,
    docType: string,
    fileUniqueId: string,
  ) {
    if (!SUBJECTS.includes(type))
      throw new NotFoundException('errors.record_not_found');
    const id = await this.subjectId(type, uniqueId);
    const file = await this.prisma.db.file.findUnique({
      where: { uniqueId: fileUniqueId },
    });
    if (!file) throw new NotFoundException('errors.record_not_found');
    await this.prisma.db.procurementDocument.create({
      data: {
        subjectType: type,
        subjectId: id,
        docType: docType.trim() || 'Other',
        fileId: file.id,
        uploadedById: actor.id,
      },
    });
    await this.audit.log({
      action: 'PROCUREMENT_DOCUMENT',
      entityType: type,
      entityId: uniqueId,
      after: { docType, file: file.filename },
    });
    return this.documents(type, [id]);
  }

  async documents(type: DocSubject, ids: number[]) {
    const docs = await this.prisma.db.procurementDocument.findMany({
      where: { subjectType: type, subjectId: { in: ids } },
      orderBy: { createdAt: 'asc' },
    });
    const [files, users] = await Promise.all([
      this.prisma.db.file.findMany({
        where: { id: { in: docs.map((d) => d.fileId) } },
      }),
      this.prisma.dbRaw.user.findMany({
        where: {
          id: {
            in: docs.map((d) => d.uploadedById).filter((x): x is number => !!x),
          },
        },
        include: { employee: true },
      }),
    ]);
    return docs.map((d) => {
      const f = files.find((x) => x.id === d.fileId)!;
      const u = users.find((x) => x.id === d.uploadedById);
      return {
        subjectType: d.subjectType,
        docType: d.docType,
        file: { uniqueId: f.uniqueId, filename: f.filename, uri: f.uri },
        uploadedBy: u ? fullName(u.employee) : 'Vendor',
        createdAt: d.createdAt,
      };
    });
  }

  async documentsOf(type: DocSubject, uniqueId: string) {
    return this.documents(type, [await this.subjectId(type, uniqueId)]);
  }

  async forRequest(user: CurrentUser, uniqueId: string) {
    const pr = await this.prisma.db.purchaseRequest.findUnique({
      where: { uniqueId },
      include: { lines: true },
    });
    if (!pr) throw new NotFoundException('errors.record_not_found');
    if (
      !(await this.access.can(user, 'purchase_file.view', {
        departmentId: pr.departmentId,
      }))
    )
      throw new ForbiddenException('errors.forbidden');
    const users = new Map<number, string>();
    const who = async (id: number | null | undefined) => {
      if (!id) return null;
      if (!users.has(id)) {
        const u = await this.prisma.dbRaw.user.findUnique({
          where: { id },
          include: { employee: true },
        });
        users.set(id, u ? fullName(u.employee) : '—');
      }
      return users.get(id)!;
    };
    const ev: PurchaseFileEvent[] = [];
    ev.push({
      at: pr.createdAt,
      kind: 'REQUEST',
      title: `Purchase request ${pr.number} created`,
      actor: await who(pr.createdByUserId),
      link: `/requests/purchase/${pr.uniqueId}`,
    });
    if (pr.submittedAt)
      ev.push({
        at: pr.submittedAt,
        kind: 'REQUEST',
        title: 'Submitted for approval',
      });
    const approvalIds = [
      pr.approvalRequestId,
      ...pr.lines.map((l) => l.justificationApprovalId),
    ].filter((x): x is number => !!x);
    const actions = await this.prisma.db.approvalAction.findMany({
      where: { requestId: { in: approvalIds } },
      orderBy: { at: 'asc' },
    });
    const reqs = await this.prisma.db.approvalRequest.findMany({
      where: { id: { in: approvalIds } },
    });
    for (const a of actions) {
      const r = reqs.find((x) => x.id === a.requestId)!;
      ev.push({
        at: a.at,
        kind: 'APPROVAL',
        title: `${r.title}: ${a.stepName ?? ''} — ${a.decision.toLowerCase()}`,
        detail: a.comment,
        actor: await who(a.userId),
        link: `/approvals/${r.uniqueId}`,
      });
    }
    for (const l of pr.lines)
      if (l.routeSetAt)
        ev.push({
          at: l.routeSetAt,
          kind: 'ROUTE',
          title: `Line ${l.lineNo}: route ${l.route?.toLowerCase().replace('_', ' ')}`,
          detail: l.justification,
          actor: await who(l.routeSetById),
        });

    const sources = await this.prisma.db.tenderLineSource.findMany({
      where: { purchaseRequestLineId: { in: pr.lines.map((l) => l.id) } },
      include: { tenderLine: true },
    });
    const tenders = await this.prisma.db.tender.findMany({
      where: { id: { in: sources.map((s) => s.tenderLine.tenderId) } },
    });
    for (const t of tenders) {
      const link = `/tenders/${t.uniqueId}`;
      ev.push({
        at: t.createdAt,
        kind: 'TENDER',
        title: `Tender ${t.number} created`,
        detail: t.title,
        actor: await who(t.createdByUserId),
        link,
      });
      if (t.publishedAt)
        ev.push({
          at: t.publishedAt,
          kind: 'TENDER',
          title: `Tender ${t.number} published`,
          actor: await who(t.publishedByUserId),
          link,
        });
      if (t.closedAt)
        ev.push({
          at: t.closedAt,
          kind: 'TENDER',
          title: `Tender ${t.number} closed`,
          link,
        });
      if (t.openedAt)
        ev.push({
          at: t.openedAt,
          kind: 'TENDER',
          title: `Bids opened (${t.number})`,
          link,
        });
      if (t.awardedAt)
        ev.push({
          at: t.awardedAt,
          kind: 'TENDER',
          title: `Award approved (${t.number})`,
          link,
        });
      if (t.lettersSentAt)
        ev.push({
          at: t.lettersSentAt,
          kind: 'TENDER',
          title: 'Award and regret letters sent',
          link,
        });
      if (t.cancelledAt)
        ev.push({
          at: t.cancelledAt,
          kind: 'TENDER',
          title: `Tender ${t.number} cancelled`,
          detail: t.cancelReason,
          link,
        });
    }
    const orders = await this.prisma.db.purchaseOrder.findMany({
      where: {
        OR: [
          {
            lines: {
              some: {
                tenderLineId: { in: sources.map((s) => s.tenderLineId) },
              },
            },
          },
          {
            lines: {
              some: {
                purchaseRequestLineId: { in: pr.lines.map((l) => l.id) },
              },
            },
          },
        ],
      },
      include: { amendments: true },
    });
    for (const o of orders) {
      const link = `/procurement/orders/${o.uniqueId}`;
      ev.push({
        at: o.createdAt,
        kind: 'LPO',
        title: `${o.kind === 'CASH' ? 'Cash purchase' : 'LPO'} ${o.number} created`,
        actor: await who(o.createdById),
        link,
      });
      if (o.issuedAt)
        ev.push({
          at: o.issuedAt,
          kind: 'LPO',
          title: `${o.number} issued`,
          link,
        });
      if (o.acknowledgedAt)
        ev.push({
          at: o.acknowledgedAt,
          kind: 'LPO',
          title: `${o.number} acknowledged by the vendor`,
          detail: o.acknowledgedBy,
          link,
        });
      for (const a of o.amendments)
        ev.push({
          at: a.appliedAt ?? a.createdAt,
          kind: 'LPO',
          title: `${o.number} amendment rev ${a.revision} — ${a.status.toLowerCase().replace(/_/g, ' ')}`,
          detail: a.reason,
          link,
        });
      if (o.cancelledAt)
        ev.push({
          at: o.cancelledAt,
          kind: 'LPO',
          title: `${o.number} cancelled`,
          detail: o.cancelReason,
          link,
        });
      if (o.closedAt)
        ev.push({
          at: o.closedAt,
          kind: 'LPO',
          title: `${o.number} paid and closed`,
          link,
        });
    }
    const grns = await this.prisma.db.grn.findMany({
      where: { orderId: { in: orders.map((o) => o.id) } },
      include: { lines: true },
    });
    for (const g of grns)
      ev.push({
        at: g.receivedAt,
        kind: 'GRN',
        title: `Goods received ${g.number}`,
        detail: g.deliveryNoteNo ? `Delivery note ${g.deliveryNoteNo}` : null,
        actor: await who(g.receivedById),
        link: `/procurement/grns/${g.uniqueId}`,
      });
    const ins = await this.prisma.db.goodsInspection.findMany({
      where: {
        grnLineId: { in: grns.flatMap((g) => g.lines.map((l) => l.id)) },
      },
    });
    for (const i of ins)
      if (i.completedAt)
        ev.push({
          at: i.completedAt,
          kind: 'INSPECTION',
          title: `Inspection ${i.number}: ${i.status.toLowerCase().replace('_', ' ')} (${i.passedQty} passed, ${i.failedQty} failed)`,
          detail: i.remarks,
          actor: await who(i.inspectorUserId),
          link: `/procurement/inspections/${i.uniqueId}`,
        });
    const invoices = await this.prisma.db.invoice.findMany({
      where: { orderId: { in: orders.map((o) => o.id) } },
    });
    for (const v of invoices) {
      ev.push({
        at: v.createdAt,
        kind: 'FINANCE',
        title: `Invoice ${v.vendorInvoiceNo} registered`,
        actor: await who(v.registeredById),
        link: `/procurement/invoices/${v.uniqueId}`,
      });
      if (v.paidAt)
        ev.push({
          at: v.updatedAt,
          kind: 'FINANCE',
          title: `Payment recorded (${v.paymentReference})`,
          actor: await who(v.paymentById),
          link: `/procurement/invoices/${v.uniqueId}`,
        });
    }
    const docs = [
      ...(await this.documents('PurchaseRequest', [pr.id])),
      ...(await this.documents(
        'Tender',
        tenders.map((t) => t.id),
      )),
      ...(await this.documents(
        'PurchaseOrder',
        orders.map((o) => o.id),
      )),
      ...(await this.documents(
        'Grn',
        grns.map((g) => g.id),
      )),
      ...(await this.documents(
        'Invoice',
        invoices.map((i) => i.id),
      )),
    ];
    for (const d of docs)
      ev.push({
        at: d.createdAt,
        kind: 'DOCUMENT',
        title: `Document: ${d.docType}`,
        detail: d.file.filename,
        actor: d.uploadedBy,
        link: d.file.uri,
      });
    ev.sort((a, b) => a.at.getTime() - b.at.getTime());
    return {
      purchaseRequestUniqueId: pr.uniqueId,
      number: pr.number,
      events: ev,
      documents: docs,
    };
  }
}
