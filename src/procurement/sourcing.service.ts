import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma, ProcurementRoute, TenderStatus } from '@db';
import { PrismaService, type DbTx } from '@prisma';
import type { CurrentUser } from '@common';
import { AppConfigService } from '@config';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { PolicyService } from '../policy/policy.service';
import {
  APPROVAL_COMPLETED,
  WorkflowService,
  type ApprovalCompletedEvent,
} from '../workflow/workflow.service';
import { VendorsService } from './vendors.service';
import { D, round2, specText, unseal, vatParts } from './procurement.util';

const SS_POINT = 'single_source.justification';
const AWARD_POINT = 'tender.award_approval';

export interface LineRef {
  purchaseRequestUniqueId: string;
  lineNo: number;
}

export interface TenderInput {
  title: string;
  description?: string | null;
  deliveryTerms?: string | null;
  terms?: string | null;
  closingAt?: string | null;
  bidValidityDays?: number | null;
}

/** Emitted when an award is approved: { tenderId }. */
export const TENDER_AWARDED = 'tender.awarded';

/**
 * Sourcing (tender spec §6.3, §7; requirements §4.3–§4.6): Purchasing routes
 * approved request lines, combines them into tenders, publishes to eligible
 * vendors, opens sealed bids with a committee quorum, evaluates every item
 * automatically, and sends the award for committee + CEO approval.
 */
