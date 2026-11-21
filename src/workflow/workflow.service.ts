import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ApprovalDecision, ApprovalStep, Prisma } from '@db';
import { PrismaService, type DbTx } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DepartmentsService } from '../org/departments.service';
import {
  APPROVAL_POINTS,
  ASSIGNEE_RULES,
  type ApprovalPointDefinition,
} from './point-catalogue';

/** Emitted when a request ends: { pointCode, subjectType, subjectId, status, requestId, deciderUserId }. */
export const APPROVAL_COMPLETED = 'approval.completed';

export interface ApprovalCompletedEvent {
  pointCode: string;
  subjectType: string;
  subjectId: string;
  status: 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED';
  requestId: number;
  deciderUserId?: number;
}

export interface StartApproval {
  pointCode: string;
  subjectType: string;
  subjectId: string;
  subjectDepartmentId?: number | null;
  title: string;
  requesterUserId?: number | null;
  /** Values step conditions can test, e.g. { amount: 120000 }. */
  context?: Record<string, unknown>;
}

/** Emitted when a step opens: { pointCode, subjectType, subjectId, stepOrder, stepCode, first }. */
export const APPROVAL_STEP_OPENED = 'approval.step_opened';

export interface ApprovalStepOpenedEvent {
  pointCode: string;
  subjectType: string;
  subjectId: string;
  stepOrder: number;
  stepCode: string;
  /** This is the chain's first step. */
  first: boolean;
}

/** Module-specific check run before a decision (e.g. an SoD rule). */
export type DecisionGuard = (
  actor: CurrentUser,
  request: {
    subjectType: string;
    subjectId: string;
    requesterUserId: number | null;
  },
  decision: {
    decision: 'APPROVE' | 'REJECT' | 'RETURN' | 'COMMENT';
    stepCode: string;
    /** Approving this step would complete the request. */
    lastStep: boolean;
  },
) => Promise<void>;

interface Condition {
  path: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
  value: unknown;
}

const REQUEST_INCLUDE = {
  point: true,
  version: { include: { steps: { orderBy: { order: 'asc' } } } },
  actions: { orderBy: { at: 'asc' } },
  assignments: { where: { active: true } },
} as const satisfies Prisma.ApprovalRequestInclude;

type RequestRow = Prisma.ApprovalRequestGetPayload<{
  include: typeof REQUEST_INCLUDE;
}>;

/**
 * Shared workflow engine: approval points with configured, versioned
 * chains. Requests keep the chain version they started with. A point with
 * no steps approves immediately.
 */
