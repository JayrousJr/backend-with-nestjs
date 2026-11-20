import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@db';
import { PrismaService } from '@prisma';
import { PaginationInput, buildPaginationMeta } from '@common';
import type { CurrentUser } from '@common';
import {
  AccessIntegrityService,
  AccessService,
  UserRolesService,
} from '@access';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { MailService } from '../mail/mail.service';
import { toEmployeeRef } from '../org/employee-ref';
import { OnEvent } from '@nestjs/event-emitter';
import {
  APPROVAL_COMPLETED,
  WorkflowService,
  type ApprovalCompletedEvent,
} from '../workflow/workflow.service';

const CREATION_POINT = 'user.creation';
import { AuthTokensService } from './auth-tokens.service';
import {
  CreateUsersFromEmployeesInput,
  RoleAssignmentInput,
  UserFilterInput,
} from './dto/user.inputs';

export const USER_INCLUDE = {
  employee: { include: { department: true, jobTitle: true } },
  roles: { include: { role: true } },
  groups: { include: { group: true } },
} as const satisfies Prisma.UserInclude;

export type UserRow = Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }>;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly integrity: AccessIntegrityService,
    private readonly userRoles: UserRolesService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly tokens: AuthTokensService,
    private readonly workflow: WorkflowService,
  ) {}

  /** Status of the user.creation approval (null when none was needed). */
  private async creationApproval(uniqueId: string) {
    const req = await this.prisma.db.approvalRequest.findFirst({
      where: {
        subjectType: 'User',
        subjectId: uniqueId,
        point: { code: CREATION_POINT },
      },
      orderBy: { createdAt: 'desc' },
    });
    return req ? { status: req.status, uniqueId: req.uniqueId } : null;
  }

  /** Map to the GraphQL shape; resolves role context names. */
  async toEntity(u: UserRow) {
    const deptIds = u.roles
      .filter((r) => r.contextType === 'DEPARTMENT' && r.contextId)
      .map((r) => r.contextId!);
    const depts = deptIds.length
      ? await this.prisma.db.department.findMany({
          where: { id: { in: deptIds } },
        })
      : [];
    const deptById = new Map(depts.map((d) => [d.id, d]));
    const storeIds = u.roles
      .filter((r) => r.contextType === 'STORE' && r.contextId)
      .map((r) => r.contextId!);
    const stores = storeIds.length
      ? await this.prisma.db.store.findMany({ where: { id: { in: storeIds } } })
      : [];
    const storeById = new Map(stores.map((s) => [s.id, s]));
    const e = u.employee;
    const approval = await this.creationApproval(u.uniqueId);
    return {
      ...u,
      creationApprovalStatus: approval?.status ?? null,
      creationApprovalUniqueId: approval?.uniqueId ?? null,
      employee: toEmployeeRef(e)!,
      department: {
        uniqueId: e.department.uniqueId,
        code: e.department.code,
        name: e.department.name,
      },
      jobTitle: e.jobTitle.name,
      roles: u.roles.map((r) => {
        const ctx = !r.contextId
          ? undefined
          : r.contextType === 'DEPARTMENT'
            ? deptById.get(r.contextId)
            : r.contextType === 'STORE'
              ? storeById.get(r.contextId)
              : undefined;
        return {
          roleUniqueId: r.role.uniqueId,
          roleName: r.role.name,
          contextType: r.contextType,
          contextUniqueId: ctx?.uniqueId ?? null,
          contextName: ctx?.name ?? null,
        };
      }),
      groups: u.groups
        .filter((g) => g.group.isActive)
        .map((g) => ({
          uniqueId: g.group.uniqueId,
          code: g.group.code,
          name: g.group.name,
        })),
    };
  }

  private async find(uniqueId: string): Promise<UserRow> {
    const u = await this.prisma.db.user.findFirst({
      where: { uniqueId },
      include: USER_INCLUDE,
    });
    if (!u) throw new NotFoundException('errors.user_not_found');
    return u;
  }

  async me(user: CurrentUser) {
    const u = await this.find(user.uniqueId);
    const grants = await this.access.getGrants(user.id);
    return {
      ...(await this.toEntity(u)),
      permissions: [...new Set(grants.map((g) => g.permission))].sort(),
      grants: grants.map((g) => ({
        ...g,
        delegated: g.onBehalfOfUserId != null,
      })),
      employeeStatus: u.employee.status,
    };
  }

  async list(filter?: UserFilterInput, pagination?: PaginationInput) {
    const and: Prisma.UserWhereInput[] = [];
    if (filter?.search) {
      const q = filter.search.trim();
      and.push({
        OR: [
          { email: { contains: q, mode: 'insensitive' } },
          { employee: { firstName: { contains: q, mode: 'insensitive' } } },
          { employee: { lastName: { contains: q, mode: 'insensitive' } } },
          {
            employee: { employeeNumber: { contains: q, mode: 'insensitive' } },
          },
        ],
      });
    }
    if (filter?.statuses?.length) and.push({ status: { in: filter.statuses } });
    if (filter?.roleUniqueId) {
      and.push({
        roles: { some: { role: { uniqueId: filter.roleUniqueId } } },
      });
    }
    if (filter?.departmentUniqueId) {
      and.push({
        employee: { department: { uniqueId: filter.departmentUniqueId } },
      });
    }
    const where: Prisma.UserWhereInput = { AND: and };
    const page = Math.max(1, pagination?.page ?? 1);
    const limit = Math.min(100, pagination?.limit ?? 25);
    const [rows, total] = await Promise.all([
      this.prisma.db.user.findMany({
        where,
        include: USER_INCLUDE,
        orderBy: { email: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.db.user.count({ where }),
    ]);
    return {
      data: await Promise.all(rows.map((r) => this.toEntity(r))),
      ...buildPaginationMeta(total, page, limit),
    };
  }

  async get(uniqueId: string) {
    return this.toEntity(await this.find(uniqueId));
  }

  /**
   * Create users from Active employees without a user (single or bulk).
   * Login email = company email. Creation goes through the `user.creation`
   * approval point (seeded with no steps); the activation link is emailed
   * once it is approved (see onCreationDecided).
   */
  async createFromEmployees(
    actor: CurrentUser,
    input: CreateUsersFromEmployeesInput,
  ) {
    const employees = await this.prisma.db.employee.findMany({
      where: { uniqueId: { in: input.employeeUniqueIds } },
      include: { user: true },
    });
    const eligible: typeof employees = [];
    const skipped: string[] = [];
    for (const uid of input.employeeUniqueIds) {
      const e = employees.find((x) => x.uniqueId === uid);
      if (
        !e ||
        e.user ||
        e.status !== 'ACTIVE' ||
        !(await this.policy.isAllowedEmail(e.companyEmail))
      ) {
        skipped.push(uid);
        continue;
      }
      eligible.push(e);
    }

    const created: UserRow[] = [];
    for (const e of eligible) {
      const user = await this.prisma.db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            employeeId: e.id,
            email: e.companyEmail,
            status: 'PENDING_ACTIVATION',
            createdById: actor.id,
          },
          include: USER_INCLUDE,
        });
        await this.audit.log(
          {
            action: 'user.create',
            entityType: 'User',
            entityId: user.uniqueId,
            after: { email: user.email, employeeId: e.id },
          },
          tx,
        );
        return user;
      });
      if (input.roles?.length) {
        await this.userRoles.setUserRoles(actor, user.uniqueId, input.roles);
      }
      await this.workflow.start({
        pointCode: CREATION_POINT,
        subjectType: 'User',
        subjectId: user.uniqueId,
        subjectDepartmentId: e.departmentId,
        title: `New user — ${e.firstName} ${e.lastName} (${e.companyEmail})`,
        requesterUserId: actor.id,
      });
      created.push(await this.find(user.uniqueId));
    }

    this.logger.log(
      `Users created: ${created.length}, skipped: ${skipped.length}`,
    );
    return {
      created: await Promise.all(created.map((u) => this.toEntity(u))),
      skipped,
    };
  }

  /** Approved → send the activation link; rejected/returned → deactivate. */
  @OnEvent(APPROVAL_COMPLETED, { async: true })
  async onCreationDecided(e: ApprovalCompletedEvent) {
    if (e.pointCode !== CREATION_POINT) return;
    const u = await this.prisma.db.user.findFirst({
      where: { uniqueId: e.subjectId },
      include: USER_INCLUDE,
    });
    if (!u || u.status !== 'PENDING_ACTIVATION') return;
    if (e.status === 'APPROVED') {
      await this.sendActivation(u);
    } else if (e.status !== 'CANCELLED') {
      await this.prisma.db.user.update({
        where: { id: u.id },
        data: { status: 'DEACTIVATED' },
      });
      await this.audit.log({
        action: 'user.creation_rejected',
        entityType: 'User',
        entityId: u.uniqueId,
      });
    }
  }

  private async sendActivation(u: UserRow) {
    const hours = await this.policy.activationHours();
    const token = await this.tokens.issue(
      u.id,
      'ACTIVATION',
      hours * 3_600_000,
    );
    await this.mail.queueActivationEmail({
      email: u.email,
      firstName: u.employee.firstName,
      token,
      locale: u.preferredLocale,
      validFor: hours,
    });
  }

  async resendActivation(actor: CurrentUser, uniqueId: string) {
    const u = await this.find(uniqueId);
    if (u.status !== 'PENDING_ACTIVATION') {
      throw new BadRequestException('errors.user_already_active');
    }
    const approval = await this.creationApproval(u.uniqueId);
    if (approval && approval.status !== 'APPROVED') {
      throw new BadRequestException('errors.user_awaiting_approval');
    }
    const hours = await this.policy.activationHours();
    const token = await this.tokens.issue(
      u.id,
      'ACTIVATION',
      hours * 3_600_000,
    );
    await this.mail.queueActivationEmail({
      email: u.email,
      firstName: u.employee.firstName,
      token,
      locale: u.preferredLocale,
      validFor: hours,
    });
    await this.audit.log({
      action: 'user.resend_activation',
      entityType: 'User',
      entityId: u.uniqueId,
    });
    return this.toEntity(u);
  }

  async sendPasswordReset(actor: CurrentUser, uniqueId: string) {
    const u = await this.find(uniqueId);
    if (u.status !== 'ACTIVE') {
      throw new BadRequestException('errors.user_not_active');
    }
    const minutes = await this.policy.resetMinutes();
    const token = await this.tokens.issue(
      u.id,
      'PASSWORD_RESET',
      minutes * 60_000,
    );
    await this.mail.queuePasswordResetEmail({
      email: u.email,
      firstName: u.employee.firstName,
      token,
      locale: u.preferredLocale,
      validFor: minutes,
    });
    await this.audit.log({
      action: 'user.reset_password',
      entityType: 'User',
      entityId: u.uniqueId,
    });
    return true;
  }

  async deactivate(actor: CurrentUser, uniqueId: string) {
    const u = await this.find(uniqueId);
    if (u.id === actor.id) {
      throw new BadRequestException('errors.cannot_deactivate_self');
    }
    await this.prisma.db.$transaction(async (tx) => {
      const managersBefore = await this.integrity.countRoleManagers(tx);
      await tx.user.update({
        where: { id: u.id },
        data: { status: 'DEACTIVATED', updatedById: actor.id },
      });
      await this.integrity.endSessions(tx, [u.id]);
      await tx.delegation.updateMany({
        where: {
          OR: [{ fromUserId: u.id }, { toUserId: u.id }],
          status: { in: ['PENDING', 'APPROVED'] },
        },
        data: { status: 'CANCELLED' },
      });
      await this.integrity.verifyAfterChange(tx, {
        roleManagersBefore: managersBefore,
        affectedUserIds: [],
      });
      await this.audit.log(
        {
          action: 'user.deactivate',
          entityType: 'User',
          entityId: u.uniqueId,
          before: { status: u.status },
          after: { status: 'DEACTIVATED' },
        },
        tx,
      );
    });
    await this.access.invalidateAll();
    return this.get(uniqueId);
  }

  /** Reactivate — only while the employee is Active (or On Leave). */
  async reactivate(actor: CurrentUser, uniqueId: string) {
    const u = await this.find(uniqueId);
    if (!['ACTIVE', 'ON_LEAVE'].includes(u.employee.status)) {
      throw new BadRequestException('errors.employee_not_active');
    }
    if (u.status !== 'DEACTIVATED') return this.toEntity(u);
    const status = u.password ? 'ACTIVE' : 'PENDING_ACTIVATION';
    await this.prisma.db.user.update({
      where: { id: u.id },
      data: {
        status,
        failedLoginAttempts: 0,
        lockedUntil: null,
        updatedById: actor.id,
      },
    });
    await this.audit.log({
      action: 'user.reactivate',
      entityType: 'User',
      entityId: u.uniqueId,
      before: { status: u.status },
      after: { status },
    });
    await this.access.invalidateAll();
    return this.get(uniqueId);
  }

  async unlock(actor: CurrentUser, uniqueId: string) {
    const u = await this.find(uniqueId);
    await this.prisma.db.user.update({
      where: { id: u.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        ...(u.status === 'LOCKED' && { status: 'ACTIVE' }),
        updatedById: actor.id,
      },
    });
    await this.audit.log({
      action: 'user.unlock',
      entityType: 'User',
      entityId: u.uniqueId,
    });
    return this.get(uniqueId);
  }

  async setRoles(
    actor: CurrentUser,
    userUniqueId: string,
    roles: RoleAssignmentInput[],
  ) {
    await this.userRoles.setUserRoles(actor, userUniqueId, roles);
    return this.get(userUniqueId);
  }

  async updatePreferences(user: CurrentUser, preferredLocale: string) {
    await this.prisma.db.user.update({
      where: { id: user.id },
      data: { preferredLocale },
    });
    return this.me(user);
  }

  async loginEvents(userUniqueId?: string, pagination?: PaginationInput) {
    let userId: number | undefined;
    if (userUniqueId) userId = (await this.find(userUniqueId)).id;
    const where: Prisma.LoginEventWhereInput = userId ? { userId } : {};
    const page = Math.max(1, pagination?.page ?? 1);
    const limit = Math.min(100, pagination?.limit ?? 25);
    const [rows, total] = await Promise.all([
      this.prisma.dbRaw.loginEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.dbRaw.loginEvent.count({ where }),
    ]);
    return { data: rows, ...buildPaginationMeta(total, page, limit) };
  }

  async myLoginEvents(user: CurrentUser) {
    const rows = await this.prisma.dbRaw.loginEvent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return rows;
  }

  assertSignedIn(user?: CurrentUser): asserts user is CurrentUser {
    if (!user) throw new UnauthorizedException();
  }
}
