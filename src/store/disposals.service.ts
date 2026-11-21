import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { AssetStatus, DisposalStatus, Prisma } from '@db';
import { anyOf, PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { NumberingService } from '../numbering/numbering.service';
import {
  APPROVAL_COMPLETED,
  WorkflowService,
  type ApprovalCompletedEvent,
} from '../workflow/workflow.service';
import { LedgerService, type TxnRef } from './ledger.service';
import { StoresService } from './stores.service';

const POINT = 'disposal.approval';
const SUBJECT = 'Disposal';
const PROPOSABLE: AssetStatus[] = ['IN_STORE', 'DAMAGED', 'MISSING', 'LOST'];

/**
 * Disposal (B2 §4, §6.1): an asset is proposed (it becomes
 * pending_disposal), the owning-department HOD gives a technical opinion,
 * the Disposal Committee approves, and the store records the disposal
 * (asset → disposed). Rejected / returned / cancelled proposals put the
 * asset back as it was.
 */
@Injectable()
export class DisposalsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly numbering: NumberingService,
    private readonly ledger: LedgerService,
    private readonly stores: StoresService,
  ) {}

  onModuleInit() {
    // SOD_DISPOSAL_REQUESTER: the proposer never gives the final approval.
    this.workflow.registerGuard(POINT, async (actor, request, d) => {
      if (d.decision !== 'APPROVE' || !d.lastStep) return;
      const x = await this.prisma.db.disposal.findUnique({
        where: { uniqueId: request.subjectId },
      });
      await this.policy.enforceSod(
        'SOD_DISPOSAL_REQUESTER',
        !!x && x.proposedByUserId === actor.id,
      );
    });
  }

  private ref(number: string, userId: number | null, reason?: string): TxnRef {
    return {
      type: 'DISPOSAL',
      userId,
      referenceType: SUBJECT,
      referenceId: number,
      reason,
    };
  }

  private async load(uniqueId: string) {
    const d = await this.prisma.db.disposal.findUnique({ where: { uniqueId } });
    if (!d) throw new NotFoundException('errors.record_not_found');
    const asset = await this.prisma.db.asset.findUniqueOrThrow({
      where: { id: d.assetId },
    });
    return { d, asset };
  }

  async propose(
    actor: CurrentUser,
    input: { assetUniqueId: string; reason: string; method: string },
  ) {
    const asset = await this.prisma.db.asset.findUnique({
      where: { uniqueId: input.assetUniqueId },
      include: { version: true },
    });
    if (!asset) throw new NotFoundException('errors.record_not_found');
    await this.access.assert(actor, 'disposal.propose', {
      departmentId: asset.owningDepartmentId,
      storeId: asset.storeId,
    });
    if (!PROPOSABLE.includes(asset.status))
      throw new BadRequestException('errors.disposal_asset');
    if (!input.reason?.trim() || !input.method?.trim())
      throw new BadRequestException('errors.reason_required');
    const d = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.numbering.document('DSP', tx);
      const x = await tx.disposal.create({
        data: {
          number,
          assetId: asset.id,
          reason: input.reason.trim(),
          method: input.method.trim(),
          previousStatus: asset.status,
          proposedByUserId: actor.id,
        },
      });
      await this.ledger.moveAsset(
        tx,
        asset,
        { status: 'PENDING_DISPOSAL' },
        {
          ...this.ref(number, actor.id, input.reason.trim()),
          type: 'ADJUSTMENT',
        },
      );
      const req = await this.workflow.start(
        {
          pointCode: POINT,
          subjectType: SUBJECT,
          subjectId: x.uniqueId,
          subjectDepartmentId: asset.owningDepartmentId,
          title: `Disposal ${number}: ${asset.tag} ${asset.version.name}`,
          requesterUserId: actor.id,
          context: {
            method: input.method,
            condition: asset.condition,
            status: asset.status,
          },
        },
        tx,
      );
      await tx.disposal.update({
        where: { id: x.id },
        data: { approvalRequestId: req.id },
      });
      await this.audit.log(
        {
          action: 'disposal.propose',
          entityType: SUBJECT,
          entityId: number,
          after: {
            asset: asset.tag,
            method: input.method,
            reason: input.reason,
          },
        },
        tx,
      );
      return x;
    });
    return this.get(actor, d.uniqueId);
  }

  @OnEvent(APPROVAL_COMPLETED, { async: true })
  async onCompleted(e: ApprovalCompletedEvent) {
    if (e.pointCode !== POINT || e.subjectType !== SUBJECT) return;
    const map: Record<ApprovalCompletedEvent['status'], DisposalStatus> = {
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED',
      RETURNED: 'RETURNED',
      CANCELLED: 'CANCELLED',
    };
    const moved = await this.prisma.db.disposal.updateMany({
      where: { uniqueId: e.subjectId, status: 'IN_APPROVAL' },
      data: { status: map[e.status] },
    });
    if (!moved.count || e.status === 'APPROVED') return;
    // Not disposed: the asset goes back to how it was.
    const { d, asset } = await this.load(e.subjectId);
    if (asset.status !== 'PENDING_DISPOSAL') return;
    await this.prisma.db.$transaction((tx) =>
      this.ledger.moveAsset(
        tx,
        asset,
        { status: d.previousStatus },
        {
          ...this.ref(
            d.number,
            e.deciderUserId ?? null,
            `Disposal ${e.status.toLowerCase()}`,
          ),
          type: 'ADJUSTMENT',
        },
      ),
    );
  }

  /** Record the disposal after approval (asset → disposed, kept forever). */
  async complete(actor: CurrentUser, uniqueId: string, note: string) {
    const { d, asset } = await this.load(uniqueId);
    if (d.status !== 'APPROVED')
      throw new BadRequestException('errors.disposal_status');
    const may =
      (await this.access.can(actor, 'disposal.propose', {
        departmentId: asset.owningDepartmentId,
        storeId: asset.storeId,
      })) || (await this.access.can(actor, 'store.manage'));
    if (!may) throw new ForbiddenException('errors.forbidden');
    if (!note?.trim()) throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      await this.ledger.moveAsset(
        tx,
        asset,
        { status: 'DISPOSED', locationId: null },
        this.ref(d.number, actor.id, note.trim()),
      );
      await tx.disposal.update({
        where: { id: d.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          completedByUserId: actor.id,
          completionNote: note.trim(),
        },
      });
      await this.audit.log(
        {
          action: 'disposal.complete',
          entityType: SUBJECT,
          entityId: d.number,
          after: { asset: asset.tag, note },
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  /** Withdraw a proposal that is returned (or still waiting). */
  async cancel(actor: CurrentUser, uniqueId: string, reason: string) {
    const { d, asset } = await this.load(uniqueId);
    if (d.status !== 'IN_APPROVAL' && d.status !== 'RETURNED')
      throw new BadRequestException('errors.disposal_status');
    if (
      d.proposedByUserId !== actor.id &&
      !(await this.access.can(actor, 'store.manage'))
    ) {
      throw new ForbiddenException('errors.forbidden');
    }
    await this.prisma.db.$transaction(async (tx) => {
      await tx.disposal.update({
        where: { id: d.id },
        data: { status: 'CANCELLED' },
      });
      if (d.status === 'IN_APPROVAL' && d.approvalRequestId) {
        await this.workflow.cancel(
          d.approvalRequestId,
          reason || 'Withdrawn',
          tx,
        );
      }
      if (asset.status === 'PENDING_DISPOSAL') {
        await this.ledger.moveAsset(
          tx,
          asset,
          { status: d.previousStatus },
          {
            ...this.ref(d.number, actor.id, 'Disposal withdrawn'),
            type: 'ADJUSTMENT',
          },
        );
      }
      await this.audit.log(
        {
          action: 'disposal.cancel',
          entityType: SUBJECT,
          entityId: d.number,
          after: { reason },
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  // ── queries ──────────────────────────────────────────────────────────────

  async list(user: CurrentUser, status?: DisposalStatus) {
    const assetWhere = await this.stores.assetWhere(user).catch(() => null);
    const propose = await this.access.resolveScope(user, 'disposal.propose');
    const or: Prisma.AssetWhereInput[] = [];
    if (assetWhere) or.push(assetWhere);
    if (propose.departmentIds.length)
      or.push({ owningDepartmentId: { in: propose.departmentIds } });
    if (propose.storeIds.length) or.push({ storeId: { in: propose.storeIds } });
    const assets = or.length
      ? await this.prisma.db.asset.findMany({
          where: anyOf(or),
          select: { id: true },
        })
      : [];
    const rows = await this.prisma.db.disposal.findMany({
      where: {
        OR: [
          { assetId: { in: assets.map((a) => a.id) } },
          { proposedByUserId: user.id },
        ],
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.present(user, rows);
  }

  async get(user: CurrentUser, uniqueId: string) {
    const { d } = await this.load(uniqueId);
    const visible = (await this.list(user)).some(
      (x) => x.uniqueId === uniqueId,
    );
    if (!visible && d.approvalRequestId) {
      const n = await this.prisma.db.approvalAssignment.count({
        where: { requestId: d.approvalRequestId, userId: user.id },
      });
      if (!n) throw new ForbiddenException('errors.forbidden');
    } else if (!visible) {
      throw new ForbiddenException('errors.forbidden');
    }
    return (await this.present(user, [d]))[0];
  }

  private async present(
    user: CurrentUser,
    rows: Prisma.DisposalGetPayload<object>[],
  ) {
    const assets = await this.prisma.db.asset.findMany({
      where: { id: { in: rows.map((r) => r.assetId) } },
      include: { version: true, store: true, owningDepartment: true },
    });
    const aBy = new Map(assets.map((a) => [a.id, a]));
    const userIds = rows
      .flatMap((r) => [r.proposedByUserId, r.completedByUserId])
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
    const reqs = await this.prisma.db.approvalRequest.findMany({
      where: {
        id: {
          in: rows
            .map((r) => r.approvalRequestId)
            .filter((x): x is number => !!x),
        },
      },
      select: { id: true, uniqueId: true },
    });
    const reqBy = new Map(reqs.map((r) => [r.id, r.uniqueId]));
    const manage = await this.access.can(user, 'store.manage');
    return Promise.all(
      rows.map(async (d) => {
        const a = aBy.get(d.assetId)!;
        const propose = await this.access.can(user, 'disposal.propose', {
          departmentId: a.owningDepartmentId,
          storeId: a.storeId,
        });
        return {
          uniqueId: d.uniqueId,
          number: d.number,
          status: d.status,
          reason: d.reason,
          method: d.method,
          previousStatus: d.previousStatus,
          proposedBy: nameBy.get(d.proposedByUserId) ?? '—',
          createdAt: d.createdAt,
          completedAt: d.completedAt,
          completedBy: d.completedByUserId
            ? (nameBy.get(d.completedByUserId) ?? null)
            : null,
          completionNote: d.completionNote,
          approvalRequestUniqueId: d.approvalRequestId
            ? (reqBy.get(d.approvalRequestId) ?? null)
            : null,
          asset: {
            uniqueId: a.uniqueId,
            tag: a.tag,
            productName: a.version.name,
            status: a.status,
            condition: a.condition,
            storeName: a.store?.name ?? null,
            departmentName: a.owningDepartment.name,
          },
          can: {
            complete: d.status === 'APPROVED' && (propose || manage),
            cancel:
              (d.status === 'IN_APPROVAL' || d.status === 'RETURNED') &&
              (d.proposedByUserId === user.id || manage),
          },
        };
      }),
    );
  }
}
