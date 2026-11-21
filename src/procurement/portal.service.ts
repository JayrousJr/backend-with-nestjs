import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@prisma';
import { AppConfigService } from '@config';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccessService } from '@access';
import type { VendorPrincipal } from './vendor-auth.service';
import { VendorsService } from './vendors.service';
import { OrdersService } from './orders.service';
import {
  D,
  round2,
  seal,
  specText,
  unseal,
  vatParts,
  type SealedLine,
} from './procurement.util';
import type { CurrentUser } from '@common';

export interface BidInput {
  validityDays: number;
  fileUniqueIds?: string[];
  lines: {
    lineNo: number;
    unitPrice: number;
    deliveryDays: number;
    brand?: string | null;
    model?: string | null;
    countryOfOrigin?: string | null;
    compliance: {
      specId: number;
      complies: boolean;
      offered?: string | null;
    }[];
    fileUniqueIds?: string[];
  }[];
}

/**
 * The vendor portal (requirements §4.4; tender spec §7–§9). Everything is
 * scoped to the signed-in vendor (own_vendor). Bids are sealed until the
 * opening and can only be changed before the closing time (server time).
 */
@Injectable()
export class PortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly notifications: NotificationsService,
    private readonly access: AccessService,
    private readonly vendors: VendorsService,
    private readonly orders: OrdersService,
  ) {}

  private vendor(v: VendorPrincipal) {
    return this.prisma.db.vendor.findUniqueOrThrow({
      where: { id: v.vendorId },
    });
  }

  async me(v: VendorPrincipal) {
    const vendor = await this.vendor(v);
    const unread = await this.prisma.db.vendorNotification.count({
      where: { vendorId: v.vendorId, readAt: null },
    });
    return {
      user: {
        uniqueId: v.vendorUserUniqueId,
        fullName: v.fullName,
        email: v.email,
        isAdmin: v.isAdmin,
      },
      vendor: {
        uniqueId: vendor.uniqueId,
        number: vendor.number,
        name: vendor.name,
        status: vendor.status,
        validUntil: vendor.validUntil,
        canBid: VendorsService.canBid(vendor),
      },
      unread,
    };
  }

  private async tender(v: VendorPrincipal, uniqueId: string) {
    const t = await this.prisma.db.tender.findUnique({
      where: { uniqueId },
      include: {
        lines: { orderBy: { lineNo: 'asc' } },
        invites: true,
        addenda: { orderBy: { number: 'asc' } },
        clarifications: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (
      !t ||
      !t.invites.some((i) => i.vendorId === v.vendorId) ||
      t.status === 'DRAFT'
    )
      throw new NotFoundException('errors.record_not_found');
    return t;
  }

  /** Hours before closing when questions stop (0 when the policy is off). */
  private async clarifyHours() {
    if (!(await this.policy.isEnabled('PROC_CLARIFICATIONS'))) return 0;
    const p = await this.policy.params<{ deadlineHours: number }>(
      'PROC_CLARIFICATIONS',
    );
    return p.deadlineHours ?? 0;
  }

  private isOpenForBids(t: { status: string; closingAt: Date | null }) {
    return (
      t.status === 'PUBLISHED' && !!t.closingAt && t.closingAt > new Date()
    );
  }

  async tenders(v: VendorPrincipal) {
    const rows = await this.prisma.db.tender.findMany({
      where: {
        invites: { some: { vendorId: v.vendorId } },
        status: { not: 'DRAFT' },
      },
      include: { lines: true, bids: { where: { vendorId: v.vendorId } } },
      orderBy: { publishedAt: 'desc' },
    });
    return rows.map((t) => ({
      uniqueId: t.uniqueId,
      number: t.number,
      title: t.title,
      status: this.isOpenForBids(t)
        ? 'OPEN'
        : t.status === 'PUBLISHED'
          ? 'CLOSED'
          : t.status,
      closingAt: t.closingAt,
      lineCount: t.lines.length,
      myBid: t.bids[0]?.status ?? null,
      publishedAt: t.publishedAt,
    }));
  }

  async tenderDetail(v: VendorPrincipal, uniqueId: string) {
    const t = await this.tender(v, uniqueId);
    const vendor = await this.vendor(v);
    const [versions, products, specs, bid, files] = await Promise.all([
      this.prisma.db.productVersion.findMany({
        where: { id: { in: t.lines.map((l) => l.productVersionId) } },
        include: { category: true, attachments: true },
      }),
      this.prisma.db.product.findMany({
        where: { id: { in: t.lines.map((l) => l.productId) } },
      }),
      this.prisma.db.productSpec.findMany({
        where: { versionId: { in: t.lines.map((l) => l.productVersionId) } },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.db.bid.findUnique({
        where: { tenderId_vendorId: { tenderId: t.id, vendorId: v.vendorId } },
        include: { lines: true },
      }),
      this.prisma.db.file.findMany({
        where: {
          id: {
            in: t.addenda.map((a) => a.fileId).filter((x): x is number => !!x),
          },
        },
      }),
    ]);
    // Own bid: from the seal before opening, from the opened lines after.
    let mine: SealedLine[] = [];
    if (bid?.sealed) mine = unseal(bid.sealed, this.config.bidSealKey);
    else if (bid?.lines.length)
      mine = bid.lines.map((l) => ({
        tenderLineId: l.tenderLineId,
        unitPrice: D(l.unitPrice),
        deliveryDays: l.deliveryDays,
        brand: l.brand,
        model: l.model,
        countryOfOrigin: l.countryOfOrigin,
        compliance: l.compliance as SealedLine['compliance'],
        fileIds: l.fileIds,
      }));
    const bidFiles = await this.prisma.db.file.findMany({
      where: {
        id: {
          in: [...(bid?.fileIds ?? []), ...mine.flatMap((m) => m.fileIds)],
        },
      },
    });
    const fref = (id: number) => {
      const f = [...files, ...bidFiles].find((x) => x.id === id);
      return f
        ? { uniqueId: f.uniqueId, filename: f.filename, uri: f.uri }
        : null;
    };
    const open = this.isOpenForBids(t);
    const deadlineHours = await this.clarifyHours();
    const clarifyUntil = t.closingAt
      ? new Date(t.closingAt.getTime() - (deadlineHours ?? 0) * 3.6e6)
      : null;
    return {
      uniqueId: t.uniqueId,
      number: t.number,
      title: t.title,
      description: t.description,
      deliveryTerms: t.deliveryTerms,
      terms: t.terms,
      closingAt: t.closingAt,
      serverTime: new Date(),
      bidValidityDays: t.bidValidityDays,
      status: open ? 'OPEN' : t.status === 'PUBLISHED' ? 'CLOSED' : t.status,
      canBid: open && VendorsService.canBid(vendor),
      canAsk: open && !!clarifyUntil && clarifyUntil > new Date(),
      clarifyUntil,
      lines: t.lines.map((l) => {
        const ver = versions.find((x) => x.id === l.productVersionId)!;
        const p = products.find((x) => x.id === l.productId)!;
        const m = mine.find((x) => x.tenderLineId === l.id);
        const outcome =
          t.status === 'AWARDED' && t.lettersSentAt
            ? bid?.lines.find((x) => x.tenderLineId === l.id)
              ? l.awardBidLineId &&
                bid.lines.some((x) => x.id === l.awardBidLineId)
                ? 'WON'
                : 'NOT_AWARDED'
              : null
            : null;
        return {
          lineNo: l.lineNo,
          productName: ver.name,
          description: ver.description,
          categoryName: ver.category.name,
          unit: ver.unit,
          quantity: l.quantity,
          vatRate: D(p.vatRate ?? 18),
          specs: specs
            .filter((s) => s.versionId === ver.id)
            .map((s) => ({ id: s.id, text: specText(s) })),
          myOffer: m
            ? {
                unitPrice: m.unitPrice,
                ...(() => {
                  const parts = vatParts(m.unitPrice, D(p.vatRate ?? 18));
                  return {
                    unitExclVat: parts.excl,
                    unitVat: parts.vat,
                    lineTotal: round2(m.unitPrice * l.quantity),
                  };
                })(),
                deliveryDays: m.deliveryDays,
                brand: m.brand ?? null,
                model: m.model ?? null,
                countryOfOrigin: m.countryOfOrigin ?? null,
                compliance: m.compliance,
                files: m.fileIds.map(fref).filter((x) => !!x),
              }
            : null,
          outcome,
        };
      }),
      myBid: bid
        ? {
            status: bid.status,
            validityDays: bid.validityDays,
            submittedAt: bid.submittedAt,
            files: bid.fileIds.map(fref).filter((x) => !!x),
          }
        : null,
      clarifications: t.clarifications
        .filter((c) => c.answer || c.vendorId === v.vendorId)
        .map((c) => ({
          question: c.question,
          answer: c.answer,
          mine: c.vendorId === v.vendorId,
          askedAt: c.createdAt,
          answeredAt: c.answeredAt,
        })),
      addenda: t.addenda.map((a) => ({
        number: a.number,
        text: a.text,
        newClosingAt: a.newClosingAt,
        file: a.fileId ? fref(a.fileId) : null,
        createdAt: a.createdAt,
      })),
    };
  }

  async ask(v: VendorPrincipal, uniqueId: string, question: string) {
    const t = await this.tender(v, uniqueId);
    if (!this.isOpenForBids(t))
      throw new BadRequestException('errors.tender_closed');
    const deadlineHours = await this.clarifyHours();
    if (t.closingAt!.getTime() - (deadlineHours ?? 0) * 3.6e6 < Date.now())
      throw new BadRequestException('errors.clarification_deadline');
    if (question.trim().length < 5)
      throw new BadRequestException('errors.question_required');
    await this.prisma.db.tenderClarification.create({
      data: { tenderId: t.id, vendorId: v.vendorId, question: question.trim() },
    });
    const users = await this.access.usersWithPermission(
      'tender.answer_clarification',
    );
    for (const id of users)
      await this.notifications.notify(id, {
        titleKey: 'notifications.clarification_title',
        messageKey: 'notifications.clarification_message',
        params: { number: t.number },
        link: `/tenders/${t.uniqueId}`,
      });
    return this.tenderDetail(v, uniqueId);
  }

  private async fileIds(uniqueIds?: string[]) {
    if (!uniqueIds?.length) return [];
    const files = await this.prisma.db.file.findMany({
      where: { uniqueId: { in: uniqueIds } },
    });
    return files.map((f) => f.id);
  }

  /** Save (and optionally submit) the bid. Full quantity per item; vendors choose which items. */
  async saveBid(
    v: VendorPrincipal,
    uniqueId: string,
    input: BidInput,
    submit: boolean,
  ) {
    const t = await this.tender(v, uniqueId);
    const vendor = await this.vendor(v);
    if (!this.isOpenForBids(t))
      throw new BadRequestException('errors.tender_closed');
    if (!VendorsService.canBid(vendor))
      throw new ForbiddenException('errors.vendor_cannot_bid');
    const specs = await this.prisma.db.productSpec.findMany({
      where: { versionId: { in: t.lines.map((l) => l.productVersionId) } },
    });
    const lines: SealedLine[] = [];
    for (const l of input.lines) {
      const tl = t.lines.find((x) => x.lineNo === l.lineNo);
      if (!tl) throw new NotFoundException('errors.record_not_found');
      const lineSpecs = specs.filter(
        (s) => s.versionId === tl.productVersionId,
      );
      if (submit) {
        if (!(l.unitPrice > 0) || !(l.deliveryDays > 0))
          throw new BadRequestException({
            message: 'errors.bid_line_incomplete',
            args: { line: l.lineNo },
          });
        if (lineSpecs.some((s) => !l.compliance.some((c) => c.specId === s.id)))
          throw new BadRequestException({
            message: 'errors.bid_compliance_missing',
            args: { line: l.lineNo },
          });
      }
      lines.push({
        tenderLineId: tl.id,
        unitPrice: Number(l.unitPrice) || 0,
        deliveryDays: Math.round(Number(l.deliveryDays) || 0),
        brand: l.brand?.trim() || null,
        model: l.model?.trim() || null,
        countryOfOrigin: l.countryOfOrigin?.trim() || null,
        compliance: l.compliance
          .filter((c) => lineSpecs.some((s) => s.id === c.specId))
          .map((c) => ({
            specId: c.specId,
            complies: !!c.complies,
            offered: c.offered?.trim() || null,
          })),
        fileIds: await this.fileIds(l.fileUniqueIds),
      });
    }
    if (submit && !lines.length)
      throw new BadRequestException('errors.bid_no_items');
    const { days } = await this.policy.params<{ days: number }>(
      'PROC_BID_VALIDITY',
    );
    if (
      submit &&
      (input.validityDays ?? 0) < Math.max(days ?? 0, t.bidValidityDays)
    )
      throw new BadRequestException({
        message: 'errors.bid_validity',
        args: { days: Math.max(days ?? 0, t.bidValidityDays) },
      });
    const existing = await this.prisma.db.bid.findUnique({
      where: { tenderId_vendorId: { tenderId: t.id, vendorId: v.vendorId } },
    });
    const data = {
      sealed: seal(lines, this.config.bidSealKey),
      lineCount: lines.length,
      validityDays: input.validityDays || null,
      fileIds: await this.fileIds(input.fileUniqueIds),
      ...(submit
        ? {
            status: 'SUBMITTED' as const,
            submittedAt: new Date(),
            submittedByUserId: v.vendorUserId,
            withdrawnAt: null,
          }
        : {}),
    };
    if (existing)
      await this.prisma.db.bid.update({ where: { id: existing.id }, data });
    else
      await this.prisma.db.bid.create({
        data: { tenderId: t.id, vendorId: v.vendorId, ...data },
      });
    if (submit)
      await this.audit.log({
        action: 'BID_SUBMITTED',
        entityType: 'Tender',
        entityId: t.uniqueId,
        after: { vendor: v.vendorId, by: v.email, items: lines.length },
      });
    return this.tenderDetail(v, uniqueId);
  }

  async withdraw(v: VendorPrincipal, uniqueId: string) {
    const t = await this.tender(v, uniqueId);
    if (!this.isOpenForBids(t))
      throw new BadRequestException('errors.tender_closed');
    const bid = await this.prisma.db.bid.findUnique({
      where: { tenderId_vendorId: { tenderId: t.id, vendorId: v.vendorId } },
    });
    if (!bid || bid.status !== 'SUBMITTED')
      throw new BadRequestException('errors.bid_not_submitted');
    await this.prisma.db.bid.update({
      where: { id: bid.id },
      data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
    });
    await this.audit.log({
      action: 'BID_WITHDRAWN',
      entityType: 'Tender',
      entityId: t.uniqueId,
      after: { vendor: v.vendorId, by: v.email },
    });
    return this.tenderDetail(v, uniqueId);
  }

  // ── LPOs ────────────────────────────────────────────────────────────────

  private principalUser(v: VendorPrincipal): CurrentUser {
    return {
      id: -1,
      uniqueId: v.vendorUserUniqueId,
      email: v.email,
      employeeId: -1,
      departmentId: -1,
    } as unknown as CurrentUser;
  }

  orders_(v: VendorPrincipal) {
    return this.orders.list(this.principalUser(v), undefined, v.vendorId);
  }

  order(v: VendorPrincipal, uniqueId: string) {
    return this.orders.get(this.principalUser(v), uniqueId, v.vendorId);
  }

  async acknowledge(v: VendorPrincipal, uniqueId: string) {
    await this.orders.acknowledge(
      v.vendorId,
      uniqueId,
      `${v.fullName} <${v.email}>`,
    );
    return this.order(v, uniqueId);
  }

  // ── notifications ───────────────────────────────────────────────────────

  async notificationsList(v: VendorPrincipal) {
    return this.prisma.db.vendorNotification.findMany({
      where: { vendorId: v.vendorId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        uniqueId: true,
        type: true,
        title: true,
        body: true,
        link: true,
        readAt: true,
        createdAt: true,
      },
    });
  }

  async markRead(v: VendorPrincipal) {
    await this.prisma.db.vendorNotification.updateMany({
      where: { vendorId: v.vendorId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  // ── own users (vendor admin) ────────────────────────────────────────────

  async users(v: VendorPrincipal) {
    const rows = await this.prisma.db.vendorUser.findMany({
      where: { vendorId: v.vendorId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((u) => this.vendors.presentUser(u));
  }
}
