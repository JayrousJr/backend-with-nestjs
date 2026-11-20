import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@db';
import { PrismaService } from '@prisma';
import { PaginationInput, buildPaginationMeta } from '@common';
import type { CurrentUser } from '@common';
import { AuditService } from '../audit/audit.service';
import { AccessService } from './access.service';
import { AccessIntegrityService } from './access-integrity.service';
import {
  CreateRoleInput,
  RoleGrantInput,
  UpdateRoleInput,
} from './dto/role.inputs';

const ROLE_INCLUDE = {
  grants: { orderBy: { permissionCode: 'asc' } },
  _count: { select: { users: true } },
} as const satisfies Prisma.RoleInclude;

type RoleRow = Prisma.RoleGetPayload<{ include: typeof ROLE_INCLUDE }>;

export function toRoleEntity(r: RoleRow) {
  return {
    ...r,
    grants: r.grants.map((g) => ({
      permissionCode: g.permissionCode,
      scope: g.scope,
      valueLimit: g.valueLimit == null ? null : Number(g.valueLimit),
    })),
    userCount: r._count.users,
  };
}

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly integrity: AccessIntegrityService,
    private readonly audit: AuditService,
  ) {}

  permissions() {
    return this.prisma.db.permission.findMany({
      where: { isActive: true },
      orderBy: [{ module: 'asc' }, { code: 'asc' }],
    });
  }

  async list(
    search?: string,
    includeRetired = false,
    pagination?: PaginationInput,
  ) {
    const where: Prisma.RoleWhereInput = {
      ...(includeRetired ? {} : { isActive: true }),
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
    };
    const page = Math.max(1, pagination?.page ?? 1);
    const limit = Math.min(100, pagination?.limit ?? 50);
    const [rows, total] = await Promise.all([
      this.prisma.db.role.findMany({
        where,
        include: ROLE_INCLUDE,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.db.role.count({ where }),
    ]);
    return {
      data: rows.map(toRoleEntity),
      ...buildPaginationMeta(total, page, limit),
    };
  }

  async get(uniqueId: string) {
    const role = await this.prisma.db.role.findFirst({
      where: { uniqueId },
      include: ROLE_INCLUDE,
    });
    if (!role) throw new NotFoundException('errors.record_not_found');
    return toRoleEntity(role);
  }

  async create(actor: CurrentUser, input: CreateRoleInput) {
    const grants = dedupe(input.grants);
    const role = await this.prisma.db.$transaction(async (tx) => {
      await this.integrity.validateGrants(tx, grants);
      await this.integrity.assertActorHolds(actor, grants);
      const created = await tx.role.create({
        data: {
          name: input.name.trim(),
          description: input.description,
          contextType: input.contextType,
          createdById: actor.id,
          grants: { create: grants.map(grantData) },
        },
        include: ROLE_INCLUDE,
      });
      await this.audit.log(
        {
          action: 'role.create',
          entityType: 'Role',
          entityId: created.uniqueId,
          after: created,
        },
        tx,
      );
      return created;
    });
    return toRoleEntity(role);
  }

  async update(actor: CurrentUser, input: UpdateRoleInput) {
    const role = await this.prisma.db.$transaction(async (tx) => {
      const before = await tx.role.findFirst({
        where: { uniqueId: input.uniqueId, isDeleted: false },
        include: ROLE_INCLUDE,
      });
      if (!before) throw new NotFoundException('errors.record_not_found');

      const managersBefore = await this.integrity.countRoleManagers(tx);
      const holders = await this.integrity.holdersOfRole(tx, before.id);

      if (input.grants) {
        const grants = dedupe(input.grants);
        await this.integrity.validateGrants(tx, grants);
        // Only *added* grants need the actor to hold them.
        const added = grants.filter(
          (g) =>
            !before.grants.some(
              (b) =>
                b.permissionCode === g.permissionCode && b.scope === g.scope,
            ),
        );
        if (added.length) {
          await this.integrity.assertActorHolds(actor, added);
          // Adding permissions to a role you hold = granting to yourself.
          await this.integrity.assertNotSelf(actor, holders);
        }
        await tx.roleGrant.deleteMany({ where: { roleId: before.id } });
        await tx.roleGrant.createMany({
          data: grants.map((g) => ({ ...grantData(g), roleId: before.id })),
        });
      }

      const after = await tx.role.update({
        where: { id: before.id },
        data: {
          ...(input.name !== undefined && { name: input.name.trim() }),
          ...(input.description !== undefined && {
            description: input.description,
          }),
          updatedById: actor.id,
        },
        include: ROLE_INCLUDE,
      });

      await this.integrity.verifyAfterChange(tx, {
        roleManagersBefore: managersBefore,
        affectedUserIds: holders,
      });
      await this.audit.log(
        {
          action: 'role.update',
          entityType: 'Role',
          entityId: after.uniqueId,
          before,
          after,
        },
        tx,
      );
      return after;
    });
    await this.access.invalidateAll();
    return toRoleEntity(role);
  }

  /** Copy a role (grants included) under a new name. */
  async copy(actor: CurrentUser, uniqueId: string, name: string) {
    const source = await this.get(uniqueId);
    return this.create(actor, {
      name,
      description: source.description ?? undefined,
      contextType: source.contextType ?? undefined,
      grants: source.grants.map((g) => ({
        permissionCode: g.permissionCode,
        scope: g.scope,
        valueLimit: g.valueLimit ?? undefined,
      })),
    });
  }

  /** Retire / reinstate. Retired roles grant nothing but stay on record. */
  async setActive(actor: CurrentUser, uniqueId: string, isActive: boolean) {
    const role = await this.prisma.db.$transaction(async (tx) => {
      const before = await tx.role.findFirst({
        where: { uniqueId, isDeleted: false },
        include: ROLE_INCLUDE,
      });
      if (!before) throw new NotFoundException('errors.record_not_found');
      const managersBefore = await this.integrity.countRoleManagers(tx);
      const holders = await this.integrity.holdersOfRole(tx, before.id);
      if (isActive) await this.integrity.assertNotSelf(actor, holders);

      const after = await tx.role.update({
        where: { id: before.id },
        data: { isActive, updatedById: actor.id },
        include: ROLE_INCLUDE,
      });
      await this.integrity.verifyAfterChange(tx, {
        roleManagersBefore: managersBefore,
        affectedUserIds: holders,
      });
      await this.audit.log(
        {
          action: isActive ? 'role.reinstate' : 'role.retire',
          entityType: 'Role',
          entityId: uniqueId,
          before: { isActive: before.isActive },
          after: { isActive },
        },
        tx,
      );
      return after;
    });
    await this.access.invalidateAll();
    return toRoleEntity(role);
  }
}

function dedupe(grants: RoleGrantInput[]): RoleGrantInput[] {
  const seen = new Map<string, RoleGrantInput>();
  for (const g of grants) seen.set(`${g.permissionCode}|${g.scope}`, g);
  return [...seen.values()];
}

function grantData(g: RoleGrantInput) {
  return {
    permissionCode: g.permissionCode,
    scope: g.scope,
    valueLimit: g.valueLimit,
  };
}
