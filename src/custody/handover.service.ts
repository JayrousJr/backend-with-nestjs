import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Asset, HandoverStatus, Prisma } from '@db';
import { PrismaService, type DbTx } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AppConfigService } from '@config';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { DepartmentsService } from '../org/departments.service';
import { EVENTS } from '../employees/employees.service';
import { EXIT_CLEARANCE_OPENED } from '../exit-clearance/exit-clearance.service';
import { RequestsService } from '../requests/requests.service';
import { LedgerService, type TxnRef } from '../store/ledger.service';
import {
  APPROVAL_COMPLETED,
  WorkflowService,
  type ApprovalCompletedEvent,
} from '../workflow/workflow.service';

const POINT = 'handover.approval';
const SUBJECT = 'Handover';
const LINK_HOURS = 72;
const CODE_MINUTES = 15;
const DAY = 86_400_000;

/** B3 §12 → Store. */
export const CUSTODY_EVENTS = {
  HANDOVER_ACKNOWLEDGED: 'custody.handover_acknowledged',
  ASSET_RETURNED: 'custody.asset_returned',
  CUSTODY_TRANSFERRED: 'custody.transferred',
} as const;

export interface PrepareHandoverInput {
  storeUniqueId: string;
  internalRequestUniqueId?: string;
  custodyTransferUniqueId?: string;
  /** Temporary replacement while the reported item is repaired. */
  assetReportUniqueId?: string;
  purpose: string;
  expectedReturnDate?: string;
  lines: {
    assetUniqueId: string;
    accessories?: string[];
    photoFileUniqueIds?: string[];
  }[];
}

const INCLUDE = { lines: true } as const satisfies Prisma.HandoverInclude;
type Row = Prisma.HandoverGetPayload<{ include: typeof INCLUDE }>;

const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const day = (s?: string | null) =>
  s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null;

/**
 * Product handover & custody (B3 §2–§5, §9): every handover references a
 * request; the custodian acknowledges in the system, by email link (72 h)
 * or with a counter code (15 min). Custody runs from handover to return.
 */
