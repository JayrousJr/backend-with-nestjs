import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma } from '@db';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import {
  APPROVAL_COMPLETED,
  WorkflowService,
  type ApprovalCompletedEvent,
} from '../workflow/workflow.service';
import { D, day, fullName, round2 } from './procurement.util';

const PAY_POINT = 'payment_request.approval';

export interface InvoiceInput {
  vendorInvoiceNo: string;
  invoiceDate: string;
  amountInclVat: number;
  vatAmount: number;
  fileUniqueId?: string | null;
  note?: string | null;
}

/**
 * Finance, manual at go-live (tender spec §11). SAP is out of scope: Finance
 * registers the invoice (three-way match LPO ↔ GRN ↔ invoice shown), the
 * payment is approved (payment_request.approval) and recorded by hand with
 * its documents; the LPO is then closed.
 */
@Injectable()
export class FinanceService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly workflow: WorkflowService,
  ) {}

  onModuleInit() {
    this.workflow.registerGuard(PAY_POINT, async (actor, request, d) => {
      if (d.decision !== 'APPROVE') return;
      const inv = await this.prisma.db.invoice.findUnique({
        where: { uniqueId: request.subjectId },
      });
      await this.policy.enforceSod(
        'SOD_INVOICE_PAYMENT',
        inv?.registeredById === actor.id,
      );
    });
  }

  /** LPO vs goods passed at inspection vs invoices. */
  async match(orderId: number) {
    const o = await this.prisma.db.purchaseOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: true },
    });
    const invoices = await this.prisma.db.invoice.findMany({
      where: { orderId, status: { not: 'REJECTED' } },
    });
    const ordered = round2(
      o.lines.reduce((n, l) => n + l.quantity * D(l.unitPrice), 0),
    );
    const received = round2(
      o.lines.reduce((n, l) => n + l.passedQty * D(l.unitPrice), 0),
    );
    const invoiced = round2(
      invoices.reduce((n, i) => n + D(i.amountInclVat), 0),
    );
    const paid = round2(
      invoices
        .filter((i) => i.status === 'PAID')
        .reduce((n, i) => n + D(i.paidAmount ?? i.amountInclVat), 0),
    );
    return {
      ordered,
      received,
      invoiced,
      paid,
      // Invoiced must not exceed what passed inspection (1 TZS rounding tolerance).
      matched: invoiced > 0 && Math.abs(invoiced - received) <= 1,
      overInvoiced: invoiced - received > 1,
      lines: o.lines.map((l) => ({
        lineNo: l.lineNo,
        ordered: l.quantity,
        received: l.receivedQty,
        passed: l.passedQty,
        unitPrice: D(l.unitPrice),
      })),
    };
  }

  async register(
    actor: CurrentUser,
    orderUniqueId: string,
    input: InvoiceInput,
  ) {
    const o = await this.prisma.db.purchaseOrder.findUnique({
      where: { uniqueId: orderUniqueId },
    });
    if (!o) throw new NotFoundException('errors.record_not_found');
    if (['DRAFT', 'IN_APPROVAL', 'CANCELLED', 'CLOSED'].includes(o.status))
      throw new BadRequestException('errors.lpo_not_invoiceable');
    if (
      input.amountInclVat <= 0 ||
      input.vatAmount < 0 ||
      input.vatAmount >= input.amountInclVat
    )
      throw new BadRequestException('errors.invalid_amount');
    const file = input.fileUniqueId
      ? await this.prisma.db.file.findUnique({
          where: { uniqueId: input.fileUniqueId },
        })
      : null;
    const inv = await this.prisma.db.invoice.create({
      data: {
        orderId: o.id,
        vendorInvoiceNo: input.vendorInvoiceNo.trim(),
        invoiceDate: day(input.invoiceDate)!,
        amountInclVat: input.amountInclVat,
        vatAmount: input.vatAmount,
        fileId: file?.id ?? null,
        note: input.note?.trim() || null,
        registeredById: actor.id,
      },
    });
    await this.audit.log({
      action: 'INVOICE_REGISTERED',
      entityType: 'Invoice',
      entityId: inv.uniqueId,
      after: { lpo: o.number, amount: input.amountInclVat },
    });
    return this.get(actor, inv.uniqueId);
  }

  /** Approval of payment (Finance; SOD_INVOICE_PAYMENT). Must not exceed goods passed. */
  async requestPayment(actor: CurrentUser, uniqueId: string) {
    const inv = await this.load(uniqueId);
    if (!['REGISTERED', 'REJECTED'].includes(inv.status))
      throw new BadRequestException('errors.invoice_status');
    const m = await this.match(inv.orderId);
    if (m.overInvoiced)
      throw new BadRequestException('errors.invoice_above_received');
    const o = await this.prisma.db.purchaseOrder.findUniqueOrThrow({
      where: { id: inv.orderId },
    });
    await this.prisma.db.$transaction(async (tx) => {
      const req = await this.workflow.start(
        {
          pointCode: PAY_POINT,
          subjectType: 'Invoice',
          subjectId: inv.uniqueId,
          title: `Payment ${o.number} — invoice ${inv.vendorInvoiceNo}`,
          requesterUserId: actor.id,
          context: { amount: D(inv.amountInclVat), matched: m.matched },
        },
        tx,
      );
      await tx.invoice.update({
        where: { id: inv.id },
        data: { status: 'IN_APPROVAL', approvalRequestId: req.id },
      });
    });
    return this.get(actor, uniqueId);
  }

  @OnEvent(APPROVAL_COMPLETED, { async: true })
  async onCompleted(e: ApprovalCompletedEvent) {
    if (e.pointCode !== PAY_POINT || e.subjectType !== 'Invoice') return;
    await this.prisma.db.invoice.updateMany({
      where: { uniqueId: e.subjectId, status: 'IN_APPROVAL' },
      data: {
        status:
          e.status === 'APPROVED'
            ? 'APPROVED'
            : e.status === 'RETURNED'
              ? 'REGISTERED'
              : 'REJECTED',
      },
    });
  }

  async recordPayment(
    actor: CurrentUser,
    uniqueId: string,
    input: {
      reference: string;
      paidAt: string;
      amount: number;
      fileUniqueIds: string[];
    },
  ) {
    const inv = await this.load(uniqueId);
    if (inv.status !== 'APPROVED')
      throw new BadRequestException('errors.invoice_not_approved');
    if (!input.reference.trim() || input.amount <= 0)
      throw new BadRequestException('errors.invalid_amount');
    const files = await this.prisma.db.file.findMany({
      where: { uniqueId: { in: input.fileUniqueIds } },
    });
    await this.prisma.db.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: inv.id },
        data: {
          status: 'PAID',
          paymentReference: input.reference.trim(),
          paidAt: day(input.paidAt),
          paidAmount: input.amount,
          paymentFileIds: files.map((f) => f.id),
          paymentById: actor.id,
        },
      });
      await this.audit.log(
        {
          action: 'PAYMENT_RECORDED',
          entityType: 'Invoice',
          entityId: inv.uniqueId,
          after: { reference: input.reference, amount: input.amount },
        },
        tx,
      );
    });
    await this.maybeClose(inv.orderId);
    return this.get(actor, uniqueId);
  }

  /** Purchase marked Paid / Closed: all goods passed and paid in full. */
  private async maybeClose(orderId: number) {
    const o = await this.prisma.db.purchaseOrder.findUniqueOrThrow({
      where: { id: orderId },
    });
    if (o.status !== 'RECEIVED') return;
    const m = await this.match(orderId);
    if (m.paid + 1 >= m.received) {
      await this.prisma.db.purchaseOrder.update({
        where: { id: o.id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      await this.audit.log({
        action: 'LPO_CLOSED',
        entityType: 'PurchaseOrder',
        entityId: o.uniqueId,
      });
    }
  }

  private async load(uniqueId: string) {
    const inv = await this.prisma.db.invoice.findUnique({
      where: { uniqueId },
    });
    if (!inv) throw new NotFoundException('errors.record_not_found');
    return inv;
  }

  async list(user: CurrentUser) {
    const rows = await this.prisma.db.invoice.findMany({
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return Promise.all(rows.map((r) => this.present(user, r)));
  }

  async get(user: CurrentUser, uniqueId: string) {
    return this.present(user, await this.load(uniqueId));
  }

  private async present(
    user: CurrentUser,
    inv: Prisma.InvoiceGetPayload<object>,
  ) {
    const [o, files, users, approval] = await Promise.all([
      this.prisma.db.purchaseOrder.findUniqueOrThrow({
        where: { id: inv.orderId },
      }),
      this.prisma.db.file.findMany({
        where: {
          id: {
            in: [inv.fileId, ...inv.paymentFileIds].filter(
              (x): x is number => !!x,
            ),
          },
        },
      }),
      this.prisma.dbRaw.user.findMany({
        where: {
          id: {
            in: [inv.registeredById, inv.paymentById].filter(
              (x): x is number => !!x,
            ),
          },
        },
        include: { employee: true },
      }),
      inv.approvalRequestId
        ? this.prisma.db.approvalRequest.findUnique({
            where: { id: inv.approvalRequestId },
          })
        : null,
    ]);
    const vendor = o.vendorId
      ? await this.prisma.db.vendor.findUnique({ where: { id: o.vendorId } })
      : null;
    const f = (id: number | null) => {
      const x = files.find((y) => y.id === id);
      return x
        ? { uniqueId: x.uniqueId, filename: x.filename, uri: x.uri }
        : null;
    };
    const name = (id: number | null) => {
      const u = users.find((x) => x.id === id);
      return u ? fullName(u.employee) : null;
    };
    const [reg, pay] = await Promise.all([
      this.access.hasAny(user, 'invoice.register'),
      this.access.hasAny(user, 'payment.record'),
    ]);
    return {
      uniqueId: inv.uniqueId,
      order: { uniqueId: o.uniqueId, number: o.number, status: o.status },
      vendor: vendor?.name ?? o.shopName ?? '',
      vendorInvoiceNo: inv.vendorInvoiceNo,
      invoiceDate: inv.invoiceDate,
      amountInclVat: D(inv.amountInclVat),
      vatAmount: D(inv.vatAmount),
      amountExclVat: round2(D(inv.amountInclVat) - D(inv.vatAmount)),
      file: f(inv.fileId),
      status: inv.status,
      note: inv.note,
      registeredBy: name(inv.registeredById),
      createdAt: inv.createdAt,
      approvalUniqueId: approval?.uniqueId ?? null,
      paymentReference: inv.paymentReference,
      paidAt: inv.paidAt,
      paidAmount: inv.paidAmount == null ? null : D(inv.paidAmount),
      paymentFiles: inv.paymentFileIds.map((id) => f(id)).filter((x) => !!x),
      paymentBy: name(inv.paymentById),
      match: await this.match(inv.orderId),
      can: {
        requestPayment: reg && ['REGISTERED', 'REJECTED'].includes(inv.status),
        recordPayment: pay && inv.status === 'APPROVED',
      },
    };
  }
}
