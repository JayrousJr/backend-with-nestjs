import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { ClearanceStatus, Prisma } from '@db';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { EVENTS } from '../employees/employees.service';
import {
  APPROVAL_COMPLETED,
  WorkflowService,
  type ApprovalCompletedEvent,
} from '../workflow/workflow.service';

const POINT = 'employee.exit_clearance';

/** Other modules add their items (custody B3, productions 03) on this event. */
export const EXIT_CLEARANCE_OPENED = 'exit_clearance.opened';

const INCLUDE = {
  items: { orderBy: { id: 'asc' } },
} as const satisfies Prisma.ExitClearanceInclude;

type Row = Prisma.ExitClearanceGetPayload<{ include: typeof INCLUDE }>;

export type ItemAction = 'REASSIGN' | 'CANCEL_REQUEST' | 'RESOLVE';

/**
 * Exit clearance (A1 §3.4): when an employee becomes Exited, everything
 * they still hold or own is listed and must be returned, transferred,
 * reassigned or resolved. Sign-off goes through `employee.exit_clearance`
 * (seeded: group HR) only when every item is resolved.
 */
@Injectable()
export class ExitClearanceService implements OnModuleInit {
  private readonly logger = new Logger(ExitClearanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit() {
    // SOD_EXIT_SELF_CLEAR: nobody signs off their own exit clearance.
    this.workflow.registerGuard(POINT, async (actor, request) => {
      const c = await this.prisma.db.exitClearance.findUnique({
        where: { uniqueId: request.subjectId },
      });
      await this.policy.enforceSod(
        'SOD_EXIT_SELF_CLEAR',
        !!c && c.employeeId === actor.employeeId,
      );
    });
  }

  @OnEvent(EVENTS.EMPLOYEE_EXITED, { async: true })
  async onExited({ employeeId }: { employeeId: number }) {
    try {
      await this.open(employeeId);
    } catch (error) {
      this.logger.error(
        `Could not open exit clearance for employee #${employeeId}: ${error}`,
      );
    }
  }

  /** Create the clearance and collect the items known to A1. */
  async open(employeeId: number) {
    const existing = await this.prisma.db.exitClearance.findFirst({
      where: { employeeId, status: { not: 'COMPLETED' } },
    });
    if (existing) return existing;

    const user = await this.prisma.db.user.findUnique({
      where: { employeeId },
    });
    const items: Prisma.ExitClearanceItemCreateWithoutClearanceInput[] = [];
    if (user) {
      const tasks = await this.prisma.db.approvalAssignment.findMany({
        where: {
          userId: user.id,
          active: true,
          request: { status: 'PENDING' },
        },
        include: { request: true },
      });
      for (const t of tasks) {
        items.push({
          type: 'APPROVAL_TASK',
          reference: t.request.uniqueId,
          description: `Approval task: ${t.request.title}`,
        });
      }
      const requests = await this.prisma.db.approvalRequest.findMany({
        where: { requesterUserId: user.id, status: 'PENDING' },
      });
      for (const r of requests) {
        items.push({
          type: 'REQUEST',
          reference: r.uniqueId,
          description: `Open request: ${r.title}`,
        });
      }
    }
    const clearance = await this.prisma.db.exitClearance.create({
      data: { employeeId, items: { create: items } },
    });
    await this.audit.log({
      action: 'exit_clearance.open',
      entityType: 'ExitClearance',
      entityId: clearance.uniqueId,
      after: { employeeId, items: items.length },
    });
    // B3 (custody) and Module 03 (productions) add their items on this event.
    this.events.emit(EXIT_CLEARANCE_OPENED, {
      clearanceId: clearance.id,
      employeeId,
    });
    return clearance;
  }

  private async find(uniqueId: string): Promise<Row> {
    const c = await this.prisma.db.exitClearance.findUnique({
      where: { uniqueId },
      include: INCLUDE,
    });
    if (!c) throw new NotFoundException('errors.record_not_found');
    return c;
  }

  async present(c: Row) {
    const [employee, approval] = await Promise.all([
      this.prisma.db.employee.findUniqueOrThrow({
        where: { id: c.employeeId },
        include: { department: true, jobTitle: true },
      }),
      c.approvalRequestId
        ? this.prisma.db.approvalRequest.findUnique({
            where: { id: c.approvalRequestId },
          })
        : null,
    ]);
    const resolverIds = c.items.flatMap((i) => i.resolvedById ?? []);
    const people = await this.prisma.db.user.findMany({
      where: { id: { in: [...resolverIds, c.signedOffById ?? -1] } },
      include: { employee: true },
    });
    const name = (id: number | null) => {
      const u = people.find((p) => p.id === id);
      return u ? `${u.employee.firstName} ${u.employee.lastName}` : null;
    };
    return {
      uniqueId: c.uniqueId,
      status: c.status,
      createdAt: c.createdAt,
      completedAt: c.completedAt,
      signedOffBy: name(c.signedOffById),
      approvalRequestUniqueId: approval?.uniqueId ?? null,
      employee: {
        uniqueId: employee.uniqueId,
        employeeNumber: employee.employeeNumber,
        fullName: [employee.firstName, employee.middleName, employee.lastName]
          .filter(Boolean)
          .join(' '),
        companyEmail: employee.companyEmail,
        departmentName: employee.department.name,
        jobTitle: employee.jobTitle.name,
      },
      items: c.items.map((i) => ({
        uniqueId: i.uniqueId,
        type: i.type,
        reference: i.reference,
        description: i.description,
        resolved: i.resolved,
        resolution: i.resolution,
        resolvedBy: name(i.resolvedById),
        resolvedAt: i.resolvedAt,
      })),
      openItems: c.items.filter((i) => !i.resolved).length,
    };
  }

  private async canView(user: CurrentUser) {
    return (
      (await this.access.hasAny(user, 'employee.exit')) ||
      (await this.access.hasAny(user, 'employee.exit_clearance.approve'))
    );
  }

  async list(user: CurrentUser, status?: ClearanceStatus) {
    if (!(await this.canView(user)))
      throw new ForbiddenException('errors.forbidden');
    const rows = await this.prisma.db.exitClearance.findMany({
      where: status ? { status } : {},
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return Promise.all(rows.map((r) => this.present(r)));
  }

  async get(user: CurrentUser, uniqueId: string) {
    if (!(await this.canView(user)))
      throw new ForbiddenException('errors.forbidden');
    return this.present(await this.find(uniqueId));
  }

  async forEmployee(user: CurrentUser, employeeUniqueId: string) {
    if (!(await this.canView(user))) return null;
    const e = await this.prisma.db.employee.findFirst({
      where: { uniqueId: employeeUniqueId },
      select: { id: true },
    });
    if (!e) return null;
    const c = await this.prisma.db.exitClearance.findFirst({
      where: { employeeId: e.id },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return c ? this.present(c) : null;
  }

  /** Backfill for employees who exited before clearances existed. */
  async start(actor: CurrentUser, employeeUniqueId: string) {
    await this.access.assert(actor, 'employee.exit');
    const e = await this.prisma.db.employee.findFirst({
      where: { uniqueId: employeeUniqueId },
    });
    if (!e) throw new NotFoundException('errors.employee_not_found');
    if (e.status !== 'EXITED')
      throw new BadRequestException('errors.clearance_not_exited');
    const c = await this.open(e.id);
    return this.present(await this.find(c.uniqueId));
  }

  async resolveItem(
    actor: CurrentUser,
    itemUniqueId: string,
    action: ItemAction,
    note?: string,
  ) {
    await this.access.assert(actor, 'employee.exit');
    const item = await this.prisma.db.exitClearanceItem.findUnique({
      where: { uniqueId: itemUniqueId },
      include: { clearance: true },
    });
    if (!item) throw new NotFoundException('errors.record_not_found');
    if (item.clearance.status !== 'OPEN')
      throw new BadRequestException('errors.clearance_not_open');
    if (item.resolved)
      return this.present(await this.find(item.clearance.uniqueId));
    await this.policy.enforceSod(
      'SOD_EXIT_SELF_CLEAR',
      item.clearance.employeeId === actor.employeeId,
    );

    let resolution: string;
    const user = await this.prisma.db.user.findUnique({
      where: { employeeId: item.clearance.employeeId },
    });
    if (action === 'REASSIGN') {
      if (item.type !== 'APPROVAL_TASK' || !user)
        throw new BadRequestException('errors.clearance_action_invalid');
      const n = await this.workflow.reassignFrom(user.id);
      resolution = `Reassigned (${n} open task${n === 1 ? '' : 's'} handed to the other approvers)`;
      // One reassignment clears every approval-task item of this clearance.
      await this.prisma.db.exitClearanceItem.updateMany({
        where: {
          clearanceId: item.clearanceId,
          type: 'APPROVAL_TASK',
          resolved: false,
        },
        data: {
          resolved: true,
          resolution,
          resolvedById: actor.id,
          resolvedAt: new Date(),
        },
      });
    } else if (action === 'CANCEL_REQUEST') {
      if (item.type !== 'REQUEST' || !item.reference)
        throw new BadRequestException('errors.clearance_action_invalid');
      const req = await this.prisma.db.approvalRequest.findUnique({
        where: { uniqueId: item.reference },
      });
      if (req) await this.workflow.cancel(req.id, 'Requester exited');
      resolution = note?.trim()
        ? `Cancelled: ${note.trim()}`
        : 'Request cancelled';
    } else {
      if (!note?.trim())
        throw new BadRequestException('errors.clearance_note_required');
      resolution = note.trim();
    }
    if (action !== 'REASSIGN') {
      await this.prisma.db.exitClearanceItem.update({
        where: { id: item.id },
        data: {
          resolved: true,
          resolution,
          resolvedById: actor.id,
          resolvedAt: new Date(),
        },
      });
    }
    await this.audit.log({
      action: 'exit_clearance.resolve_item',
      entityType: 'ExitClearance',
      entityId: item.clearance.uniqueId,
      after: { item: item.description, action, resolution },
    });
    return this.present(await this.find(item.clearance.uniqueId));
  }

  /** Every item resolved → sign-off through the approval point. */
  async submit(actor: CurrentUser, uniqueId: string) {
    await this.access.assert(actor, 'employee.exit');
    const c = await this.find(uniqueId);
    if (c.status !== 'OPEN')
      throw new BadRequestException('errors.clearance_not_open');
    if (c.items.some((i) => !i.resolved))
      throw new BadRequestException('errors.clearance_items_open');
    await this.policy.enforceSod(
      'SOD_EXIT_SELF_CLEAR',
      c.employeeId === actor.employeeId,
    );
    const employee = await this.prisma.db.employee.findUniqueOrThrow({
      where: { id: c.employeeId },
    });
    // Status first: with an empty chain the approval completes at once and
    // its completion event must not be overwritten afterwards.
    await this.prisma.db.exitClearance.update({
      where: { id: c.id },
      data: { status: 'IN_APPROVAL' },
    });
    const request = await this.workflow.start({
      pointCode: POINT,
      subjectType: 'ExitClearance',
      subjectId: c.uniqueId,
      subjectDepartmentId: employee.departmentId,
      title: `Exit clearance — ${employee.firstName} ${employee.lastName} (${employee.employeeNumber})`,
      requesterUserId: actor.id,
    });
    await this.prisma.db.exitClearance.update({
      where: { id: c.id },
      data: { approvalRequestId: request.id },
    });
    await this.audit.log({
      action: 'exit_clearance.submit',
      entityType: 'ExitClearance',
      entityId: c.uniqueId,
    });
    return this.present(await this.find(uniqueId));
  }

  @OnEvent(APPROVAL_COMPLETED, { async: true })
  async onApproval(e: ApprovalCompletedEvent) {
    if (e.pointCode !== POINT) return;
    const c = await this.prisma.db.exitClearance.findUnique({
      where: { uniqueId: e.subjectId },
    });
    if (!c) return;
    if (e.status === 'APPROVED') {
      await this.prisma.db.exitClearance.update({
        where: { id: c.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          signedOffById: e.deciderUserId ?? null,
        },
      });
    } else {
      // Rejected / returned: back to the HR team to fix and resubmit.
      await this.prisma.db.exitClearance.update({
        where: { id: c.id },
        data: { status: 'OPEN', approvalRequestId: null },
      });
    }
  }
}