@Injectable()
export class SourcingService implements OnModuleInit {
  private readonly logger = new Logger(SourcingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly policy: PolicyService,
    private readonly workflow: WorkflowService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit() {
    this.workflow.registerGuard(AWARD_POINT, async (actor, request, d) => {
      if (d.decision === 'COMMENT') return;
      const tender = await this.prisma.db.tender.findUnique({
        where: { uniqueId: request.subjectId },
        include: { committee: true },
      });
      if (!tender) return;
      const member = tender.committee.find((m) => m.userId === actor.id);
      if (d.stepCode === 'committee_approval') {
        await this.policy.enforceSod(
          'SOD_COMMITTEE_COI',
          !member?.coiDeclaredAt,
        );
      } else {
        // The final approver cannot sit on the committee.
        await this.policy.enforceSod('SOD_AWARD_COMMITTEE', !!member);
      }
    });
  }

  // ── Purchasing queue and routes (§6.3) ──────────────────────────────────

  private async cashThreshold() {
    if (!(await this.policy.isEnabled('PROC_CASH_THRESHOLD'))) return 0;
    const p = await this.policy.params<{ amount: number }>(
      'PROC_CASH_THRESHOLD',
    );
    return Number(p.amount ?? 0);
  }

  /** Approved request lines waiting for Purchasing (or for a justification). */
  async queue() {
    const lines = await this.prisma.db.purchaseRequestLine.findMany({
      where: {
        sourcingStatus: { in: ['OPEN', 'JUSTIFICATION'] },
        purchaseRequest: { status: { in: ['APPROVED', 'IN_PROCUREMENT'] } },
      },
      include: { purchaseRequest: true },
      orderBy: [{ purchaseRequestId: 'asc' }, { lineNo: 'asc' }],
    });
    return this.presentLines(lines);
  }

  async presentLines(
    lines: Prisma.PurchaseRequestLineGetPayload<{
      include: { purchaseRequest: true };
    }>[],
  ) {
    const threshold = await this.cashThreshold();
    const [products, versions, depts, vendors, approvals] = await Promise.all([
      this.prisma.db.product.findMany({
        where: { id: { in: lines.map((l) => l.productId) } },
      }),
      this.prisma.db.productVersion.findMany({
        where: { id: { in: lines.map((l) => l.productVersionId) } },
        include: { category: true },
      }),
      this.prisma.db.department.findMany({
        where: { id: { in: lines.map((l) => l.purchaseRequest.departmentId) } },
      }),
      this.prisma.db.vendor.findMany(),
      this.prisma.db.approvalRequest.findMany({
        where: {
          id: {
            in: lines
              .map((l) => l.justificationApprovalId)
              .filter((x): x is number => !!x),
          },
        },
      }),
    ]);
    const by = <T extends { id: number }>(l: T[]) =>
      new Map(l.map((x) => [x.id, x]));
    const [pB, vB, dB, venB, aB] = [
      by(products),
      by(versions),
      by(depts),
      by(vendors),
      by(approvals),
    ];
    return lines.map((l) => {
      const p = pB.get(l.productId)!;
      const v = vB.get(l.productVersionId)!;
      const estimate = D(v.referencePrice) * l.quantity;
      const ssVendor = p.singleSourceVendorId
        ? venB.get(p.singleSourceVendorId)
        : undefined;
      const suggested: ProcurementRoute =
        estimate > 0 && estimate < threshold
          ? 'CASH'
          : p.acquisitionMethod === 'SINGLE_SOURCE'
            ? 'SINGLE_SOURCE'
            : 'QUOTATION';
      const ap = l.justificationApprovalId
        ? aB.get(l.justificationApprovalId)
        : undefined;
      return {
        purchaseRequestUniqueId: l.purchaseRequest.uniqueId,
        purchaseRequestNumber: l.purchaseRequest.number,
        department: dB.get(l.purchaseRequest.departmentId)?.name ?? '',
        lineNo: l.lineNo,
        productUniqueId: p.uniqueId,
        productCode: p.code,
        productName: v.name,
        categoryName: v.category.name,
        unit: v.unit,
        quantity: l.quantity,
        referencePrice: v.referencePrice == null ? null : D(v.referencePrice),
        estimate: estimate || null,
        acquisitionMethod: p.acquisitionMethod,
        singleSourceVendor: ssVendor
          ? { uniqueId: ssVendor.uniqueId, name: ssVendor.name }
          : null,
        route: l.route,
        suggestedRoute: suggested,
        sourcingStatus: l.sourcingStatus,
        justification: l.justification,
        justificationStatus: ap?.status ?? null,
        justificationApprovalUniqueId: ap?.uniqueId ?? null,
      };
    });
  }

  private async findLines(refs: LineRef[], tx?: DbTx) {
    const db = tx ?? this.prisma.db;
    const prs = await db.purchaseRequest.findMany({
      where: {
        uniqueId: {
          in: [...new Set(refs.map((r) => r.purchaseRequestUniqueId))],
        },
      },
      include: { lines: true },
    });
    return refs.map((r) => {
      const pr = prs.find((p) => p.uniqueId === r.purchaseRequestUniqueId);
      const line = pr?.lines.find((l) => l.lineNo === r.lineNo);
      if (!pr || !line) throw new NotFoundException('errors.record_not_found');
      if (!['APPROVED', 'IN_PROCUREMENT'].includes(pr.status))
        throw new BadRequestException('errors.request_not_approved');
      return { pr, line };
    });
  }

  /** Purchasing sets the route per line; single source needs the CEO's justification approval. */
  async setRoute(
    actor: CurrentUser,
    refs: LineRef[],
    route: ProcurementRoute,
    justification?: string | null,
    justificationFileUniqueId?: string | null,
  ) {
    if (!refs.length) throw new BadRequestException('errors.no_lines');
    const found = await this.findLines(refs);
    if (found.some((f) => f.line.sourcingStatus !== 'OPEN'))
      throw new BadRequestException('errors.line_not_open');
    if (route === 'SINGLE_SOURCE') {
      if (!justification || justification.trim().length < 10)
        throw new BadRequestException('errors.justification_required');
      const products = await this.prisma.db.product.findMany({
        where: { id: { in: found.map((f) => f.line.productId) } },
      });
      if (products.some((p) => !p.singleSourceVendorId))
        throw new BadRequestException('errors.no_single_source_vendor');
    }
    const file = justificationFileUniqueId
      ? await this.prisma.db.file.findUnique({
          where: { uniqueId: justificationFileUniqueId },
        })
      : null;
    await this.prisma.db.$transaction(async (tx) => {
      for (const { pr, line } of found) {
        let approvalId: number | null = null;
        if (route === 'SINGLE_SOURCE') {
          const req = await this.workflow.start(
            {
              pointCode: SS_POINT,
              subjectType: 'PurchaseRequestLine',
              subjectId: `${pr.uniqueId}#${line.lineNo}`,
              subjectDepartmentId: pr.departmentId,
              title: `Single source: ${pr.number} line ${line.lineNo}`,
              requesterUserId: actor.id,
            },
            tx,
          );
          approvalId = req.id;
        }
        await tx.purchaseRequestLine.update({
          where: { id: line.id },
          data: {
            route,
            routeSetById: actor.id,
            routeSetAt: new Date(),
            sourcingStatus:
              route === 'SINGLE_SOURCE' ? 'JUSTIFICATION' : 'OPEN',
            justification:
              route === 'SINGLE_SOURCE' ? justification!.trim() : null,
            justificationFileId:
              route === 'SINGLE_SOURCE' ? (file?.id ?? null) : null,
            justificationApprovalId: approvalId,
          },
        });
        if (pr.status === 'APPROVED')
          await tx.purchaseRequest.update({
            where: { id: pr.id },
            data: { status: 'IN_PROCUREMENT' },
          });
        await this.audit.log(
          {
            action: 'PR_LINE_ROUTE',
            entityType: 'PurchaseRequest',
            entityId: pr.uniqueId,
            after: { lineNo: line.lineNo, route },
          },
          tx,
        );
      }
    });
    return this.queue();
  }

  // ── tenders ─────────────────────────────────────────────────────────────

  private async tenderWhere(
    user: CurrentUser,
  ): Promise<Prisma.TenderWhereInput> {
    const s = await this.access.resolveScope(user, 'tender.view');
    if (s.all) return {};
    return { committee: { some: { userId: user.id } } };
  }

  /** Users who did the procurement review of the source requests (SOD_REVIEW_TENDER). */
  private async reviewers(prIds: number[]) {
    const prs = await this.prisma.db.purchaseRequest.findMany({
      where: { id: { in: prIds } },
      select: { approvalRequestId: true },
    });
    const reqs = await this.prisma.db.approvalRequest.findMany({
      where: {
        id: {
          in: prs
            .map((p) => p.approvalRequestId)
            .filter((x): x is number => !!x),
        },
      },
      include: { version: { include: { steps: true } }, actions: true },
    });
    const ids = new Set<number>();
    for (const r of reqs) {
      const orders = new Set(
        r.version?.steps
          .filter((st) => st.code === 'procurement_review')
          .map((st) => st.order) ?? [],
      );
      for (const a of r.actions)
        if (
          a.userId &&
          a.stepOrder != null &&
          orders.has(a.stepOrder) &&
          a.decision === 'APPROVE'
        )
          ids.add(a.userId);
    }
    return ids;
  }

  async createTender(
    actor: CurrentUser,
    refs: LineRef[],
    route: ProcurementRoute,
    input: TenderInput,
  ) {
    if (route === 'CASH')
      throw new BadRequestException('errors.cash_not_tendered');
    if (!refs.length) throw new BadRequestException('errors.no_lines');
    const found = await this.findLines(refs);
    for (const { line } of found) {
      if (line.sourcingStatus !== 'OPEN' || line.route !== route)
        throw new BadRequestException('errors.line_not_ready_for_tender');
    }
    const reviewers = await this.reviewers(found.map((f) => f.pr.id));
    await this.policy.enforceSod('SOD_REVIEW_TENDER', reviewers.has(actor.id));
    let singleSourceVendorId: number | null = null;
    if (route === 'SINGLE_SOURCE') {
      const products = await this.prisma.db.product.findMany({
        where: { id: { in: found.map((f) => f.line.productId) } },
      });
      const ids = new Set(products.map((p) => p.singleSourceVendorId));
      if (ids.size !== 1 || ids.has(null))
        throw new BadRequestException('errors.single_source_one_vendor');
      singleSourceVendorId = [...ids][0]!;
    }
    const { days } = await this.policy.params<{ days: number }>(
      'PROC_BID_VALIDITY',
    );
    const t = await this.prisma.db.$transaction(async (tx) => {
      // Combine lines of the same product version into one tender line (full quantity).
      const groups = new Map<string, typeof found>();
      for (const f of found) {
        const k = `${f.line.productId}:${f.line.productVersionId}`;
        groups.set(k, [...(groups.get(k) ?? []), f]);
      }
      const tender = await tx.tender.create({
        data: {
          number: await this.numbering.document('TND', tx, 3),
          title: input.title.trim(),
          route,
          description: input.description?.trim() || null,
          deliveryTerms: input.deliveryTerms?.trim() || null,
          terms: input.terms?.trim() || null,
          closingAt: input.closingAt ? new Date(input.closingAt) : null,
          bidValidityDays: Math.max(
            input.bidValidityDays ?? days ?? 90,
            days ?? 0,
          ),
          singleSourceVendorId,
          createdByUserId: actor.id,
          lines: {
            create: [...groups.values()].map((g, i) => ({
              lineNo: i + 1,
              productId: g[0].line.productId,
              productVersionId: g[0].line.productVersionId,
              quantity: g.reduce((n, f) => n + f.line.quantity, 0),
              sources: {
                create: g.map((f) => ({
                  purchaseRequestLineId: f.line.id,
                  quantity: f.line.quantity,
                })),
              },
            })),
          },
        },
      });
      await tx.purchaseRequestLine.updateMany({
        where: { id: { in: found.map((f) => f.line.id) } },
        data: { sourcingStatus: 'IN_TENDER' },
      });
      await this.audit.log(
        {
          action: 'TENDER_CREATED',
          entityType: 'Tender',
          entityId: tender.uniqueId,
          after: { number: tender.number },
        },
        tx,
      );
      return tender;
    });
    return this.get(actor, t.uniqueId);
  }

  private async load(uniqueId: string) {
    const t = await this.prisma.db.tender.findUnique({
      where: { uniqueId },
      include: {
        lines: { include: { sources: true }, orderBy: { lineNo: 'asc' } },
        committee: true,
        invites: true,
      },
    });
    if (!t) throw new NotFoundException('errors.record_not_found');
    return t;
  }

  async updateTender(actor: CurrentUser, uniqueId: string, input: TenderInput) {
    const t = await this.load(uniqueId);
    if (t.status !== 'DRAFT')
      throw new BadRequestException('errors.tender_not_draft');
    await this.prisma.db.tender.update({
      where: { id: t.id },
      data: {
        title: input.title.trim(),
        description: input.description?.trim() || null,
        deliveryTerms: input.deliveryTerms?.trim() || null,
        terms: input.terms?.trim() || null,
        closingAt: input.closingAt ? new Date(input.closingAt) : null,
        bidValidityDays: input.bidValidityDays ?? t.bidValidityDays,
      },
    });
    return this.get(actor, uniqueId);
  }

  /** Final award approvers: holders of the last step of the award chain. */
  private async finalApprovers() {
    const point = await this.prisma.db.approvalPoint.findUnique({
      where: { code: AWARD_POINT },
      include: { activeVersion: { include: { steps: true } } },
    });
    const steps =
      point?.activeVersion?.steps.filter(
        (s) => s.rule !== 'TENDER_COMMITTEE',
      ) ?? [];
    const ids = new Set<number>();
    for (const s of steps) {
      for (const id of await this.workflow.resolveAssignees(s, {
        subjectDepartmentId: null,
        requesterUserId: null,
      }))
        ids.add(id);
    }
    return ids;
  }

  /** Committee per tender: owning department + Finance + another department (§7). */
  async appointCommittee(
    actor: CurrentUser,
    uniqueId: string,
    userUniqueIds: string[],
    chairUniqueId?: string | null,
  ) {
    const t = await this.load(uniqueId);
    if (!['DRAFT', 'PUBLISHED', 'CLOSED'].includes(t.status))
      throw new BadRequestException('errors.committee_locked');
    const users = await this.prisma.db.user.findMany({
      where: { uniqueId: { in: userUniqueIds }, status: 'ACTIVE' },
    });
    if (users.length !== new Set(userUniqueIds).size)
      throw new BadRequestException('errors.record_not_found');
    const { count } = await this.policy.params<{ count: number }>(
      'PROC_OPENING_CONFIRMATIONS',
    );
    if (users.length < (count ?? 2))
      throw new BadRequestException({
        message: 'errors.committee_too_small',
        args: { min: count ?? 2 },
      });
    await this.policy.enforceSod(
      'SOD_TENDER_COMMITTEE',
      users.some(
        (u) => u.id === t.createdByUserId || u.id === t.publishedByUserId,
      ),
    );
    const finals = await this.finalApprovers();
    await this.policy.enforceSod(
      'SOD_AWARD_COMMITTEE',
      users.some((u) => finals.has(u.id)),
    );
    for (const u of users) {
      const cu = { id: u.id } as CurrentUser;
      if (
        !(await this.access.hasAny(
          { ...cu, departmentId: 0 },
          'tender.evaluate',
        ))
      )
        throw new BadRequestException({
          message: 'errors.not_committee_member_role',
          args: { email: u.email },
        });
    }
    await this.prisma.db.$transaction(async (tx) => {
      const keep = users.map((u) => u.id);
      await tx.tenderCommitteeMember.deleteMany({
        where: { tenderId: t.id, userId: { notIn: keep } },
      });
      for (const u of users) {
        await tx.tenderCommitteeMember.upsert({
          where: { tenderId_userId: { tenderId: t.id, userId: u.id } },
          update: { isChair: u.uniqueId === chairUniqueId },
          create: {
            tenderId: t.id,
            userId: u.id,
            isChair: u.uniqueId === chairUniqueId,
          },
        });
      }
      await this.audit.log(
        {
          action: 'TENDER_COMMITTEE',
          entityType: 'Tender',
          entityId: t.uniqueId,
          after: { members: users.map((u) => u.email) },
        },
        tx,
      );
    });
    for (const u of users)
      await this.notifications.notify(u.id, {
        titleKey: 'notifications.committee_appointed_title',
        messageKey: 'notifications.committee_appointed_message',
        params: { number: t.number, title: t.title },
        link: `/tenders/${t.uniqueId}`,
      });
    return this.get(actor, uniqueId);
  }

  /** Member declares no conflict of interest (SOD_COMMITTEE_COI), or reports one. */
  async declareCoi(
    actor: CurrentUser,
    uniqueId: string,
    noConflict: boolean,
    statement: string,
  ) {
    const t = await this.load(uniqueId);
    const m = t.committee.find((x) => x.userId === actor.id);
    if (!m) throw new ForbiddenException('errors.forbidden');
    await this.prisma.db.tenderCommitteeMember.update({
      where: { id: m.id },
      data: {
        coiDeclaredAt: noConflict ? new Date() : null,
        coiStatement: statement.trim() || null,
      },
    });
    await this.audit.log({
      action: noConflict ? 'TENDER_COI_DECLARED' : 'TENDER_COI_CONFLICT',
      entityType: 'Tender',
      entityId: t.uniqueId,
      after: { statement },
    });
    if (!noConflict) {
      // Procurement must replace the member.
      await this.notifyHolders('tender.appoint_committee', {
        titleKey: 'notifications.committee_conflict_title',
        messageKey: 'notifications.committee_conflict_message',
        params: { number: t.number },
        link: `/tenders/${t.uniqueId}`,
      });
    }
    return this.get(actor, uniqueId);
  }

  private async notifyHolders(
    permission: 'tender.appoint_committee' | 'tender.create',
    input: Parameters<NotificationsService['notify']>[1],
  ) {
    const users = await this.access.usersWithPermission(permission);
    for (const id of users) await this.notifications.notify(id, input);
  }

  /** Publish to eligible vendors; policies are snapshotted on the tender. */
  async publish(actor: CurrentUser, uniqueId: string) {
    const t = await this.load(uniqueId);
    if (t.status !== 'DRAFT')
      throw new BadRequestException('errors.tender_not_draft');
    if (!t.closingAt || t.closingAt.getTime() < Date.now() + 3.6e6)
      throw new BadRequestException('errors.closing_too_soon');
    const { count } = await this.policy.params<{ count: number }>(
      'PROC_OPENING_CONFIRMATIONS',
    );
    if (t.committee.length < (count ?? 2))
      throw new BadRequestException({
        message: 'errors.committee_too_small',
        args: { min: count ?? 2 },
      });
    await this.policy.enforceSod(
      'SOD_TENDER_COMMITTEE',
      t.committee.some((m) => m.userId === actor.id),
    );
    const versions = await this.prisma.db.productVersion.findMany({
      where: { id: { in: t.lines.map((l) => l.productVersionId) } },
    });
    let vendors;
    if (t.route === 'SINGLE_SOURCE') {
      vendors = await this.prisma.db.vendor.findMany({
        where: { id: t.singleSourceVendorId ?? -1 },
      });
    } else {
      vendors = await this.prisma.db.vendor.findMany({
        where: {
          categories: {
            some: { categoryId: { in: versions.map((v) => v.categoryId) } },
          },
        },
      });
    }
    vendors = vendors.filter((v) => VendorsService.canBid(v));
    if (!vendors.length)
      throw new BadRequestException('errors.no_eligible_vendors');
    const snapshot: Record<string, unknown> = {};
    for (const code of [
      'PROC_MIN_QUOTATIONS',
      'PROC_OPENING_CONFIRMATIONS',
      'PROC_CLARIFICATIONS',
      'PROC_BID_VALIDITY',
      'PROC_STANDSTILL',
    ] as const) {
      snapshot[code] = {
        enabled: await this.policy.isEnabled(code),
        ...(await this.policy.params<Record<string, unknown>>(code)),
      };
    }
    await this.prisma.db.$transaction(async (tx) => {
      await tx.tender.update({
        where: { id: t.id },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          publishedByUserId: actor.id,
          policySnapshot: snapshot as Prisma.InputJsonValue,
          invites: { create: vendors.map((v) => ({ vendorId: v.id })) },
        },
      });
      await this.audit.log(
        {
          action: 'TENDER_PUBLISHED',
          entityType: 'Tender',
          entityId: t.uniqueId,
          after: { vendors: vendors.length },
        },
        tx,
      );
    });
    const closing = t.closingAt.toISOString().replace('T', ' ').slice(0, 16);
    for (const v of vendors) {
      await this.vendorNotify(v.id, v.email, {
        type: 'TENDER_INVITATION',
        title: `Invitation to tender ${t.number}`,
        body: `${t.title}. Closing ${closing} UTC (server time). Quote the full quantity of each item you bid on, against the exact specifications.`,
        link: `/portal/tenders/${t.uniqueId}`,
      });
    }
    return this.get(actor, uniqueId);
  }