@Injectable()
export class WorkflowService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkflowService.name);
  private readonly guards = new Map<string, DecisionGuard>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly departments: DepartmentsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly events: EventEmitter2,
  ) {}

  // ── catalogue sync ───────────────────────────────────────────────────────

  async onApplicationBootstrap() {
    for (const [code, def] of Object.entries(APPROVAL_POINTS)) {
      const point = await this.prisma.dbRaw.approvalPoint.upsert({
        where: { code },
        update: {
          module: def.module,
          name: def.name,
          description: def.description,
          syncedAt: new Date(),
        },
        create: {
          code,
          module: def.module,
          name: def.name,
          description: def.description,
        },
        include: { versions: true },
      });
      if (!point.versions.length && def.defaultSteps.length) {
        await this.seedDefault(point.id, def);
      }
    }
  }

  private async seedDefault(pointId: number, def: ApprovalPointDefinition) {
    const steps: Prisma.ApprovalStepCreateWithoutVersionInput[] = [];
    for (const [i, s] of def.defaultSteps.entries()) {
      const ref = await this.resolveApproverRef(s.approverType, s.approver);
      if (!ref) {
        this.logger.warn(
          `Seed chain for ${def.name}: approver "${s.approver}" not found; point left without steps`,
        );
        return;
      }
      steps.push({
        order: i + 1,
        code: s.code,
        name: s.name,
        approverType: s.approverType,
        ...ref,
        mode: s.mode ?? 'ANY',
        requiredCount: s.requiredCount ?? 1,
        allowDelegation: s.allowDelegation ?? true,
      });
    }
    const version = await this.prisma.dbRaw.approvalChainVersion.create({
      data: {
        pointId,
        version: 1,
        status: 'ACTIVE',
        activatedAt: new Date(),
        steps: { create: steps },
      },
    });
    await this.prisma.dbRaw.approvalPoint.update({
      where: { id: pointId },
      data: { activeVersionId: version.id },
    });
  }

  private async resolveApproverRef(type: string, ref: string) {
    const db = this.prisma.dbRaw;
    switch (type) {
      case 'GROUP': {
        const g = await db.userGroup.findUnique({ where: { code: ref } });
        return g ? { approverGroupId: g.id } : null;
      }
      case 'ROLE': {
        const r = await db.role.findUnique({ where: { name: ref } });
        return r ? { approverRoleId: r.id } : null;
      }
      case 'USER': {
        const u = await db.user.findUnique({ where: { email: ref } });
        return u ? { approverUserId: u.id } : null;
      }
      case 'RULE':
        return ref in ASSIGNEE_RULES ? { rule: ref } : null;
      default:
        return null;
    }
  }

  /**
   * Emit once the transaction that changed the request has committed:
   * listeners must see the subject (often created in the same transaction).
   * The request is polled outside the transaction until its `updatedAt`
   * reflects the change; if the transaction rolled back, nothing is emitted.
   */
  private emitAfterCommit(requestId: number, name: string, payload: object) {
    const marker = Date.now() - 50;
    void (async () => {
      for (let i = 0; i < 100; i++) {
        const r = await this.prisma.dbRaw.approvalRequest.findUnique({
          where: { id: requestId },
          select: { updatedAt: true },
        });
        if (r && r.updatedAt.getTime() >= marker) {
          await this.events.emitAsync(name, payload);
          return;
        }
        await new Promise((res) => setTimeout(res, 100));
      }
      this.logger.warn(
        `${name} for request #${requestId} dropped (not committed)`,
      );
    })();
  }

  /** Modules register extra checks for their point (SoD rules). */
  registerGuard(pointCode: string, guard: DecisionGuard) {
    this.guards.set(pointCode, guard);
  }

  // ── runtime ──────────────────────────────────────────────────────────────

  /** Start an approval. Returns the request (APPROVED at once if no steps). */
  async start(input: StartApproval, tx?: DbTx) {
    const db = tx ?? this.prisma.db;
    const point = await db.approvalPoint.findUnique({
      where: { code: input.pointCode },
    });
    if (!point)
      throw new NotFoundException(`Unknown approval point ${input.pointCode}`);

    const request = await db.approvalRequest.create({
      data: {
        pointId: point.id,
        versionId: point.activeVersionId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        subjectDepartmentId: input.subjectDepartmentId ?? null,
        title: input.title,
        requesterUserId: input.requesterUserId ?? null,
        context: (input.context ?? {}) as Prisma.InputJsonValue,
      },
    });
    await this.advance(request.id, 1, tx);
    return this.findById(request.id, tx);
  }

  private findById(id: number, tx?: DbTx) {
    return (tx ?? this.prisma.db).approvalRequest.findUniqueOrThrow({
      where: { id },
      include: REQUEST_INCLUDE,
    });
  }

  /** Open the first applicable step at or after `fromOrder`, or finish. */
  private async advance(
    requestId: number,
    fromOrder: number,
    tx?: DbTx,
    deciderUserId?: number,
  ) {
    const db = tx ?? this.prisma.db;
    const req = await this.findById(requestId, tx);
    const steps = (req.version?.steps ?? []).filter(
      (s) => s.order >= fromOrder,
    );

    for (const step of steps) {
      if (!this.conditionHolds(step, req.context)) {
        await db.approvalAction.create({
          data: {
            requestId,
            stepOrder: step.order,
            stepName: step.name,
            decision: 'SKIPPED',
            comment: 'Condition not met',
          },
        });
        continue;
      }
      const resolved = await this.resolveAssignees(step, req, tx);
      const assignees = resolved.filter(
        (id) => id !== req.requesterUserId, // nobody approves their own request
      );
      // A rule step (e.g. "HOD of the department") whose only approver is
      // the requester is skipped: the HOD raising it already stands behind it.
      if (
        step.approverType === 'RULE' &&
        resolved.length > 0 &&
        assignees.length === 0
      ) {
        await db.approvalAction.create({
          data: {
            requestId,
            stepOrder: step.order,
            stepName: step.name,
            decision: 'SKIPPED',
            comment: 'The requester is this step’s approver',
          },
        });
        continue;
      }
      await db.approvalRequest.update({
        where: { id: requestId },
        data: { currentStepOrder: step.order },
      });
      const opened: ApprovalStepOpenedEvent = {
        pointCode: req.point.code,
        subjectType: req.subjectType,
        subjectId: req.subjectId,
        stepOrder: step.order,
        stepCode: step.code,
        first:
          step.order ===
          Math.min(...(req.version?.steps ?? []).map((x) => x.order)),
      };
      this.emitAfterCommit(requestId, APPROVAL_STEP_OPENED, opened);
      if (assignees.length) {
        await db.approvalAssignment.createMany({
          data: assignees.map((userId) => ({
            requestId,
            stepOrder: step.order,
            userId,
          })),
          skipDuplicates: true,
        });
        for (const userId of assignees) {
          await this.notifications.notify(userId, {
            titleKey: 'notifications.approval_task_title',
            messageKey: 'notifications.approval_task_message',
            params: { title: req.title, step: step.name },
            link: `/approvals/${req.uniqueId}`,
          });
        }
      } else {
        this.logger.warn(
          `Approval ${req.uniqueId} step ${step.order} has no approver`,
        );
      }
      return;
    }

    const auto = !req.version || req.version.steps.length === 0;
    if (auto) {
      await db.approvalAction.create({
        data: {
          requestId,
          decision: 'AUTO_APPROVED',
          comment: 'No approval steps configured',
        },
      });
    }
    await this.finish(req, 'APPROVED', deciderUserId, tx);
  }

  private conditionHolds(step: ApprovalStep, context: Prisma.JsonValue) {
    const c = step.condition as Condition | null;
    if (!c) return true;
    const ctx = (context ?? {}) as Record<string, unknown>;
    const v = c.path
      .split('.')
      .reduce<unknown>(
        (o, k) =>
          o && typeof o === 'object'
            ? (o as Record<string, unknown>)[k]
            : undefined,
        ctx,
      );
    switch (c.op) {
      case 'eq':
        return v === c.value;
      case 'neq':
        return v !== c.value;
      case 'gt':
        return Number(v) > Number(c.value);
      case 'gte':
        return Number(v) >= Number(c.value);
      case 'lt':
        return Number(v) < Number(c.value);
      case 'lte':
        return Number(v) <= Number(c.value);
      case 'in':
        return Array.isArray(c.value) && c.value.includes(v);
      default:
        return true;
    }
  }

  /** Active users who may decide a step. */
  async resolveAssignees(
    step: Pick<
      ApprovalStep,
      | 'approverType'
      | 'approverUserId'
      | 'approverGroupId'
      | 'approverRoleId'
      | 'rule'
    >,
    req: { subjectDepartmentId: number | null; requesterUserId: number | null },
    tx?: DbTx,
  ): Promise<number[]> {
    const db = tx ?? this.prisma.db;
    const active = {
      status: 'ACTIVE' as const,
      employee: { status: { in: ['ACTIVE' as const, 'ON_LEAVE' as const] } },
    };
    switch (step.approverType) {
      case 'USER': {
        const u = await db.user.findFirst({
          where: { id: step.approverUserId ?? -1, ...active },
        });
        return u ? [u.id] : [];
      }
      case 'GROUP': {
        const members = await db.userGroupMember.findMany({
          where: {
            groupId: step.approverGroupId ?? -1,
            group: { isActive: true },
            user: active,
          },
          select: { userId: true },
        });
        return members.map((m) => m.userId);
      }
      case 'ROLE': {
        const users = await db.user.findMany({
          where: {
            ...active,
            OR: [
              { roles: { some: { roleId: step.approverRoleId ?? -1 } } },
              {
                groups: {
                  some: {
                    group: {
                      isActive: true,
                      roles: { some: { roleId: step.approverRoleId ?? -1 } },
                    },
                  },
                },
              },
            ],
          },
          select: { id: true },
        });
        return users.map((u) => u.id);
      }
      case 'RULE': {
        let deptId: number | null = null;
        if (step.rule === 'HOD_OF_SUBJECT_DEPARTMENT')
          deptId = req.subjectDepartmentId;
        if (
          step.rule === 'HOD_OF_REQUESTER_DEPARTMENT' &&
          req.requesterUserId
        ) {
          const u = await db.user.findUnique({
            where: { id: req.requesterUserId },
            include: { employee: true },
          });
          deptId = u?.employee.departmentId ?? null;
        }
        if (!deptId) return [];
        const headEmployeeId =
          await this.departments.resolveHeadEmployeeId(deptId);
        if (!headEmployeeId) return [];
        const u = await db.user.findFirst({
          where: { employeeId: headEmployeeId, ...active },
        });
        return u ? [u.id] : [];
      }
      default:
        return [];
    }
  }

  private async finish(
    req: RequestRow,
    status: 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED',
    deciderUserId: number | undefined,
    tx?: DbTx,
  ) {
    const db = tx ?? this.prisma.db;
    await db.approvalRequest.update({
      where: { id: req.id },
      data: { status, completedAt: new Date(), currentStepOrder: null },
    });
    await db.approvalAssignment.updateMany({
      where: { requestId: req.id, active: true },
      data: { active: false },
    });
    if (req.requesterUserId && status !== 'CANCELLED') {
      await this.notifications.notify(req.requesterUserId, {
        type: status === 'APPROVED' ? 'SUCCESS' : 'WARNING',
        titleKey: `notifications.approval_${status.toLowerCase()}_title`,
        messageKey: 'notifications.approval_finished_message',
        params: { title: req.title },
        link: `/approvals/${req.uniqueId}`,
      });
    }
    const event: ApprovalCompletedEvent = {
      pointCode: req.point.code,
      subjectType: req.subjectType,
      subjectId: req.subjectId,
      status,
      requestId: req.id,
      deciderUserId,
    };
    // Listeners run after the transaction that made the decision.
    this.emitAfterCommit(req.id, APPROVAL_COMPLETED, event);
  }

  /**
   * Whether `user` may decide the current step, and on whose behalf: an
   * active assignment, or (if the step allows it) an in-force delegation
   * from an assignee.
   */
  private async authority(user: CurrentUser, req: RequestRow) {
    const step = req.version?.steps.find(
      (s) => s.order === req.currentStepOrder,
    );
    if (!step) return null;
    const assigned = req.assignments.filter((a) => a.stepOrder === step.order);
    if (assigned.some((a) => a.userId === user.id))
      return { step, onBehalfOf: null as number | null };
    if (!step.allowDelegation) return null;
    const now = new Date();
    const delegation = await this.prisma.db.delegation.findFirst({
      where: {
        toUserId: user.id,
        status: 'APPROVED',
        start: { lte: now },
        end: { gte: now },
        fromUserId: { in: assigned.map((a) => a.userId) },
      },
    });
    return delegation ? { step, onBehalfOf: delegation.fromUserId } : null;
  }

  async decide(
    actor: CurrentUser,
    uniqueId: string,
    decision: Extract<
      ApprovalDecision,
      'APPROVE' | 'REJECT' | 'RETURN' | 'COMMENT'
    >,
    comment?: string,
  ) {
    const req = await this.prisma.db.approvalRequest.findUnique({
      where: { uniqueId },
      include: REQUEST_INCLUDE,
    });
    if (!req) throw new NotFoundException('errors.record_not_found');
    if (req.status !== 'PENDING')
      throw new BadRequestException('errors.approval_not_pending');

    const auth = await this.authority(actor, req);
    if (!auth) throw new ForbiddenException('errors.approval_not_assigned');
    const permission = APPROVAL_POINTS[req.point.code]?.permission;
    if (permission && !(await this.access.hasAny(actor, permission))) {
      throw new ForbiddenException('errors.forbidden');
    }
    if ((decision === 'REJECT' || decision === 'RETURN') && !comment?.trim()) {
      throw new BadRequestException('errors.approval_reason_required');
    }
    const { step, onBehalfOf } = auth;
    const lastStep = !(req.version?.steps ?? []).some(
      (s) => s.order > step.order && this.conditionHolds(s, req.context),
    );
    await this.guards.get(req.point.code)?.(actor, req, {
      decision,
      stepCode: step.code,
      lastStep,
    });

    const decider = onBehalfOf ?? actor.id;

    await this.prisma.db.$transaction(async (tx) => {
      if (decision === 'APPROVE') {
        const already = req.actions.some(
          (a) =>
            a.stepOrder === step.order &&
            a.decision === 'APPROVE' &&
            (a.onBehalfOfUserId ?? a.userId) === decider,
        );
        if (already)
          throw new BadRequestException('errors.approval_already_given');
      }
      await tx.approvalAction.create({
        data: {
          requestId: req.id,
          stepOrder: step.order,
          stepName: step.name,
          decision,
          userId: actor.id,
          onBehalfOfUserId: onBehalfOf,
          comment: comment?.trim() || null,
        },
      });
      await this.audit.log(
        {
          action: `approval.${decision.toLowerCase()}`,
          entityType: 'ApprovalRequest',
          entityId: req.uniqueId,
          after: { point: req.point.code, step: step.name, comment },
          onBehalfOfUserId: onBehalfOf,
        },
        tx,
      );

      if (decision === 'COMMENT') return;
      if (decision === 'REJECT')
        return this.finish(req, 'REJECTED', actor.id, tx);
      if (decision === 'RETURN')
        return this.finish(req, 'RETURNED', actor.id, tx);

      // APPROVE: is the step satisfied?
      const approvals = new Set(
        (
          await tx.approvalAction.findMany({
            where: {
              requestId: req.id,
              stepOrder: step.order,
              decision: 'APPROVE',
            },
          })
        ).map((a) => a.onBehalfOfUserId ?? a.userId),
      );
      const assigned = req.assignments.filter(
        (a) => a.stepOrder === step.order,
      ).length;
      const needed =
        step.mode === 'ANY'
          ? 1
          : step.mode === 'ALL'
            ? assigned
            : Math.min(step.requiredCount, Math.max(1, assigned));
      if (approvals.size < needed) return;

      await tx.approvalAssignment.updateMany({
        where: { requestId: req.id, stepOrder: step.order },
        data: { active: false },
      });
      await this.advance(req.id, step.order + 1, tx, actor.id);
    });

    return this.detail(actor, uniqueId);
  }

  /** Withdraw a pending request (requester or the owning module). */
  async cancel(requestId: number, reason: string, tx?: DbTx) {
    const req = await this.findById(requestId, tx);
    if (req.status !== 'PENDING') return;
    await (tx ?? this.prisma.db).approvalAction.create({
      data: { requestId, decision: 'COMMENT', comment: `Cancelled: ${reason}` },
    });
    await this.finish(req, 'CANCELLED', undefined, tx);
  }

  /**
   * An approver left (exit clearance): drop their open assignments and, if a
   * step is left without anyone, resolve its approvers again.
   */
  async reassignFrom(userId: number) {
    const open = await this.prisma.db.approvalAssignment.findMany({
      where: { userId, active: true, request: { status: 'PENDING' } },
      include: { request: { include: REQUEST_INCLUDE } },
    });
    for (const a of open) {
      await this.prisma.db.approvalAssignment.update({
        where: { id: a.id },
        data: { active: false },
      });
      const remaining = await this.prisma.db.approvalAssignment.count({
        where: { requestId: a.requestId, stepOrder: a.stepOrder, active: true },
      });
      if (remaining) continue;
      const step = a.request.version?.steps.find(
        (s) => s.order === a.stepOrder,
      );
      if (!step) continue;
      const users = (await this.resolveAssignees(step, a.request)).filter(
        (id) => id !== userId && id !== a.request.requesterUserId,
      );
      for (const id of users) {
        await this.prisma.db.approvalAssignment.upsert({
          where: {
            requestId_stepOrder_userId: {
              requestId: a.requestId,
              stepOrder: a.stepOrder,
              userId: id,
            },
          },
          update: { active: true },
          create: {
            requestId: a.requestId,
            stepOrder: a.stepOrder,
            userId: id,
          },
        });
      }
    }
    return open.length;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  private async users(ids: number[]) {
    const rows = await this.prisma.db.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      include: { employee: true },
    });
    return new Map(
      rows.map((u) => [
        u.id,
        {
          uniqueId: u.uniqueId,
          fullName: `${u.employee.firstName} ${u.employee.lastName}`,
          email: u.email,
        },
      ]),
    );
  }

  private stepState(req: RequestRow, order: number) {
    const acts = req.actions.filter((a) => a.stepOrder === order);
    if (acts.some((a) => a.decision === 'SKIPPED')) return 'SKIPPED';
    if (req.currentStepOrder === order) return 'CURRENT';
    if (
      acts.some((a) => ['APPROVE', 'REJECT', 'RETURN'].includes(a.decision))
    ) {
      return 'DONE';
    }
    return req.status === 'PENDING' ? 'WAITING' : 'NOT_REACHED';
  }

  private async present(req: RequestRow, viewer?: CurrentUser) {
    const ids = [
      ...req.actions.flatMap((a) => [a.userId, a.onBehalfOfUserId]),
      ...req.assignments.map((a) => a.userId),
      req.requesterUserId,
    ].filter((x): x is number => x != null);
    const people = await this.users(ids);
    const steps = req.version?.steps ?? [];
    return {
      uniqueId: req.uniqueId,
      pointCode: req.point.code,
      pointName: req.point.name,
      title: req.title,
      subjectType: req.subjectType,
      subjectId: req.subjectId,
      status: req.status,
      createdAt: req.createdAt,
      completedAt: req.completedAt,
      requester: req.requesterUserId
        ? (people.get(req.requesterUserId) ?? null)
        : null,
      currentStep:
        steps.find((s) => s.order === req.currentStepOrder)?.name ?? null,
      steps: steps.map((s) => ({
        order: s.order,
        name: s.name,
        mode: s.mode,
        requiredCount: s.requiredCount,
        state: this.stepState(req, s.order),
      })),
      assignees: req.assignments
        .map((a) => people.get(a.userId))
        .filter(Boolean),
      noApprover: req.status === 'PENDING' && req.assignments.length === 0,
      actions: req.actions.map((a) => ({
        decision: a.decision,
        stepName: a.stepName,
        comment: a.comment,
        at: a.at,
        user: a.userId ? (people.get(a.userId) ?? null) : null,
        onBehalfOf: a.onBehalfOfUserId
          ? (people.get(a.onBehalfOfUserId) ?? null)
          : null,
      })),
      canDecide:
        viewer && req.status === 'PENDING'
          ? !!(await this.authority(viewer, req))
          : false,
    };
  }

  /** Requests the user can decide now (own assignments + delegated ones). */
  async inbox(user: CurrentUser) {
    const now = new Date();
    const delegators = (
      await this.prisma.db.delegation.findMany({
        where: {
          toUserId: user.id,
          status: 'APPROVED',
          start: { lte: now },
          end: { gte: now },
        },
        select: { fromUserId: true },
      })
    ).map((d) => d.fromUserId);
    const rows = await this.prisma.db.approvalRequest.findMany({
      where: {
        status: 'PENDING',
        assignments: {
          some: { active: true, userId: { in: [user.id, ...delegators] } },
        },
      },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    const out: Awaited<ReturnType<WorkflowService['present']>>[] = [];
    for (const r of rows) {
      if (await this.authority(user, r)) out.push(await this.present(r, user));
    }
    return out;
  }

  async mine(user: CurrentUser) {
    const rows = await this.prisma.db.approvalRequest.findMany({
      where: {
        OR: [
          { requesterUserId: user.id },
          { actions: { some: { userId: user.id } } },
        ],
      },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return Promise.all(rows.map((r) => this.present(r, user)));
  }

  /** Visible to the requester, anyone who acted or is assigned, and workflow viewers. */
  async detail(user: CurrentUser, uniqueId: string) {
    const req = await this.prisma.db.approvalRequest.findUnique({
      where: { uniqueId },
      include: REQUEST_INCLUDE,
    });
    if (!req) throw new NotFoundException('errors.record_not_found');
    const involved =
      req.requesterUserId === user.id ||
      req.actions.some((a) => a.userId === user.id) ||
      req.assignments.some((a) => a.userId === user.id) ||
      !!(await this.authority(user, req)) ||
      (await this.access.hasAny(user, 'workflow.view'));
    if (!involved) throw new ForbiddenException('errors.forbidden');
    return this.present(req, user);
  }

  async forSubject(subjectType: string, subjectId: string) {
    return this.prisma.db.approvalRequest.findMany({
      where: { subjectType, subjectId },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Admin overview of requests (workflow.view). */
  async all(user: CurrentUser, status?: string) {
    await this.access.assert(user, 'workflow.view');
    const rows = await this.prisma.db.approvalRequest.findMany({
      where: status ? { status: status as never } : {},
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return Promise.all(rows.map((r) => this.present(r, user)));
  }
}