@Injectable()
export class HandoverService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(HandoverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly config: AppConfigService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly departments: DepartmentsService,
    private readonly requests: RequestsService,
    private readonly ledger: LedgerService,
    private readonly workflow: WorkflowService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit() {
    // SOD_HANDOVER_SELF also applies to anyone approving a handover chain.
    this.workflow.registerGuard(POINT, async (actor, request) => {
      const h = await this.prisma.db.handover.findUnique({
        where: { uniqueId: request.subjectId },
      });
      await this.policy.enforceSod(
        'SOD_HANDOVER_SELF',
        !!h && h.custodianEmployeeId === actor.employeeId,
      );
    });
  }

  /** Opening balance: assets held at go-live get a handover to acknowledge (§3). */
  async onApplicationBootstrap() {
    try {
      const held = await this.prisma.db.asset.findMany({
        where: {
          status: 'ASSIGNED_TO_EMPLOYEE',
          custodianEmployeeId: { not: null },
        },
      });
      for (const a of held) {
        const open = await this.prisma.db.custody.count({
          where: { assetId: a.id, toAt: null },
        });
        if (!open) await this.adoptOpeningCustody(a);
      }
    } catch (error) {
      this.logger.warn(`Opening-balance custody check skipped: ${error}`);
    }
  }

  private async adoptOpeningCustody(a: Asset) {
    const emp = await this.prisma.db.employee.findUniqueOrThrow({
      where: { id: a.custodianEmployeeId! },
    });
    await this.prisma.db.$transaction(async (tx) => {
      const number = await this.numbering.document('HND', tx, 5);
      const h = await tx.handover.create({
        data: {
          number,
          status: 'AWAITING_ACKNOWLEDGEMENT',
          custodianEmployeeId: emp.id,
          custodianDepartmentId: emp.departmentId,
          storeId: a.storeId!,
          source: 'OPENING_BALANCE',
          sourceRef: 'Tagging campaign',
          purpose: 'Held at go-live (opening balance)',
          termsText: await this.termsFor(tx, [a.id]),
          lines: { create: [{ assetId: a.id, condition: a.condition }] },
        },
      });
      await tx.custody.create({
        data: { assetId: a.id, custodianEmployeeId: emp.id, handoverId: h.id },
      });
    });
    this.logger.log(`Opening-balance handover created for ${a.tag}`);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async load(uniqueId: string, tx?: DbTx) {
    const h = await (tx ?? this.prisma.db).handover.findUnique({
      where: { uniqueId },
      include: INCLUDE,
    });
    if (!h) throw new NotFoundException('errors.record_not_found');
    return h;
  }

  private async termsFor(tx: DbTx, assetIds: number[]) {
    const assets = await tx.asset.findMany({
      where: { id: { in: assetIds } },
      include: { version: { include: { category: true } } },
    });
    const texts = [
      ...new Set(
        assets
          .map((a) => a.version.category.termsOfUse)
          .filter((x): x is string => !!x),
      ),
    ];
    return texts.join('\n\n') || null;
  }

  private async withComponents(tx: DbTx, a: Asset) {
    const comps = a.isKit
      ? await tx.asset.findMany({
          where: {
            parentAssetId: a.id,
            status: { notIn: ['DISPOSED', 'LOST', 'MISSING'] },
          },
        })
      : [];
    return [a, ...comps];
  }

  private ref(
    number: string,
    userId: number | null,
    type: TxnRef['type'] = 'HANDOVER',
  ): TxnRef {
    return { type, userId, referenceType: SUBJECT, referenceId: number };
  }

  private async userOf(employeeId: number) {
    return this.prisma.db.user.findFirst({
      where: { employeeId, status: 'ACTIVE' },
    });
  }

  // ── prepare ──────────────────────────────────────────────────────────────

  async prepare(actor: CurrentUser, input: PrepareHandoverInput) {
    const store = await this.prisma.db.store.findUnique({
      where: { uniqueId: input.storeUniqueId },
    });
    if (!store) throw new NotFoundException('errors.record_not_found');
    await this.access.assert(actor, 'handover.prepare', { storeId: store.id });
    if (!input.lines.length)
      throw new BadRequestException('errors.handover_no_lines');

    // Every handover has a request (§3).
    let custodianId: number;
    let source: Prisma.HandoverCreateInput['source'];
    let sourceRef: string;
    let ir: Prisma.InternalRequestGetPayload<object> | null = null;
    let transfer: Prisma.CustodyTransferGetPayload<object> | null = null;
    let report: Prisma.AssetReportGetPayload<object> | null = null;
    if (input.internalRequestUniqueId) {
      ir = await this.prisma.db.internalRequest.findUnique({
        where: { uniqueId: input.internalRequestUniqueId },
      });
      if (!ir || !['FULFILLED_FROM_STORE', 'IN_PURCHASE'].includes(ir.status)) {
        throw new BadRequestException('errors.handover_request');
      }
      if (!ir.beneficiaryEmployeeId)
        throw new BadRequestException('errors.handover_request_employee');
      if (ir.storeId && ir.storeId !== store.id)
        throw new BadRequestException('errors.request_other_store');
      const open = (ir.acceptedQty ?? ir.quantity) - ir.deliveredQty;
      if (input.lines.length > open)
        throw new BadRequestException('errors.request_delivery_too_many');
      custodianId = ir.beneficiaryEmployeeId;
      source = 'INTERNAL_REQUEST';
      sourceRef = ir.number;
    } else if (input.custodyTransferUniqueId) {
      transfer = await this.prisma.db.custodyTransfer.findUnique({
        where: { uniqueId: input.custodyTransferUniqueId },
      });
      if (!transfer || transfer.status !== 'APPROVED')
        throw new BadRequestException('errors.handover_request');
      custodianId = transfer.toEmployeeId;
      source = 'CUSTODY_TRANSFER';
      sourceRef = transfer.number;
    } else if (input.assetReportUniqueId) {
      report = await this.prisma.db.assetReport.findUnique({
        where: { uniqueId: input.assetReportUniqueId },
      });
      if (
        !report ||
        !report.custodianEmployeeId ||
        !['FAULT', 'DAMAGE'].includes(report.type)
      ) {
        throw new BadRequestException('errors.handover_request');
      }
      if (!input.expectedReturnDate)
        throw new BadRequestException('errors.handover_return_date');
      custodianId = report.custodianEmployeeId;
      source = 'TEMPORARY_REPLACEMENT';
      sourceRef = report.number;
    } else {
      throw new BadRequestException('errors.handover_request');
    }
    const custodian = await this.prisma.db.employee.findUniqueOrThrow({
      where: { id: custodianId },
    });
    if (custodian.status === 'EXITED')
      throw new BadRequestException('errors.handover_custodian');
    // SOD_HANDOVER_SELF: a storekeeper never hands over to themselves.
    await this.policy.enforceSod(
      'SOD_HANDOVER_SELF',
      actor.employeeId === custodian.id,
    );

    const assets = await this.prisma.db.asset.findMany({
      where: { uniqueId: { in: input.lines.map((l) => l.assetUniqueId) } },
      include: { product: true },
    });
    const byUid = new Map(assets.map((a) => [a.uniqueId, a]));
    const files = await this.prisma.db.file.findMany({
      where: {
        uniqueId: {
          in: input.lines.flatMap((l) => l.photoFileUniqueIds ?? []),
        },
      },
    });
    const fileId = new Map(files.map((f) => [f.uniqueId, f.id]));
    const lines = input.lines.map((l, i) => {
      const a = byUid.get(l.assetUniqueId);
      const fail = (m: string) =>
        new BadRequestException({ message: m, args: { line: i + 1 } });
      if (
        !a ||
        a.storeId !== store.id ||
        a.status !== 'IN_STORE' ||
        !['GOOD', 'FAIR'].includes(a.condition)
      ) {
        throw fail('errors.handover_asset');
      }
      if (a.product.isVehicle) throw fail('errors.handover_vehicle');
      if (a.parentAssetId) throw fail('errors.handover_component');
      if (ir && a.productId !== ir.productId)
        throw fail('errors.request_delivery_product');
      if (transfer && !transfer.assetIds.includes(a.id))
        throw fail('errors.handover_asset');
      const photos = (l.photoFileUniqueIds ?? [])
        .map((u) => fileId.get(u))
        .filter((x): x is number => !!x);
      if (a.isKit && !photos.length) throw fail('errors.handover_kit_photo');
      return {
        assetId: a.id,
        condition: a.condition,
        accessories: (l.accessories ?? []).map((x) => x.trim()).filter(Boolean),
        photoFileIds: photos,
      };
    });

    const h = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.numbering.document('HND', tx, 5);
      const created = await tx.handover.create({
        data: {
          number,
          custodianEmployeeId: custodian.id,
          custodianDepartmentId: custodian.departmentId,
          storeId: store.id,
          source,
          internalRequestId: ir?.id ?? null,
          custodyTransferId: transfer?.id ?? null,
          assetReportId: report?.id ?? null,
          sourceRef,
          purpose: input.purpose.trim(),
          expectedReturnDate: day(input.expectedReturnDate),
          termsText: await this.termsFor(
            tx,
            lines.map((l) => l.assetId),
          ),
          preparedByUserId: actor.id,
          lines: { create: lines },
        },
      });
      // Set aside until approved (handover.approval, no steps by default).
      for (const l of lines) {
        const a = await tx.asset.findUniqueOrThrow({
          where: { id: l.assetId },
        });
        for (const x of await this.withComponents(tx, a)) {
          if (x.status === 'IN_STORE')
            await this.ledger.moveAsset(
              tx,
              x,
              { status: 'RESERVED' },
              this.ref(number, actor.id, 'RESERVE'),
            );
        }
      }
      const req = await this.workflow.start(
        {
          pointCode: POINT,
          subjectType: SUBJECT,
          subjectId: created.uniqueId,
          subjectDepartmentId: custodian.departmentId,
          title: `Handover ${number} to ${custodian.firstName} ${custodian.lastName} (${lines.length} items)`,
          requesterUserId: actor.id,
          context: { source, items: lines.length },
        },
        tx,
      );
      await tx.handover.update({
        where: { id: created.id },
        data: { approvalRequestId: req.id },
      });
      await this.audit.log(
        {
          action: 'handover.prepare',
          entityType: SUBJECT,
          entityId: number,
          after: {
            custodian: custodian.employeeNumber,
            source,
            sourceRef,
            items: lines.length,
          },
        },
        tx,
      );
      return created;
    });
    return this.get(actor, h.uniqueId);
  }

  @OnEvent(APPROVAL_COMPLETED, { async: true })
  async onCompleted(e: ApprovalCompletedEvent) {
    if (e.pointCode !== POINT || e.subjectType !== SUBJECT) return;
    const h = await this.load(e.subjectId);
    if (h.status !== 'PREPARED') return;
    if (e.status !== 'APPROVED') {
      await this.prisma.db.$transaction(async (tx) => {
        await this.releaseAssets(tx, h, e.deciderUserId ?? null);
        await tx.handover.update({
          where: { id: h.id },
          data: {
            status: 'CANCELLED',
            cancelReason: `Approval ${e.status.toLowerCase()}`,
          },
        });
      });
      return;
    }
    await this.prisma.db.$transaction(async (tx) => {
      for (const l of h.lines) {
        const a = await tx.asset.findUniqueOrThrow({
          where: { id: l.assetId },
        });
        for (const x of await this.withComponents(tx, a)) {
          await this.ledger.moveAsset(
            tx,
            x,
            {
              status: 'ASSIGNED_TO_EMPLOYEE',
              custodianEmployeeId: h.custodianEmployeeId,
              locationId: null,
            },
            this.ref(h.number, h.preparedByUserId),
          );
          await tx.custody.create({
            data: {
              assetId: x.id,
              custodianEmployeeId: h.custodianEmployeeId,
              handoverId: h.id,
            },
          });
        }
      }
      if (h.internalRequestId) {
        const productId = (
          await tx.asset.findUniqueOrThrow({
            where: { id: h.lines[0].assetId },
          })
        ).productId;
        await this.requests.recordDelivery(
          tx,
          h.internalRequestId,
          productId,
          h.lines.length,
        );
      }
      await tx.handover.update({
        where: { id: h.id },
        data: { status: 'AWAITING_ACKNOWLEDGEMENT' },
      });
    });
    await this.askForAcknowledgement(h);
  }

  /** In-app notice for custodians with a user; email link for the others. */
  private async askForAcknowledgement(h: Row) {
    const user = await this.userOf(h.custodianEmployeeId);
    if (user) {
      await this.notifications.notify(user.id, {
        titleKey: 'notifications.handover_ready_title',
        messageKey: 'notifications.handover_ready_message',
        params: { number: h.number, items: h.lines.length },
        link: '/my-items',
      });
    } else {
      await this.sendLink(h);
    }
  }

  private async releaseAssets(tx: DbTx, h: Row, userId: number | null) {
    for (const l of h.lines) {
      const a = await tx.asset.findUniqueOrThrow({ where: { id: l.assetId } });
      for (const x of await this.withComponents(tx, a)) {
        if (
          x.status === 'RESERVED' ||
          (x.status === 'ASSIGNED_TO_EMPLOYEE' &&
            x.custodianEmployeeId === h.custodianEmployeeId)
        ) {
          await this.ledger.moveAsset(
            tx,
            x,
            { status: 'IN_STORE', custodianEmployeeId: null },
            this.ref(h.number, userId, 'RELEASE'),
          );
        }
        await tx.custody.updateMany({
          where: { assetId: x.id, handoverId: h.id, toAt: null },
          data: { toAt: new Date(), endReason: 'CANCELLED' },
        });
      }
    }
  }

  // ── acknowledgement ──────────────────────────────────────────────────────

  private async markAcknowledged(
    h: Row,
    method: 'SYSTEM' | 'EMAIL_LINK' | 'COUNTER_CODE',
    ip: string | null,
    userId: number | null,
  ) {
    await this.prisma.db.$transaction(async (tx) => {
      await tx.handover.update({
        where: { id: h.id },
        data: {
          status: 'ACKNOWLEDGED',
          acknowledgedAt: new Date(),
          ackMethod: method,
          ackIp: ip,
          ackByUserId: userId,
        },
      });
      if (h.custodyTransferId) {
        await tx.custodyTransfer.update({
          where: { id: h.custodyTransferId },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
      }
      await this.audit.log(
        {
          action: 'handover.acknowledge',
          entityType: SUBJECT,
          entityId: h.number,
          after: { method, ip },
        },
        tx,
      );
    });
    this.events.emit(CUSTODY_EVENTS.HANDOVER_ACKNOWLEDGED, {
      handoverId: h.id,
    });
    if (h.custodyTransferId)
      this.events.emit(CUSTODY_EVENTS.CUSTODY_TRANSFERRED, {
        custodyTransferId: h.custodyTransferId,
      });
  }

  async acknowledge(actor: CurrentUser, uniqueId: string, ip: string | null) {
    const h = await this.load(uniqueId);
    if (h.status !== 'AWAITING_ACKNOWLEDGEMENT')
      throw new BadRequestException('errors.handover_status');
    if (h.custodianEmployeeId !== actor.employeeId)
      throw new ForbiddenException('errors.forbidden');
    await this.access.assert(actor, 'handover.acknowledge', {
      subjectEmployeeId: h.custodianEmployeeId,
    });
    await this.markAcknowledged(h, 'SYSTEM', ip, actor.id);
    return this.get(actor, uniqueId);
  }

  private async markDisputed(h: Row, note: string) {
    await this.prisma.db.$transaction(async (tx) => {
      await tx.handover.update({
        where: { id: h.id },
        data: { status: 'DISPUTED', disputeNote: note.trim() },
      });
      await this.audit.log(
        {
          action: 'handover.dispute',
          entityType: SUBJECT,
          entityId: h.number,
          after: { note },
        },
        tx,
      );
    });
    if (h.preparedByUserId) {
      await this.notifications.notify(h.preparedByUserId, {
        type: 'WARNING',
        titleKey: 'notifications.handover_disputed_title',
        messageKey: 'notifications.handover_disputed_message',
        params: { number: h.number },
        link: `/custody/handovers/${h.uniqueId}`,
      });
    }
  }

  async dispute(actor: CurrentUser, uniqueId: string, note: string) {
    const h = await this.load(uniqueId);
    if (h.status !== 'AWAITING_ACKNOWLEDGEMENT')
      throw new BadRequestException('errors.handover_status');
    if (h.custodianEmployeeId !== actor.employeeId)
      throw new ForbiddenException('errors.forbidden');
    if (!note?.trim()) throw new BadRequestException('errors.reason_required');
    await this.markDisputed(h, note);
    return this.get(actor, uniqueId);
  }

  /** Storekeeper settles a dispute: ask again (after correcting) or cancel. */
  async resolveDispute(
    actor: CurrentUser,
    uniqueId: string,
    action: 'RESEND' | 'CANCEL',
    note: string,
  ) {
    const h = await this.load(uniqueId);
    if (h.status !== 'DISPUTED')
      throw new BadRequestException('errors.handover_status');
    await this.access.assert(actor, 'handover.prepare', { storeId: h.storeId });
    if (!note?.trim()) throw new BadRequestException('errors.reason_required');
    if (action === 'CANCEL') return this.cancel(actor, uniqueId, note);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.handover.update({
        where: { id: h.id },
        data: { status: 'AWAITING_ACKNOWLEDGEMENT' },
      });
      await this.audit.log(
        {
          action: 'handover.dispute_resolved',
          entityType: SUBJECT,
          entityId: h.number,
          after: { note },
        },
        tx,
      );
    });
    await this.askForAcknowledgement(h);
    return this.get(actor, uniqueId);
  }

  /** Email link (72 h, single use) to the custodian's company email. */
  private async sendLink(h: Row) {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.db.handoverAckToken.create({
      data: {
        handoverId: h.id,
        kind: 'EMAIL_LINK',
        tokenHash: hash(token),
        expiresAt: new Date(Date.now() + LINK_HOURS * 3600_000),
      },
    });
    const e = await this.prisma.db.employee.findUniqueOrThrow({
      where: { id: h.custodianEmployeeId },
    });
    const url = `${this.config.frontendUrl}/handover-ack/${token}`;
    await this.mail.queueGeneric({
      email: e.companyEmail,
      subject: `AzamTV: please acknowledge handover ${h.number}`,
      greeting: `Hello ${e.firstName},`,
      body: `The store has handed over ${h.lines.length} item(s) to you (${h.number}). Please confirm you received them, or report a difference.`,
      url,
      cta: 'Open the handover',
      footer: `The link works once and expires in ${LINK_HOURS} hours.`,
    });
    if (!this.config.isProduction)
      this.logger.warn(`DEV handover link for ${h.number}: ${url}`);
    return url;
  }

  async sendEmailLink(actor: CurrentUser, uniqueId: string) {
    const h = await this.load(uniqueId);
    if (h.status !== 'AWAITING_ACKNOWLEDGEMENT')
      throw new BadRequestException('errors.handover_status');
    await this.access.assert(actor, 'handover.prepare', { storeId: h.storeId });
    const url = await this.sendLink(h);
    await this.audit.log({
      action: 'handover.send_link',
      entityType: SUBJECT,
      entityId: h.number,
    });
    // Development has no mail server: show the link to the tester.
    return {
      sent: true,
      devLink: this.config.isProduction ? null : url,
      devCode: null as string | null,
    };
  }

  /** Counter code (15 min) emailed to the custodian collecting in person. */
  async sendCounterCode(actor: CurrentUser, uniqueId: string) {
    const h = await this.load(uniqueId);
    if (h.status !== 'AWAITING_ACKNOWLEDGEMENT')
      throw new BadRequestException('errors.handover_status');
    await this.access.assert(actor, 'handover.prepare', { storeId: h.storeId });
    const code = String(randomInt(100000, 999999));
    await this.prisma.db.handoverAckToken.create({
      data: {
        handoverId: h.id,
        kind: 'COUNTER_CODE',
        tokenHash: hash(`${h.id}:${code}`),
        expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
      },
    });
    const e = await this.prisma.db.employee.findUniqueOrThrow({
      where: { id: h.custodianEmployeeId },
    });
    await this.mail.queueGeneric({
      email: e.companyEmail,
      subject: `AzamTV handover code ${h.number}`,
      greeting: `Hello ${e.firstName},`,
      body: `Your code to confirm handover ${h.number} at the store counter is ${code}. Give it to the storekeeper only when you have checked the items.`,
      footer: `The code works once and expires in ${CODE_MINUTES} minutes.`,
    });
    await this.audit.log({
      action: 'handover.send_code',
      entityType: SUBJECT,
      entityId: h.number,
    });
    if (!this.config.isProduction)
      this.logger.warn(`DEV handover code for ${h.number}: ${code}`);
    return {
      sent: true,
      devLink: null as string | null,
      devCode: this.config.isProduction ? null : code,
    };
  }

  async acknowledgeWithCode(
    actor: CurrentUser,
    uniqueId: string,
    code: string,
    ip: string | null,
  ) {
    const h = await this.load(uniqueId);
    if (h.status !== 'AWAITING_ACKNOWLEDGEMENT')
      throw new BadRequestException('errors.handover_status');
    await this.access.assert(actor, 'handover.prepare', { storeId: h.storeId });
    const t = await this.prisma.db.handoverAckToken.findUnique({
      where: { tokenHash: hash(`${h.id}:${code.trim()}`) },
    });
    if (
      !t ||
      t.usedAt ||
      t.expiresAt < new Date() ||
      t.kind !== 'COUNTER_CODE'
    ) {
      throw new BadRequestException('errors.handover_code_invalid');
    }
    await this.prisma.db.handoverAckToken.update({
      where: { id: t.id },
      data: { usedAt: new Date(), ip },
    });
    await this.markAcknowledged(h, 'COUNTER_CODE', ip, null);
    return this.get(actor, uniqueId);
  }

  /** Public (email link): what the custodian sees without logging in. */
  private async tokenRow(token: string) {
    const t = await this.prisma.db.handoverAckToken.findUnique({
      where: { tokenHash: hash(token) },
    });
    if (!t || t.kind !== 'EMAIL_LINK' || t.usedAt || t.expiresAt < new Date()) {
      throw new BadRequestException('errors.handover_link_invalid');
    }
    const h = await this.prisma.db.handover.findUniqueOrThrow({
      where: { id: t.handoverId },
      include: INCLUDE,
    });
    if (h.status !== 'AWAITING_ACKNOWLEDGEMENT')
      throw new BadRequestException('errors.handover_link_invalid');
    return { t, h };
  }

  async publicView(token: string) {
    const { h } = await this.tokenRow(token);
    const [e, assets] = await Promise.all([
      this.prisma.db.employee.findUniqueOrThrow({
        where: { id: h.custodianEmployeeId },
      }),
      this.prisma.db.asset.findMany({
        where: { id: { in: h.lines.map((l) => l.assetId) } },
        include: { version: true },
      }),
    ]);
    const aBy = new Map(assets.map((a) => [a.id, a]));
    return {
      number: h.number,
      custodian: `${e.firstName} ${e.lastName}`,
      purpose: h.purpose,
      expectedReturnDate: h.expectedReturnDate,
      terms: h.termsText,
      items: h.lines.map((l) => {
        const a = aBy.get(l.assetId)!;
        return {
          tag: a.tag,
          product: a.version.name,
          serialNumber: a.serialNumber,
          condition: l.condition,
          accessories: l.accessories,
        };
      }),
    };
  }

  async publicRespond(
    token: string,
    accept: boolean,
    note: string | undefined,
    ip: string | null,
  ) {
    const { t, h } = await this.tokenRow(token);
    await this.prisma.db.handoverAckToken.update({
      where: { id: t.id },
      data: { usedAt: new Date(), ip },
    });
    if (accept) await this.markAcknowledged(h, 'EMAIL_LINK', ip, null);
    else {
      if (!note?.trim())
        throw new BadRequestException('errors.reason_required');
      await this.markDisputed(h, note);
    }
    return { ok: true, status: accept ? 'ACKNOWLEDGED' : 'DISPUTED' };
  }

  // ── cancel ───────────────────────────────────────────────────────────────

  async cancel(actor: CurrentUser, uniqueId: string, reason: string) {
    const h = await this.load(uniqueId);
    if (
      !['PREPARED', 'AWAITING_ACKNOWLEDGEMENT', 'DISPUTED'].includes(h.status)
    ) {
      throw new BadRequestException('errors.handover_status');
    }
    await this.access.assert(actor, 'handover.cancel', { storeId: h.storeId });
    if (!reason?.trim())
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      await this.releaseAssets(tx, h, actor.id);
      if (h.internalRequestId && h.status !== 'PREPARED') {
        await this.requests.reverseDelivery(
          tx,
          h.internalRequestId,
          h.lines.length,
        );
      }
      if (h.status === 'PREPARED' && h.approvalRequestId)
        await this.workflow.cancel(h.approvalRequestId, reason, tx);
      await tx.handover.update({
        where: { id: h.id },
        data: { status: 'CANCELLED', cancelReason: reason.trim() },
      });
      await this.audit.log(
        {
          action: 'handover.cancel',
          entityType: SUBJECT,
          entityId: h.number,
          after: { reason },
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  // ── exit clearance, department transfer (A1 events) ──────────────────────

  @OnEvent(EXIT_CLEARANCE_OPENED, { async: true })
  async onExitClearance(e: { clearanceId: number; employeeId: number }) {
    const open = await this.prisma.db.custody.findMany({
      where: { custodianEmployeeId: e.employeeId, toAt: null },
    });
    if (!open.length) return;
    const assets = await this.prisma.db.asset.findMany({
      where: { id: { in: open.map((c) => c.assetId) }, parentAssetId: null },
      include: { version: true },
    });
    await this.prisma.db.exitClearanceItem.createMany({
      data: assets.map((a) => ({
        clearanceId: e.clearanceId,
        type: 'CUSTODY' as const,
        reference: a.tag,
        description: `In custody: ${a.tag} ${a.version.name} — return, transfer custody or resolve a loss/damage report`,
      })),
    });
  }

  /** Called when custody of an asset ends (return, transfer, approved loss). */
  async clearExitItem(
    tx: DbTx,
    employeeId: number,
    tag: string,
    resolution: string,
    userId: number | null,
  ) {
    const items = await tx.exitClearanceItem.findMany({
      where: {
        type: 'CUSTODY',
        reference: tag,
        resolved: false,
        clearance: { employeeId, status: 'OPEN' },
      },
    });
    for (const i of items) {
      await tx.exitClearanceItem.update({
        where: { id: i.id },
        data: {
          resolved: true,
          resolution,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      });
    }
  }

  @OnEvent(EVENTS.EMPLOYEE_TRANSFERRED, { async: true })
  async onDepartmentTransfer(e: {
    employeeId: number;
    fromDepartmentId: number;
    toDepartmentId: number;
  }) {
    const count = await this.prisma.db.custody.count({
      where: { custodianEmployeeId: e.employeeId, toAt: null },
    });
    if (!count) return;
    const emp = await this.prisma.db.employee.findUniqueOrThrow({
      where: { id: e.employeeId },
    });
    // Review list for both HODs: return or custody transfer; nothing moves automatically.
    for (const deptId of [e.fromDepartmentId, e.toDepartmentId]) {
      const headId = await this.departments.resolveHeadEmployeeId(deptId);
      const head = headId ? await this.userOf(headId) : null;
      if (!head) continue;
      await this.notifications.notify(head.id, {
        type: 'WARNING',
        titleKey: 'notifications.custody_review_title',
        messageKey: 'notifications.custody_review_message',
        params: { name: `${emp.firstName} ${emp.lastName}`, items: count },
        link: `/custody?employee=${emp.uniqueId}`,
      });
    }
  }

  // ── reminders ────────────────────────────────────────────────────────────

  /**
   * Daily 08:00 EAT: unacknowledged handovers (storekeeper + custodian),
   * returns 7 days before / on the date / every 3 days after, HOD escalation
   * after 7 days overdue (§8.1).
   */
  @Cron('0 8 * * *', { timeZone: 'Africa/Dar_es_Salaam' })
  async daily() {
    const now = new Date();
    const unack = await this.prisma.db.handover.findMany({
      where: {
        status: 'AWAITING_ACKNOWLEDGEMENT',
        createdAt: { lt: new Date(now.getTime() - DAY) },
      },
      include: INCLUDE,
    });
    for (const h of unack) {
      if (h.preparedByUserId) {
        await this.notifications.notify(h.preparedByUserId, {
          type: 'WARNING',
          titleKey: 'notifications.handover_unack_title',
          messageKey: 'notifications.handover_unack_message',
          params: { number: h.number },
          link: `/custody/handovers/${h.uniqueId}`,
        });
      }
      const u = await this.userOf(h.custodianEmployeeId);
      if (u) await this.askForAcknowledgement(h);
    }
    const due = await this.prisma.db.handover.findMany({
      where: {
        status: {
          in: [
            'ACKNOWLEDGED',
            'PARTIALLY_RETURNED',
            'AWAITING_ACKNOWLEDGEMENT',
          ],
        },
        expectedReturnDate: { not: null },
      },
      include: INCLUDE,
    });
    for (const h of due) {
      const days = Math.round(
        (h.expectedReturnDate!.getTime() - now.getTime()) / DAY,
      );
      const remind = days === 7 || days === 0 || (days < 0 && -days % 3 === 0);
      if (!remind) continue;
      const params = { number: h.number, days: Math.abs(days) };
      const u = await this.userOf(h.custodianEmployeeId);
      if (u) {
        await this.notifications.notify(u.id, {
          type: days < 0 ? 'WARNING' : 'INFO',
          titleKey:
            days < 0
              ? 'notifications.return_overdue_title'
              : 'notifications.return_due_title',
          messageKey: 'notifications.return_due_message',
          params,
          link: '/my-items',
        });
      }
      if (days <= -7) {
        const headId = await this.departments.resolveHeadEmployeeId(
          h.custodianDepartmentId,
        );
        const head = headId ? await this.userOf(headId) : null;
        if (head) {
          await this.notifications.notify(head.id, {
            type: 'WARNING',
            titleKey: 'notifications.return_overdue_title',
            messageKey: 'notifications.return_overdue_hod_message',
            params,
            link: `/custody/handovers/${h.uniqueId}`,
          });
        }
      }
    }
    return { unacknowledged: unack.length, returnsChecked: due.length };
  }

  /** Monthly summary for custodians without a user account (§5). */
  @Cron('0 9 1 * *', { timeZone: 'Africa/Dar_es_Salaam' })
  async monthlySummary() {
    const open = await this.prisma.db.custody.findMany({
      where: { toAt: null },
    });
    const byEmp = new Map<number, number[]>();
    for (const c of open)
      byEmp.set(c.custodianEmployeeId, [
        ...(byEmp.get(c.custodianEmployeeId) ?? []),
        c.assetId,
      ]);
    for (const [empId, assetIds] of byEmp) {
      if (await this.userOf(empId)) continue;
      const e = await this.prisma.db.employee.findUniqueOrThrow({
        where: { id: empId },
      });
      const assets = await this.prisma.db.asset.findMany({
        where: { id: { in: assetIds } },
        include: { version: true },
      });
      await this.mail.queueGeneric({
        email: e.companyEmail,
        subject: 'AzamTV: items in your custody',
        greeting: `Hello ${e.firstName},`,
        body: `You hold: ${assets.map((a) => `${a.tag} ${a.version.name}`).join('; ')}. Tell your HOD or the store about any fault, damage or loss.`,
      });
    }
  }

  // ── queries ──────────────────────────────────────────────────────────────

  private async visibleWhere(
    user: CurrentUser,
  ): Promise<Prisma.HandoverWhereInput> {
    const s = await this.access.resolveScope(user, 'handover.view');
    if (s.all) return {};
    const or: Prisma.HandoverWhereInput[] = [];
    if (user.employeeId) or.push({ custodianEmployeeId: user.employeeId });
    if (s.departmentIds.length)
      or.push({ custodianDepartmentId: { in: s.departmentIds } });
    const stores = (await this.access.resolveScope(user, 'handover.prepare'))
      .storeIds;
    if (stores.length) or.push({ storeId: { in: stores } });
    if (!or.length) throw new ForbiddenException('errors.forbidden');
    return { OR: or };
  }

  async list(
    user: CurrentUser,
    filter: { statuses?: HandoverStatus[]; employeeUniqueId?: string } = {},
  ) {
    const emp = filter.employeeUniqueId
      ? await this.prisma.db.employee.findUnique({
          where: { uniqueId: filter.employeeUniqueId },
        })
      : null;
    const rows = await this.prisma.db.handover.findMany({
      where: {
        AND: [
          await this.visibleWhere(user),
          filter.statuses?.length ? { status: { in: filter.statuses } } : {},
          emp ? { custodianEmployeeId: emp.id } : {},
        ],
      },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.present(user, rows);
  }

  async get(user: CurrentUser, uniqueId: string) {
    const h = await this.load(uniqueId);
    const n = await this.prisma.db.handover.count({
      where: { AND: [{ id: h.id }, await this.visibleWhere(user)] },
    });
    if (!n) throw new ForbiddenException('errors.forbidden');
    return (await this.present(user, [h]))[0];
  }

  async present(user: CurrentUser, rows: Row[]) {
    const ids = <T>(f: (r: Row) => T | null) => [
      ...new Set(rows.map(f).filter((x): x is T => x != null)),
    ];
    const [emps, depts, stores, users, assets, irs, files] = await Promise.all([
      this.prisma.db.employee.findMany({
        where: { id: { in: ids((r) => r.custodianEmployeeId) } },
      }),
      this.prisma.db.department.findMany({
        where: { id: { in: ids((r) => r.custodianDepartmentId) } },
      }),
      this.prisma.db.store.findMany({
        where: { id: { in: ids((r) => r.storeId) } },
      }),
      this.prisma.dbRaw.user.findMany({
        where: {
          id: {
            in: [
              ...ids((r) => r.preparedByUserId),
              ...ids((r) => r.ackByUserId),
            ],
          },
        },
        include: { employee: true },
      }),
      this.prisma.db.asset.findMany({
        where: {
          id: { in: rows.flatMap((r) => r.lines.map((l) => l.assetId)) },
        },
        include: { version: true, components: { select: { tag: true } } },
      }),
      this.prisma.db.internalRequest.findMany({
        where: { id: { in: ids((r) => r.internalRequestId) } },
      }),
      this.prisma.db.file.findMany({
        where: {
          id: {
            in: rows.flatMap((r) => r.lines.flatMap((l) => l.photoFileIds)),
          },
        },
      }),
    ]);
    const by = <T extends { id: number }>(l: T[]) =>
      new Map(l.map((x) => [x.id, x]));
    const [eB, dB, sB, uB, aB, iB, fB] = [
      by(emps),
      by(depts),
      by(stores),
      by(users),
      by(assets),
      by(irs),
      by(files),
    ];
    const name = (id: number | null) => {
      const u = id ? uB.get(id) : undefined;
      return u ? `${u.employee.firstName} ${u.employee.lastName}` : null;
    };
    return Promise.all(
      rows.map(async (h) => {
        const e = eB.get(h.custodianEmployeeId)!;
        const s = sB.get(h.storeId)!;
        const d = dB.get(h.custodianDepartmentId);
        const [prepare, cancel, hasUser] = await Promise.all([
          this.access.can(user, 'handover.prepare', { storeId: h.storeId }),
          this.access.can(user, 'handover.cancel', { storeId: h.storeId }),
          this.userOf(h.custodianEmployeeId).then((u) => !!u),
        ]);
        const mine = user.employeeId === h.custodianEmployeeId;
        const awaiting = h.status === 'AWAITING_ACKNOWLEDGEMENT';
        return {
          uniqueId: h.uniqueId,
          number: h.number,
          status: h.status,
          source: h.source,
          sourceRef: h.sourceRef,
          internalRequestUniqueId: h.internalRequestId
            ? (iB.get(h.internalRequestId)?.uniqueId ?? null)
            : null,
          custodian: {
            uniqueId: e.uniqueId,
            employeeNumber: e.employeeNumber,
            fullName: `${e.firstName} ${e.lastName}`,
            companyEmail: e.companyEmail,
          },
          custodianHasUser: hasUser,
          department: d
            ? { uniqueId: d.uniqueId, code: d.code, name: d.name }
            : null,
          store: { uniqueId: s.uniqueId, code: s.code, name: s.name },
          purpose: h.purpose,
          expectedReturnDate: h.expectedReturnDate,
          termsText: h.termsText,
          preparedBy: name(h.preparedByUserId),
          createdAt: h.createdAt,
          acknowledgedAt: h.acknowledgedAt,
          ackMethod: h.ackMethod,
          ackBy: name(h.ackByUserId),
          disputeNote: h.disputeNote,
          cancelReason: h.cancelReason,
          lines: h.lines.map((l) => {
            const a = aB.get(l.assetId)!;
            return {
              assetUniqueId: a.uniqueId,
              tag: a.tag,
              productName: a.version.name,
              serialNumber: a.serialNumber,
              condition: l.condition,
              accessories: l.accessories,
              components: a.components.map((c) => c.tag),
              photos: l.photoFileIds
                .map((id) => fB.get(id))
                .filter((f): f is NonNullable<typeof f> => !!f)
                .map((f) => ({
                  uniqueId: f.uniqueId,
                  filename: f.filename,
                  uri: f.uri,
                })),
              returnedAt: l.returnedAt,
            };
          }),
          can: {
            acknowledge: mine && awaiting,
            dispute: mine && awaiting,
            sendLink: prepare && awaiting,
            counterCode: prepare && awaiting,
            resolveDispute: prepare && h.status === 'DISPUTED',
            cancel:
              cancel &&
              ['PREPARED', 'AWAITING_ACKNOWLEDGEMENT', 'DISPUTED'].includes(
                h.status,
              ),
          },
        };
      }),
    );
  }
}