  async vendorNotify(
    vendorId: number,
    email: string | null,
    n: { type: string; title: string; body: string; link?: string },
  ) {
    await this.prisma.db.vendorNotification.create({
      data: { vendorId, ...n },
    });
    const users = await this.prisma.db.vendorUser.findMany({
      where: { vendorId, status: 'ACTIVE' },
    });
    const to = new Set([
      ...(email ? [email] : []),
      ...users.map((u) => u.email),
    ]);
    for (const e of to)
      await this.mail.queueGeneric({
        email: e,
        subject: `AzamTV — ${n.title}`,
        greeting: 'Dear vendor,',
        body: n.body,
        url: n.link ? `${this.config.frontendUrl}${n.link}` : undefined,
        cta: n.link ? 'Open the vendor portal' : undefined,
      });
  }

  async answerClarification(
    actor: CurrentUser,
    clarificationUniqueId: string,
    answer: string,
  ) {
    const c = await this.prisma.db.tenderClarification.findUnique({
      where: { uniqueId: clarificationUniqueId },
      include: { tender: { include: { invites: true } } },
    });
    if (!c) throw new NotFoundException('errors.record_not_found');
    if (c.tender.status !== 'PUBLISHED')
      throw new BadRequestException('errors.tender_not_published');
    await this.prisma.db.tenderClarification.update({
      where: { id: c.id },
      data: {
        answer: answer.trim(),
        answeredById: actor.id,
        answeredAt: new Date(),
      },
    });
    // Answers go to every invited vendor, without naming who asked.
    for (const inv of c.tender.invites)
      await this.prisma.db.vendorNotification.create({
        data: {
          vendorId: inv.vendorId,
          type: 'CLARIFICATION',
          title: `Clarification on ${c.tender.number}`,
          body: `Q: ${c.question}\nA: ${answer.trim()}`,
          link: `/portal/tenders/${c.tender.uniqueId}`,
        },
      });
    return this.get(actor, c.tender.uniqueId);
  }

