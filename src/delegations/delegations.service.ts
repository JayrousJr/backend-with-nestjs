import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { DelegationStatus, Prisma } from '@db';
import { PrismaService } from '@prisma';
import { buildPaginationMeta, PaginationInput } from '@common';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { NotificationsService } from '../notifications/notifications.service';

const USER_REF = {
  include: { employee: { include: { department: true } } },
} as const;

type UserRow = Prisma.UserGetPayload<typeof USER_REF>;

const userRef = (u: UserRow) => ({
  uniqueId: u.uniqueId,
  email: u.email,
  fullName: `${u.employee.firstName} ${u.employee.lastName}`,
  departmentName: u.employee.department.name,
});

export interface CreateDelegation {
  fromUserUniqueId?: string;
  toUserUniqueId: string;
  roleUniqueIds: string[];
  start: Date;
  end: Date;
  reason: string;
}

/**
 * Delegation (A1 §8): a user hands some or all roles to another active user
 * for a period, with a reason; approved by a holder of delegation.approve
 * (never by the delegator — SOD_DELEGATE_SELF). Approved, in-force
 * delegations add the delegator's grants to the delegate (AccessService),
 * marked "on behalf of". They end automatically and are cancelled when
 * either user is deactivated.
 */
@Injectable()
export class DelegationsService {
  private readonly logger = new Logger(DelegationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async toEntity(d: Prisma.DelegationGetPayload<object>) {
    const ids = [d.fromUserId, d.toUserId, d.approvedById].filter(
      (x): x is number => x != null,
    );
    const users = await this.prisma.db.user.findMany({
      where: { id: { in: ids } },
      ...USER_REF,
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const roles = d.roleIds.length
      ? await this.prisma.db.role.findMany({ where: { id: { in: d.roleIds } } })
      : [];
    const now = new Date();
    return {
      uniqueId: d.uniqueId,
      from: userRef(byId.get(d.fromUserId)!),
      to: userRef(byId.get(d.toUserId)!),
      approvedBy: d.approvedById ? userRef(byId.get(d.approvedById)!) : null,
      roles: roles.map((r) => ({ uniqueId: r.uniqueId, name: r.name })),
      allRoles: d.roleIds.length === 0,
      start: d.start,
      end: d.end,
      reason: d.reason,
      status: d.status,
      inForce: d.status === 'APPROVED' && d.start <= now && d.end >= now,
      decidedAt: d.decidedAt,
      createdAt: d.createdAt,
    };
  }

  async list(
    user: CurrentUser,
    scope: 'mine' | 'pending' | 'all',
    status?: DelegationStatus,
    pagination?: PaginationInput,
  ) {
    let where: Prisma.DelegationWhereInput;
    if (scope === 'mine') {
      where = { OR: [{ fromUserId: user.id }, { toUserId: user.id }] };
    } else {
      await this.access.assert(user, 'delegation.approve');
      where = scope === 'pending' ? { status: 'PENDING' } : {};
    }
    if (status) where = { AND: [where, { status }] };
    const page = Math.max(1, pagination?.page ?? 1);
    const limit = Math.min(100, pagination?.limit ?? 25);
    const [rows, total] = await Promise.all([
      this.prisma.db.delegation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.db.delegation.count({ where }),
    ]);
    return {
      data: await Promise.all(rows.map((r) => this.toEntity(r))),
      ...buildPaginationMeta(total, page, limit),
    };
  }

  async create(actor: CurrentUser, input: CreateDelegation) {
    if (input.end <= input.start) {
      throw new BadRequestException('errors.invalid_date_range');
    }
    if (input.end < new Date()) {
      throw new BadRequestException('errors.delegation_in_past');
    }

    // Delegating someone else's roles needs the ALL scope.
    let fromUserId = actor.id;
    if (input.fromUserUniqueId && input.fromUserUniqueId !== actor.uniqueId) {
      const scope = await this.access.resolveScope(actor, 'delegation.create');
      if (!scope.all) {
        throw new BadRequestException('errors.forbidden');
      }
      const from = await this.prisma.db.user.findFirst({
        where: { uniqueId: input.fromUserUniqueId },
      });
      if (!from) throw new NotFoundException('errors.user_not_found');
      fromUserId = from.id;
    } else {
      await this.access.assert(actor, 'delegation.create', {
        ownerUserIds: [actor.id],
      });
    }

    const to = await this.prisma.db.user.findFirst({
      where: { uniqueId: input.toUserUniqueId },
      include: { employee: true },
    });
    if (!to || to.status !== 'ACTIVE' || to.employee.status !== 'ACTIVE') {
      throw new BadRequestException('errors.delegate_not_active');
    }
    if (to.id === fromUserId) {
      throw new BadRequestException('errors.delegate_self');
    }

    const held = await this.prisma.db.userRole.findMany({
      where: { userId: fromUserId, role: { isActive: true } },
      include: { role: true },
    });
    let roleIds: number[] = [];
    if (input.roleUniqueIds.length) {
      roleIds = held
        .filter((h) => input.roleUniqueIds.includes(h.role.uniqueId))
        .map((h) => h.roleId);
      if (new Set(roleIds).size !== new Set(input.roleUniqueIds).size) {
        throw new BadRequestException('errors.delegate_role_not_held');
      }
      roleIds = [...new Set(roleIds)];
    } else if (!held.length) {
      throw new BadRequestException('errors.delegate_no_roles');
    }

    const d = await this.prisma.db.delegation.create({
      data: {
        fromUserId,
        toUserId: to.id,
        roleIds,
        start: input.start,
        end: input.end,
        reason: input.reason.trim(),
        createdById: actor.id,
      },
    });
    await this.audit.log({
      action: 'delegation.create',
      entityType: 'Delegation',
      entityId: d.uniqueId,
      after: d,
    });
    await this.notifyApprovers(d.uniqueId);
    return this.toEntity(d);
  }

  /** Approvers = active users holding delegation.approve. */
  private async notifyApprovers(uniqueId: string) {
    const users = await this.prisma.db.user.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          {
            roles: {
              some: {
                role: {
                  isActive: true,
                  grants: { some: { permissionCode: 'delegation.approve' } },
                },
              },
            },
          },
          {
            groups: {
              some: {
                group: {
                  isActive: true,
                  roles: {
                    some: {
                      role: {
                        isActive: true,
                        grants: {
                          some: { permissionCode: 'delegation.approve' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      select: { id: true },
    });
    for (const u of users) {
      await this.notifications.notify(u.id, {
        titleKey: 'notifications.delegation_pending_title',
        messageKey: 'notifications.delegation_pending_message',
        link: `/delegations?tab=pending&focus=${uniqueId}`,
      });
    }
  }

  private async find(uniqueId: string) {
    const d = await this.prisma.db.delegation.findFirst({
      where: { uniqueId },
    });
    if (!d) throw new NotFoundException('errors.record_not_found');
    return d;
  }

  async decide(actor: CurrentUser, uniqueId: string, approve: boolean) {
    await this.access.assert(actor, 'delegation.approve');
    const d = await this.find(uniqueId);
    if (d.status !== 'PENDING') {
      throw new BadRequestException('errors.delegation_not_pending');
    }
    await this.policy.enforceSod(
      'SOD_DELEGATE_SELF',
      d.fromUserId === actor.id || d.toUserId === actor.id,
    );
    const status: DelegationStatus = approve ? 'APPROVED' : 'REJECTED';
    const after = await this.prisma.db.delegation.update({
      where: { id: d.id },
      data: { status, approvedById: actor.id, decidedAt: new Date() },
    });
    await this.audit.log({
      action: approve ? 'delegation.approve' : 'delegation.reject',
      entityType: 'Delegation',
      entityId: uniqueId,
      before: { status: d.status },
      after: { status },
    });
    await this.access.invalidateAll();
    for (const userId of [d.fromUserId, d.toUserId]) {
      await this.notifications.notify(userId, {
        type: approve ? 'SUCCESS' : 'WARNING',
        titleKey: approve
          ? 'notifications.delegation_approved_title'
          : 'notifications.delegation_rejected_title',
        messageKey: 'notifications.delegation_decided_message',
        link: '/delegations',
      });
    }
    return this.toEntity(after);
  }

  /** The delegator, the delegate or an approver may cancel. */
  async cancel(actor: CurrentUser, uniqueId: string) {
    const d = await this.find(uniqueId);
    const own = d.fromUserId === actor.id || d.toUserId === actor.id;
    if (!own) await this.access.assert(actor, 'delegation.approve');
    if (!['PENDING', 'APPROVED'].includes(d.status)) {
      throw new BadRequestException('errors.delegation_not_active');
    }
    const after = await this.prisma.db.delegation.update({
      where: { id: d.id },
      data: { status: 'CANCELLED' },
    });
    await this.audit.log({
      action: 'delegation.cancel',
      entityType: 'Delegation',
      entityId: uniqueId,
      before: { status: d.status },
      after: { status: 'CANCELLED' },
    });
    await this.access.invalidateAll();
    return this.toEntity(after);
  }

  /** Delegations end automatically (grants already stop at `end`). */
  @Cron(CronExpression.EVERY_HOUR)
  async expire() {
    const { count } = await this.prisma.db.delegation.updateMany({
      where: {
        status: { in: ['APPROVED', 'PENDING'] },
        end: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
    if (count) {
      this.logger.log(`Expired ${count} delegations`);
      await this.access.invalidateAll();
    }
  }
}
