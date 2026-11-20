import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@db';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AuditService } from '../audit/audit.service';
import { AccessService } from './access.service';
import { AccessIntegrityService } from './access-integrity.service';
import { toRoleEntity } from './roles.service';
import {
  CreateGroupInput,
  SetGroupMembersInput,
  SetGroupRolesInput,
  UpdateGroupInput,
} from './dto/role.inputs';

const GROUP_INCLUDE = {
  members: {
    include: {
      user: { include: { employee: { include: { department: true } } } },
    },
  },
  roles: {
    include: {
      role: {
        include: {
          grants: { orderBy: { permissionCode: 'asc' } },
          _count: { select: { users: true } },
        },
      },
    },
  },
} as const satisfies Prisma.UserGroupInclude;

type GroupRow = Prisma.UserGroupGetPayload<{ include: typeof GROUP_INCLUDE }>;

function toEntity(g: GroupRow) {
  return {
    ...g,
    members: g.members.map((m) => ({
      userUniqueId: m.user.uniqueId,
      email: m.user.email,
      fullName: `${m.user.employee.firstName} ${m.user.employee.lastName}`,
      departmentName: m.user.employee.department.name,
    })),
    roles: g.roles.map((r) => toRoleEntity(r.role)),
  };
}

/**
 * Groups: named lists of users used as approval assignees ("any one" or
 * "N of M") and able to hold roles.
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly integrity: AccessIntegrityService,
    private readonly audit: AuditService,
  ) {}

  async list(includeInactive = false) {
    const rows = await this.prisma.db.userGroup.findMany({
      where: includeInactive ? {} : { isActive: true },
      include: GROUP_INCLUDE,
      orderBy: { name: 'asc' },
    });
    return rows.map(toEntity);
  }

  async get(uniqueId: string) {
    const g = await this.prisma.db.userGroup.findFirst({
      where: { uniqueId },
      include: GROUP_INCLUDE,
    });
    if (!g) throw new NotFoundException('errors.record_not_found');
    return toEntity(g);
  }

  async create(actor: CurrentUser, input: CreateGroupInput) {
    const g = await this.prisma.db.userGroup.create({
      data: {
        code: input.code.trim().toUpperCase().replace(/\s+/g, '_'),
        name: input.name.trim(),
        description: input.description,
        createdById: actor.id,
      },
      include: GROUP_INCLUDE,
    });
    await this.audit.log({
      action: 'group.create',
      entityType: 'UserGroup',
      entityId: g.uniqueId,
      after: { code: g.code, name: g.name },
    });
    return toEntity(g);
  }

  async update(actor: CurrentUser, input: UpdateGroupInput) {
    const before = await this.get(input.uniqueId);
    const g = await this.prisma.db.userGroup.update({
      where: { uniqueId: input.uniqueId },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        updatedById: actor.id,
      },
      include: GROUP_INCLUDE,
    });
    await this.audit.log({
      action: 'group.update',
      entityType: 'UserGroup',
      entityId: g.uniqueId,
      before: { name: before.name, description: before.description },
      after: { name: g.name, description: g.description },
    });
    return toEntity(g);
  }

  async setActive(actor: CurrentUser, uniqueId: string, isActive: boolean) {
    await this.prisma.db.$transaction(async (tx) => {
      const g = await tx.userGroup.findFirst({ where: { uniqueId } });
      if (!g) throw new NotFoundException('errors.record_not_found');
      const managersBefore = await this.integrity.countRoleManagers(tx);
      const members = await this.integrity.membersOfGroup(tx, g.id);
      if (isActive) await this.integrity.assertNotSelf(actor, members);
      await tx.userGroup.update({
        where: { id: g.id },
        data: { isActive, updatedById: actor.id },
      });
      await this.integrity.verifyAfterChange(tx, {
        roleManagersBefore: managersBefore,
        affectedUserIds: members,
      });
      await this.audit.log(
        {
          action: isActive ? 'group.activate' : 'group.deactivate',
          entityType: 'UserGroup',
          entityId: uniqueId,
        },
        tx,
      );
    });
    await this.access.invalidateAll();
    return this.get(uniqueId);
  }

  async setMembers(actor: CurrentUser, input: SetGroupMembersInput) {
    await this.prisma.db.$transaction(async (tx) => {
      const g = await tx.userGroup.findFirst({
        where: { uniqueId: input.groupUniqueId, isDeleted: false },
        include: { roles: true, members: true },
      });
      if (!g) throw new NotFoundException('errors.record_not_found');

      const users = await tx.user.findMany({
        where: { uniqueId: { in: input.userUniqueIds }, isDeleted: false },
        select: { id: true, status: true },
      });
      if (users.length !== input.userUniqueIds.length) {
        throw new BadRequestException('errors.user_not_found');
      }
      if (users.some((u) => u.status === 'DEACTIVATED')) {
        throw new BadRequestException('errors.user_deactivated');
      }

      const before = g.members.map((m) => m.userId);
      const after = users.map((u) => u.id);
      const added = after.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !after.includes(id));

      // Joining a group that holds roles = being granted those roles.
      if (g.roles.length && added.length) {
        await this.integrity.assertNotSelf(actor, added);
      }
      const managersBefore = await this.integrity.countRoleManagers(tx);

      await tx.userGroupMember.deleteMany({
        where: { groupId: g.id, userId: { in: removed } },
      });
      await tx.userGroupMember.createMany({
        data: added.map((userId) => ({
          groupId: g.id,
          userId,
          addedById: actor.id,
        })),
      });

      await this.integrity.verifyAfterChange(tx, {
        roleManagersBefore: managersBefore,
        affectedUserIds: added,
      });
      if (g.roles.length) {
        await this.integrity.endSessions(tx, [...added, ...removed]);
      }
      await this.audit.log(
        {
          action: 'group.set_members',
          entityType: 'UserGroup',
          entityId: g.uniqueId,
          before: { userIds: before },
          after: { userIds: after },
        },
        tx,
      );
    });
    await this.access.invalidateAll();
    return this.get(input.groupUniqueId);
  }

  async setRoles(actor: CurrentUser, input: SetGroupRolesInput) {
    await this.prisma.db.$transaction(async (tx) => {
      const g = await tx.userGroup.findFirst({
        where: { uniqueId: input.groupUniqueId, isDeleted: false },
        include: { roles: true },
      });
      if (!g) throw new NotFoundException('errors.record_not_found');
      const roles = await tx.role.findMany({
        where: { uniqueId: { in: input.roleUniqueIds }, isDeleted: false },
        include: { grants: true },
      });
      if (roles.length !== input.roleUniqueIds.length) {
        throw new BadRequestException('errors.role_not_found');
      }
      if (roles.some((r) => r.contextType)) {
        // Context roles (per store / per department) are assigned to users.
        throw new BadRequestException('errors.group_context_role');
      }

      const before = g.roles.map((r) => r.roleId);
      const added = roles.filter((r) => !before.includes(r.id));
      const members = await this.integrity.membersOfGroup(tx, g.id);
      if (added.length) {
        await this.integrity.assertActorHolds(
          actor,
          added.flatMap((r) => r.grants),
        );
        await this.integrity.assertNotSelf(actor, members);
      }
      const managersBefore = await this.integrity.countRoleManagers(tx);

      await tx.groupRole.deleteMany({ where: { groupId: g.id } });
      await tx.groupRole.createMany({
        data: roles.map((r) => ({ groupId: g.id, roleId: r.id })),
      });

      await this.integrity.verifyAfterChange(tx, {
        roleManagersBefore: managersBefore,
        affectedUserIds: members,
      });
      await this.integrity.endSessions(tx, members);
      await this.audit.log(
        {
          action: 'group.set_roles',
          entityType: 'UserGroup',
          entityId: g.uniqueId,
          before: { roleIds: before },
          after: { roleIds: roles.map((r) => r.id) },
        },
        tx,
      );
    });
    await this.access.invalidateAll();
    return this.get(input.groupUniqueId);
  }
}