  /** Addendum; extends the closing time by the policy minimum when needed. */
  async issueAddendum(
    actor: CurrentUser,
    uniqueId: string,
    text: string,
    newClosingAt?: string | null,
    fileUniqueId?: string | null,
  ) {
    const t = await this.load(uniqueId);
    if (t.status !== 'PUBLISHED')
      throw new BadRequestException('errors.tender_not_published');
    const p = await this.policy.params<{ addendumExtensionDays: number }>(
      'PROC_CLARIFICATIONS',
    );
    const ext = (await this.policy.isEnabled('PROC_CLARIFICATIONS'))
      ? (p.addendumExtensionDays ?? 0)
      : 0;
    let closing = newClosingAt ? new Date(newClosingAt) : t.closingAt!;
    const minimum = new Date(Date.now() + ext * 864e5);
    if (closing < minimum) closing = minimum;
    const file = fileUniqueId
      ? await this.prisma.db.file.findUnique({
          where: { uniqueId: fileUniqueId },
        })
      : null;
    const n =
      (await this.prisma.db.tenderAddendum.count({
        where: { tenderId: t.id },
      })) + 1;
    await this.prisma.db.$transaction(async (tx) => {
      await tx.tenderAddendum.create({
        data: {
          tenderId: t.id,
          number: n,
          text: text.trim(),
          fileId: file?.id ?? null,
          newClosingAt:
            closing.getTime() !== t.closingAt?.getTime() ? closing : null,
          createdById: actor.id,
        },
      });
      await tx.tender.update({
        where: { id: t.id },
        data: { closingAt: closing },
      });
      await this.audit.log(
        {
          action: 'TENDER_ADDENDUM',
          entityType: 'Tender',
          entityId: t.uniqueId,
          after: { number: n, closingAt: closing },
        },
        tx,
      );
    });
    const vendors = await this.prisma.db.vendor.findMany({
      where: { id: { in: t.invites.map((i) => i.vendorId) } },
    });
    for (const v of vendors)
      await this.vendorNotify(v.id, v.email, {
        type: 'ADDENDUM',
        title: `Addendum ${n} to ${t.number}`,
        body: `${text.trim()}\nClosing: ${closing.toISOString().replace('T', ' ').slice(0, 16)} UTC.`,
        link: `/portal/tenders/${t.uniqueId}`,
      });
    return this.get(actor, uniqueId);
  }

  async cancel(actor: CurrentUser, uniqueId: string, reason: string) {
    const t = await this.load(uniqueId);
    if (['AWARDED', 'CANCELLED', 'AWARD_APPROVAL'].includes(t.status))
      throw new BadRequestException('errors.tender_cannot_cancel');
    await this.prisma.db.$transaction(async (tx) => {
      await tx.tender.update({
        where: { id: t.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: reason.trim(),
        },
      });
      await tx.tenderLine.updateMany({
        where: { tenderId: t.id },
        data: { status: 'CANCELLED' },
      });
      await tx.purchaseRequestLine.updateMany({
        where: {
          id: {
            in: t.lines.flatMap((l) =>
              l.sources.map((s) => s.purchaseRequestLineId),
            ),
          },
        },
        data: { sourcingStatus: 'OPEN' },
      });
      await this.audit.log(
        {
          action: 'TENDER_CANCELLED',
          entityType: 'Tender',
          entityId: t.uniqueId,
          after: { reason },
        },
        tx,
      );
    });
    const vendors = await this.prisma.db.vendor.findMany({
      where: { id: { in: t.invites.map((i) => i.vendorId) } },
    });
    for (const v of vendors)
      await this.vendorNotify(v.id, v.email, {
        type: 'TENDER_CANCELLED',
        title: `Tender ${t.number} cancelled`,
        body: reason.trim(),
      });
    return this.get(actor, uniqueId);
  }

  /** Closing uses server time only (EAT shown in the UI). */
  @Cron(CronExpression.EVERY_MINUTE)
  async closeDue() {
    const due = await this.prisma.db.tender.findMany({
      where: { status: 'PUBLISHED', closingAt: { lte: new Date() } },
      include: { committee: true },
    });
    for (const t of due) {
      await this.prisma.db.tender.update({
        where: { id: t.id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      await this.audit.log({
        action: 'TENDER_CLOSED',
        entityType: 'Tender',
        entityId: t.uniqueId,
      });
      for (const m of t.committee)
        await this.notifications.notify(m.userId, {
          titleKey: 'notifications.tender_closed_title',
          messageKey: 'notifications.tender_closed_message',
          params: { number: t.number },
          link: `/tenders/${t.uniqueId}`,
        });
      this.logger.log(`Tender closed: ${t.number}`);
    }
  }

  /** Committee confirmation; at the quorum the sealed bids are opened. */
  async confirmOpening(actor: CurrentUser, uniqueId: string) {
    await this.closeDue();
    const t = await this.load(uniqueId);
    if (t.status !== 'CLOSED')
      throw new BadRequestException('errors.tender_not_closed');
    const m = t.committee.find((x) => x.userId === actor.id);
    if (!m) throw new ForbiddenException('errors.forbidden');
    await this.policy.enforceSod('SOD_COMMITTEE_COI', !m.coiDeclaredAt);
    if (!m.openingConfirmedAt)
      await this.prisma.db.tenderCommitteeMember.update({
        where: { id: m.id },
        data: { openingConfirmedAt: new Date() },
      });
    await this.audit.log({
      action: 'TENDER_OPENING_CONFIRMED',
      entityType: 'Tender',
      entityId: t.uniqueId,
    });
    const snapshot = (t.policySnapshot ?? {}) as Record<
      string,
      { count?: number }
    >;
    const quorum = snapshot.PROC_OPENING_CONFIRMATIONS?.count ?? 2;
    const confirmed = t.committee.filter(
      (x) => x.openingConfirmedAt || x.id === m.id,
    ).length;
    if (confirmed >= quorum) await this.open(t.id);
    return this.get(actor, uniqueId);
  }

  private async open(tenderId: number) {
    const bids = await this.prisma.db.bid.findMany({
      where: { tenderId, status: 'SUBMITTED' },
    });
    const tlines = await this.prisma.db.tenderLine.findMany({
      where: { tenderId },
    });
    const versions = await this.prisma.db.productVersion.findMany({
      where: { id: { in: tlines.map((l) => l.productVersionId) } },
    });
    const products = await this.prisma.db.product.findMany({
      where: { id: { in: tlines.map((l) => l.productId) } },
    });
    await this.prisma.db.$transaction(async (tx) => {
      for (const b of bids) {
        const lines = unseal(b.sealed, this.config.bidSealKey);
        for (const l of lines) {
          const tl = tlines.find((x) => x.id === l.tenderLineId);
          if (!tl) continue;
          const p = products.find((x) => x.id === tl.productId);
          await tx.bidLine.create({
            data: {
              bidId: b.id,
              tenderLineId: tl.id,
              unitPrice: l.unitPrice,
              vatRate: D(p?.vatRate ?? 18),
              deliveryDays: l.deliveryDays,
              brand: l.brand ?? null,
              model: l.model ?? null,
              countryOfOrigin: l.countryOfOrigin ?? null,
              compliance: l.compliance as Prisma.InputJsonValue,
              fileIds: l.fileIds ?? [],
            },
          });
        }
        await tx.bid.update({
          where: { id: b.id },
          data: { status: 'OPENED', openedAt: new Date(), sealed: null },
        });
      }
      await tx.tender.update({
        where: { id: tenderId },
        data: { status: 'OPENED', openedAt: new Date() },
      });
    });
    void versions;
    const t = await this.prisma.db.tender.findUniqueOrThrow({
      where: { id: tenderId },
    });
    await this.audit.log({
      action: 'TENDER_OPENED',
      entityType: 'Tender',
      entityId: t.uniqueId,
      after: { bids: bids.length },
    });
    await this.evaluate(tenderId);
  }

  /**
   * Automatic evaluation per item (requirements §4.4.5): non-compliant offers
   * are disqualified with a reason; compliant ones ranked by VAT-inclusive
   * price (negotiated price when recorded). Equal lowest prices are a tie for
   * the committee (no automatic tie-break).
   */
  async evaluate(tenderId: number) {
    const t = await this.prisma.db.tender.findUniqueOrThrow({
      where: { id: tenderId },
      include: { lines: true, bids: { include: { lines: true } } },
    });
    const specs = await this.prisma.db.productSpec.findMany({
      where: { versionId: { in: t.lines.map((l) => l.productVersionId) } },
    });
    const vendors = await this.prisma.db.vendor.findMany({
      where: { id: { in: t.bids.map((b) => b.vendorId) } },
    });
    const snapshot = (t.policySnapshot ?? {}) as Record<
      string,
      { enabled?: boolean; count?: number }
    >;
    const minQ = snapshot.PROC_MIN_QUOTATIONS?.enabled
      ? (snapshot.PROC_MIN_QUOTATIONS.count ?? 0)
      : 0;
    await this.prisma.db.$transaction(async (tx) => {
      for (const tl of t.lines) {
        const lineSpecs = specs.filter(
          (s) => s.versionId === tl.productVersionId,
        );
        const offers = t.bids
          .filter((b) => b.status === 'OPENED')
          .flatMap((b) =>
            b.lines
              .filter((l) => l.tenderLineId === tl.id)
              .map((l) => ({ b, l })),
          );
        const scored: {
          id: number;
          compliant: boolean;
          reason: string | null;
          price: number;
        }[] = [];
        for (const { b, l } of offers) {
          const v = vendors.find((x) => x.id === b.vendorId)!;
          const compliance = (l.compliance ?? []) as {
            specId: number;
            complies: boolean;
          }[];
          let reason: string | null = null;
          const failed = lineSpecs.filter(
            (s) => !compliance.find((c) => c.specId === s.id)?.complies,
          );
          if (
            b.submittedAt &&
            v.validUntil < new Date(b.submittedAt.toDateString())
          )
            reason = 'Vendor registration expired';
          else if (v.status !== 'ACTIVE')
            reason = `Vendor ${v.status.toLowerCase()}`;
          else if (failed.length)
            reason = `Did not meet specification: ${failed.map(specText).join('; ')}`;
          // A committee override (with reason) wins over the automatic check.
          const compliant = l.overrideReason ? !!l.compliant : !reason;
          scored.push({
            id: l.id,
            compliant,
            reason: compliant
              ? null
              : l.overrideReason && !l.compliant
                ? l.overrideReason
                : reason,
            price: D(l.negotiatedPrice ?? l.unitPrice),
          });
        }
        const ranked = scored
          .filter((s) => s.compliant)
          .sort((a, b) => a.price - b.price);
        for (const s of scored) {
          const rank = s.compliant
            ? ranked.findIndex((r) => r.id === s.id) + 1
            : null;
          await tx.bidLine.update({
            where: { id: s.id },
            data: { compliant: s.compliant, disqualifyReason: s.reason, rank },
          });
        }
        const tie = ranked.length > 1 && ranked[0].price === ranked[1].price;
        const keep =
          tl.awardBidLineId &&
          ranked.some((r) => r.id === tl.awardBidLineId) &&
          tl.awardReason;
        await tx.tenderLine.update({
          where: { id: tl.id },
          data: {
            tie,
            // System recommendation unless the committee chose (with reason).
            awardBidLineId: keep
              ? tl.awardBidLineId
              : !tie && ranked.length && ranked.length >= minQ
                ? ranked[0].id
                : null,
            awardReason: keep ? tl.awardReason : null,
          },
        });
      }
      await tx.tender.update({
        where: { id: t.id },
        data: {
          status: t.status === 'OPENED' ? 'EVALUATION' : t.status,
          evaluatedAt: new Date(),
        },
      });
    });
  }

  private async assertEvaluator(
    actor: CurrentUser,
    t: {
      id: number;
      status: TenderStatus;
      committee: { userId: number; coiDeclaredAt: Date | null }[];
    },
  ) {
    if (t.status !== 'EVALUATION')
      throw new BadRequestException('errors.tender_not_in_evaluation');
    const m = t.committee.find((x) => x.userId === actor.id);
    if (!m) throw new ForbiddenException('errors.forbidden');
    await this.policy.enforceSod('SOD_COMMITTEE_COI', !m.coiDeclaredAt);
  }

  /** Committee verifies compliance and may override with a written reason. */
  async overrideCompliance(
    actor: CurrentUser,
    uniqueId: string,
    bidLineId: number,
    compliant: boolean,
    reason: string,
  ) {
    const t = await this.load(uniqueId);
    await this.assertEvaluator(actor, t);
    if (reason.trim().length < 5)
      throw new BadRequestException('errors.reason_required');
    const bl = await this.prisma.db.bidLine.findUnique({
      where: { id: bidLineId },
      include: { bid: true },
    });
    if (!bl || bl.bid.tenderId !== t.id)
      throw new NotFoundException('errors.record_not_found');
    await this.prisma.db.bidLine.update({
      where: { id: bl.id },
      data: { compliant, overrideReason: reason.trim() },
    });
    await this.audit.log({
      action: 'BID_COMPLIANCE_OVERRIDE',
      entityType: 'Tender',
      entityId: t.uniqueId,
      after: { bidLineId, compliant, reason },
    });
    await this.evaluate(t.id);
    return this.get(actor, uniqueId);
  }

  /** Ties and overrides of the recommendation: the committee chooses with a reason. */
  async chooseWinner(
    actor: CurrentUser,
    uniqueId: string,
    lineNo: number,
    bidLineId: number | null,
    reason: string,
  ) {
    const t = await this.load(uniqueId);
    await this.assertEvaluator(actor, t);
    if (reason.trim().length < 5)
      throw new BadRequestException('errors.reason_required');
    const tl = t.lines.find((l) => l.lineNo === lineNo);
    if (!tl) throw new NotFoundException('errors.record_not_found');
    if (bidLineId) {
      const bl = await this.prisma.db.bidLine.findUnique({
        where: { id: bidLineId },
      });
      if (!bl || bl.tenderLineId !== tl.id || !bl.compliant)
        throw new BadRequestException('errors.bid_not_compliant');
    }
    await this.prisma.db.tenderLine.update({
      where: { id: tl.id },
      data: { awardBidLineId: bidLineId, awardReason: reason.trim() },
    });
    await this.audit.log({
      action: 'TENDER_WINNER_CHOSEN',
      entityType: 'Tender',
      entityId: t.uniqueId,
      after: { lineNo, bidLineId, reason },
    });
    return this.get(actor, uniqueId);
  }

  /** Purchasing records a negotiated price / delivery (requirements §4.4.6). */
  async negotiate(
    actor: CurrentUser,
    uniqueId: string,
    bidLineId: number,
    price: number | null,
    days: number | null,
    note: string,
  ) {
    const t = await this.load(uniqueId);
    if (t.status !== 'EVALUATION')
      throw new BadRequestException('errors.tender_not_in_evaluation');
    const bl = await this.prisma.db.bidLine.findUnique({
      where: { id: bidLineId },
      include: { bid: true },
    });
    if (!bl || bl.bid.tenderId !== t.id)
      throw new NotFoundException('errors.record_not_found');
    if (price != null && price > D(bl.unitPrice))
      throw new BadRequestException('errors.negotiated_above_bid');
    await this.prisma.db.bidLine.update({
      where: { id: bl.id },
      data: {
        negotiatedPrice: price,
        negotiatedDays: days,
        negotiationNote: note.trim() || null,
      },
    });
    await this.audit.log({
      action: 'BID_NEGOTIATED',
      entityType: 'Tender',
      entityId: t.uniqueId,
      after: { bidLineId, price, days, note },
    });
    await this.evaluate(t.id);
    return this.get(actor, uniqueId);
  }

  async saveEvaluationNote(actor: CurrentUser, uniqueId: string, note: string) {
    const t = await this.load(uniqueId);
    await this.assertEvaluator(actor, t);
    await this.prisma.db.tender.update({
      where: { id: t.id },
      data: { evaluationNote: note.trim() || null },
    });
    return this.get(actor, uniqueId);
  }

  /** Send the evaluation for award approval (committee, all members → CEO). */
  async submitAward(actor: CurrentUser, uniqueId: string) {
    const t = await this.load(uniqueId);
    if (t.status !== 'EVALUATION')
      throw new BadRequestException('errors.tender_not_in_evaluation');
    if (t.lines.some((l) => l.tie && !l.awardReason))
      throw new BadRequestException('errors.tie_unresolved');
    await this.prisma.db.$transaction(async (tx) => {
      const req = await this.workflow.start(
        {
          pointCode: AWARD_POINT,
          subjectType: 'Tender',
          subjectId: t.uniqueId,
          title: `Award ${t.number}: ${t.title}`,
          requesterUserId: actor.id,
          context: { tenderId: t.id },
        },
        tx,
      );
      await tx.tender.update({
        where: { id: t.id },
        data: { status: 'AWARD_APPROVAL', awardApprovalId: req.id },
      });
    });
    await this.audit.log({
      action: 'TENDER_AWARD_SUBMITTED',
      entityType: 'Tender',
      entityId: t.uniqueId,
    });
    return this.get(actor, uniqueId);
  }

  @OnEvent(APPROVAL_COMPLETED, { async: true })
  async onCompleted(e: ApprovalCompletedEvent) {
    if (e.pointCode === SS_POINT && e.subjectType === 'PurchaseRequestLine') {
      const [prId, lineNo] = e.subjectId.split('#');
      const pr = await this.prisma.db.purchaseRequest.findUnique({
        where: { uniqueId: prId },
      });
      if (!pr) return;
      await this.prisma.db.purchaseRequestLine.updateMany({
        where: {
          purchaseRequestId: pr.id,
          lineNo: Number(lineNo),
          sourcingStatus: 'JUSTIFICATION',
        },
        data:
          e.status === 'APPROVED'
            ? { sourcingStatus: 'OPEN' }
            : {
                sourcingStatus: 'OPEN',
                route: null,
                justificationApprovalId: null,
              },
      });
      return;
    }
    if (e.pointCode !== AWARD_POINT || e.subjectType !== 'Tender') return;
    const t = await this.prisma.db.tender.findUnique({
      where: { uniqueId: e.subjectId },
      include: { lines: { include: { sources: true } } },
    });
    if (!t || t.status !== 'AWARD_APPROVAL') return;
    if (e.status !== 'APPROVED') {
      // Rejected or returned: back to evaluation.
      await this.prisma.db.tender.update({
        where: { id: t.id },
        data: { status: 'EVALUATION', awardApprovalId: null },
      });
      return;
    }
    await this.prisma.db.$transaction(async (tx) => {
      for (const l of t.lines) {
        await tx.tenderLine.update({
          where: { id: l.id },
          data: { status: l.awardBidLineId ? 'AWARDED' : 'NOT_AWARDED' },
        });
        if (!l.awardBidLineId)
          await tx.purchaseRequestLine.updateMany({
            where: {
              id: { in: l.sources.map((s) => s.purchaseRequestLineId) },
            },
            data: { sourcingStatus: 'OPEN' },
          });
      }
      await tx.tender.update({
        where: { id: t.id },
        data: { status: 'AWARDED', awardedAt: new Date() },
      });
    });
    await this.audit.log({
      action: 'TENDER_AWARDED',
      entityType: 'Tender',
      entityId: t.uniqueId,
    });
    await this.notifyHolders('tender.create', {
      titleKey: 'notifications.tender_awarded_title',
      messageKey: 'notifications.tender_awarded_message',
      params: { number: t.number },
      link: `/tenders/${t.uniqueId}`,
    });
  }

  /** Award letters (items won) and regret letters (reason per item). */
  async sendLetters(actor: CurrentUser, uniqueId: string) {
    const t = await this.prisma.db.tender.findUnique({
      where: { uniqueId },
      include: {
        lines: { orderBy: { lineNo: 'asc' } },
        bids: { include: { lines: true } },
        invites: true,
      },
    });
    if (!t) throw new NotFoundException('errors.record_not_found');
    if (t.status !== 'AWARDED')
      throw new BadRequestException('errors.tender_not_awarded');
    if (t.lettersSentAt)
      throw new BadRequestException('errors.letters_already_sent');
    const versions = await this.prisma.db.productVersion.findMany({
      where: { id: { in: t.lines.map((l) => l.productVersionId) } },
    });
    const vendors = await this.prisma.db.vendor.findMany({
      where: { id: { in: t.bids.map((b) => b.vendorId) } },
    });
    for (const b of t.bids.filter((x) => x.status === 'OPENED')) {
      const v = vendors.find((x) => x.id === b.vendorId)!;
      const won: string[] = [];
      const lost: string[] = [];
      for (const bl of b.lines) {
        const tl = t.lines.find((x) => x.id === bl.tenderLineId)!;
        const name =
          versions.find((x) => x.id === tl.productVersionId)?.name ?? '';
        if (tl.awardBidLineId === bl.id) {
          const price = D(bl.negotiatedPrice ?? bl.unitPrice);
          won.push(
            `• ${name}: ${tl.quantity} × TZS ${price.toLocaleString('en')} = TZS ${round2(price * tl.quantity).toLocaleString('en')} (VAT incl.)`,
          );
        } else {
          const winner = t.bids
            .flatMap((x) => x.lines)
            .find((x) => x.id === tl.awardBidLineId);
          const reason = !bl.compliant
            ? (bl.disqualifyReason ?? 'Did not meet the requirements')
            : !winner
              ? 'Item not awarded'
              : tl.awardReason && bl.rank === 1
                ? `Committee decision: ${tl.awardReason}`
                : 'Higher price than the winning compliant offer';
          lost.push(`• ${name}: ${reason}`);
        }
      }
      if (won.length)
        await this.vendorNotify(v.id, v.email, {
          type: 'AWARD',
          title: `Award notification — ${t.number}`,
          body: `We are pleased to inform you that you have been awarded the following items of tender ${t.number} (${t.title}):\n${won.join('\n')}\nThe LPO follows on the portal.`,
          link: `/portal/tenders/${t.uniqueId}`,
        });
      if (lost.length)
        await this.vendorNotify(v.id, v.email, {
          type: 'REGRET',
          title: `Regret notification — ${t.number}`,
          body: `Thank you for your quotation on tender ${t.number} (${t.title}). The following items were not awarded to you:\n${lost.join('\n')}`,
          link: `/portal/tenders/${t.uniqueId}`,
        });
    }
    await this.prisma.db.tender.update({
      where: { id: t.id },
      data: { lettersSentAt: new Date() },
    });
    await this.audit.log({
      action: 'TENDER_LETTERS_SENT',
      entityType: 'Tender',
      entityId: t.uniqueId,
    });
    return this.get(actor, uniqueId);
  }

  // ── queries ─────────────────────────────────────────────────────────────

  async list(user: CurrentUser, statuses?: TenderStatus[]) {
    await this.closeDue();
    const rows = await this.prisma.db.tender.findMany({
      where: {
        AND: [
          await this.tenderWhere(user),
          statuses?.length ? { status: { in: statuses } } : {},
        ],
      },
      include: { lines: true, bids: true, invites: true, committee: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((t) => ({
      uniqueId: t.uniqueId,
      number: t.number,
      title: t.title,
      route: t.route,
      status: t.status,
      closingAt: t.closingAt,
      lineCount: t.lines.length,
      invited: t.invites.length,
      submittedBids: t.bids.filter(
        (b) => b.status === 'SUBMITTED' || b.status === 'OPENED',
      ).length,
      createdAt: t.createdAt,
      isMember: t.committee.some((m) => m.userId === user.id),
    }));
  }

  async get(user: CurrentUser, uniqueId: string) {
    await this.closeDue();
    const t = await this.prisma.db.tender.findUnique({
      where: { uniqueId },
      include: {
        lines: { include: { sources: true }, orderBy: { lineNo: 'asc' } },
        committee: true,
        invites: true,
        clarifications: { orderBy: { createdAt: 'asc' } },
        addenda: { orderBy: { number: 'asc' } },
        bids: { include: { lines: true } },
      },
    });
    if (!t) throw new NotFoundException('errors.record_not_found');
    const visible = await this.prisma.db.tender.count({
      where: { AND: [{ id: t.id }, await this.tenderWhere(user)] },
    });
    if (!visible) throw new ForbiddenException('errors.forbidden');
    const member = t.committee.find((m) => m.userId === user.id);
    const opened =
      ['OPENED', 'EVALUATION', 'AWARD_APPROVAL', 'AWARDED'].includes(
        t.status,
      ) ||
      (t.status === 'CANCELLED' && !!t.openedAt);
    const canViewBids =
      opened &&
      (member
        ? true
        : (await this.access.resolveScope(user, 'tender.view_bids')).all);
    const [
      versions,
      products,
      specs,
      users,
      vendors,
      prLines,
      files,
      approval,
    ] = await Promise.all([
      this.prisma.db.productVersion.findMany({
        where: { id: { in: t.lines.map((l) => l.productVersionId) } },
        include: { category: true },
      }),
      this.prisma.db.product.findMany({
        where: { id: { in: t.lines.map((l) => l.productId) } },
      }),
      this.prisma.db.productSpec.findMany({
        where: { versionId: { in: t.lines.map((l) => l.productVersionId) } },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.dbRaw.user.findMany({
        where: {
          id: { in: [...t.committee.map((m) => m.userId), t.createdByUserId] },
        },
        include: { employee: { include: { department: true } } },
      }),
      this.prisma.db.vendor.findMany({
        where: {
          id: {
            in: [
              ...t.invites.map((i) => i.vendorId),
              ...t.bids.map((b) => b.vendorId),
            ],
          },
        },
      }),
      this.prisma.db.purchaseRequestLine.findMany({
        where: {
          id: {
            in: t.lines.flatMap((l) =>
              l.sources.map((s) => s.purchaseRequestLineId),
            ),
          },
        },
        include: { purchaseRequest: true },
      }),
      this.prisma.db.file.findMany({
        where: {
          id: {
            in: [
              ...t.addenda.map((a) => a.fileId).filter((x): x is number => !!x),
              ...t.bids.flatMap((b) => [
                ...b.fileIds,
                ...b.lines.flatMap((l) => l.fileIds),
              ]),
            ],
          },
        },
      }),
      t.awardApprovalId
        ? this.prisma.db.approvalRequest.findUnique({
            where: { id: t.awardApprovalId },
          })
        : null,
    ]);
    const uB = new Map(users.map((u) => [u.id, u]));
    const venB = new Map(vendors.map((v) => [v.id, v]));
    const fB = new Map(
      files.map((f) => [
        f.id,
        { uniqueId: f.uniqueId, filename: f.filename, uri: f.uri },
      ]),
    );
    const name = (id: number) => {
      const u = uB.get(id);
      return u ? `${u.employee.firstName} ${u.employee.lastName}` : '—';
    };
    const [
      cPublish,
      cCommittee,
      cAnswer,
      cNegotiate,
      cLetters,
      cCancel,
      cOrder,
    ] = await Promise.all([
      this.access.hasAny(user, 'tender.publish'),
      this.access.hasAny(user, 'tender.appoint_committee'),
      this.access.hasAny(user, 'tender.answer_clarification'),
      this.access.hasAny(user, 'tender.negotiate'),
      this.access.hasAny(user, 'tender.send_notifications'),
      this.access.hasAny(user, 'tender.cancel'),
      this.access.hasAny(user, 'lpo.create'),
    ]);
    const quorum =
      ((t.policySnapshot ?? {}) as Record<string, { count?: number }>)
        .PROC_OPENING_CONFIRMATIONS?.count ?? null;
    return {
      uniqueId: t.uniqueId,
      number: t.number,
      title: t.title,
      route: t.route,
      status: t.status,
      description: t.description,
      deliveryTerms: t.deliveryTerms,
      terms: t.terms,
      closingAt: t.closingAt,
      bidValidityDays: t.bidValidityDays,
      createdBy: name(t.createdByUserId),
      createdAt: t.createdAt,
      publishedAt: t.publishedAt,
      closedAt: t.closedAt,
      openedAt: t.openedAt,
      awardedAt: t.awardedAt,
      lettersSentAt: t.lettersSentAt,
      cancelReason: t.cancelReason,
      evaluationNote: t.evaluationNote,
      singleSourceVendor: t.singleSourceVendorId
        ? (venB.get(t.singleSourceVendorId)?.name ?? null)
        : null,
      awardApprovalUniqueId: approval?.uniqueId ?? null,
      openingQuorum: quorum,
      invited: t.invites.map((i) => ({
        uniqueId: venB.get(i.vendorId)!.uniqueId,
        name: venB.get(i.vendorId)!.name,
      })),
      // Before opening only the number of sealed bids is known.
      sealedBids: t.bids.filter((b) => b.status === 'SUBMITTED').length,
      committee: t.committee.map((m) => {
        const u = uB.get(m.userId);
        return {
          userUniqueId: u?.uniqueId ?? '',
          name: name(m.userId),
          department: u?.employee.department.name ?? '',
          isChair: m.isChair,
          coiDeclared: !!m.coiDeclaredAt,
          coiStatement: m.coiStatement,
          openingConfirmed: !!m.openingConfirmedAt,
        };
      }),
      lines: t.lines.map((l) => {
        const v = versions.find((x) => x.id === l.productVersionId)!;
        const p = products.find((x) => x.id === l.productId)!;
        const lineSpecs = specs.filter(
          (s) => s.versionId === l.productVersionId,
        );
        const offers = canViewBids
          ? t.bids
              .filter((b) => b.status === 'OPENED')
              .flatMap((b) =>
                b.lines
                  .filter((bl) => bl.tenderLineId === l.id)
                  .map((bl) => {
                    const price = D(bl.unitPrice);
                    const parts = vatParts(price, D(bl.vatRate));
                    const comp = (bl.compliance ?? []) as {
                      specId: number;
                      complies: boolean;
                      offered?: string;
                    }[];
                    return {
                      bidLineId: bl.id,
                      vendorName: venB.get(b.vendorId)?.name ?? '',
                      vendorUniqueId: venB.get(b.vendorId)?.uniqueId ?? '',
                      unitPrice: price,
                      unitPriceExclVat: parts.excl,
                      unitVat: parts.vat,
                      lineTotal: round2(price * l.quantity),
                      negotiatedPrice:
                        bl.negotiatedPrice == null
                          ? null
                          : D(bl.negotiatedPrice),
                      negotiatedDays: bl.negotiatedDays,
                      negotiationNote: bl.negotiationNote,
                      deliveryDays: bl.deliveryDays,
                      brand: bl.brand,
                      model: bl.model,
                      countryOfOrigin: bl.countryOfOrigin,
                      compliance: lineSpecs.map((s) => {
                        const c = comp.find((x) => x.specId === s.id);
                        return {
                          spec: specText(s),
                          complies: !!c?.complies,
                          offered: c?.offered ?? null,
                        };
                      }),
                      files: bl.fileIds
                        .map((id) => fB.get(id))
                        .filter((x) => !!x),
                      compliant: bl.compliant,
                      disqualifyReason: bl.disqualifyReason,
                      overrideReason: bl.overrideReason,
                      rank: bl.rank,
                      isWinner: l.awardBidLineId === bl.id,
                    };
                  }),
              )
              .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
          : [];
        return {
          lineNo: l.lineNo,
          productUniqueId: p.uniqueId,
          productCode: p.code,
          productName: v.name,
          categoryName: v.category.name,
          unit: v.unit,
          quantity: l.quantity,
          vatRate: D(p.vatRate),
          specs: lineSpecs.map(specText),
          status: l.status,
          tie: l.tie,
          awardReason: l.awardReason,
          awardBidLineId: l.awardBidLineId,
          sources: l.sources.map((s) => {
            const prl = prLines.find((x) => x.id === s.purchaseRequestLineId);
            return {
              purchaseRequestUniqueId: prl?.purchaseRequest.uniqueId ?? '',
              purchaseRequestNumber: prl?.purchaseRequest.number ?? '',
              lineNo: prl?.lineNo ?? 0,
              quantity: s.quantity,
            };
          }),
          offers,
        };
      }),
      clarifications: t.clarifications.map((c) => ({
        uniqueId: c.uniqueId,
        question: c.question,
        answer: c.answer,
        askedAt: c.createdAt,
        answeredAt: c.answeredAt,
      })),
      addenda: t.addenda.map((a) => ({
        number: a.number,
        text: a.text,
        newClosingAt: a.newClosingAt,
        file: a.fileId ? (fB.get(a.fileId) ?? null) : null,
        createdAt: a.createdAt,
      })),
      can: {
        edit: cPublish && t.status === 'DRAFT',
        publish: cPublish && t.status === 'DRAFT',
        appointCommittee:
          cCommittee && ['DRAFT', 'PUBLISHED', 'CLOSED'].includes(t.status),
        answer: cAnswer && t.status === 'PUBLISHED',
        addendum: cPublish && t.status === 'PUBLISHED',
        cancel:
          cCancel &&
          !['AWARDED', 'CANCELLED', 'AWARD_APPROVAL'].includes(t.status),
        declareCoi: !!member && !['AWARDED', 'CANCELLED'].includes(t.status),
        confirmOpening:
          !!member && t.status === 'CLOSED' && !member.openingConfirmedAt,
        evaluate:
          !!member && !!member.coiDeclaredAt && t.status === 'EVALUATION',
        negotiate: cNegotiate && t.status === 'EVALUATION',
        submitAward: cPublish && t.status === 'EVALUATION',
        sendLetters: cLetters && t.status === 'AWARDED' && !t.lettersSentAt,
        createOrders: cOrder && t.status === 'AWARDED',
        viewBids: canViewBids,
      },
      isMember: !!member,
    };
  }
}
