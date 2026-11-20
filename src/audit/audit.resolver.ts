import { Args, Query, Resolver } from '@nestjs/graphql';
import { AuthUser, PaginationInput, buildPaginationMeta } from '@common';
import type { CurrentUser } from '@common';
import type { Prisma } from '@db';
import { PrismaService } from '@prisma';
import { AccessService, RequirePermission } from '@access';
import {
  AuditLogEntity,
  AuditLogListResponse,
} from './entities/audit-log.entity';
import { AuditFilterInput } from './dto/audit-filter.input';

@Resolver(() => AuditLogEntity)
export class AuditResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  @RequirePermission('audit.view')
  @Query(() => AuditLogListResponse, { name: 'auditLog' })
  async auditLog(
    @AuthUser() user: CurrentUser,
    @Args('filter', { type: () => AuditFilterInput, nullable: true })
    filter?: AuditFilterInput,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
  ): Promise<AuditLogListResponse> {
    const scope = await this.access.scopeWhere<Prisma.AuditLogWhereInput>(
      user,
      'audit.view',
      { department: (ids) => ({ actorDepartmentId: { in: ids } }) },
    );

    let actorUserId: number | undefined;
    if (filter?.actorUniqueId) {
      const actor = await this.prisma.db.user.findFirst({
        where: { uniqueId: filter.actorUniqueId },
        select: { id: true },
      });
      actorUserId = actor?.id ?? -1;
    }

    const where: Prisma.AuditLogWhereInput = {
      AND: [
        scope,
        {
          ...(filter?.entityType && { entityType: filter.entityType }),
          ...(filter?.entityId && { entityId: filter.entityId }),
          ...(filter?.action && { action: { startsWith: filter.action } }),
          ...(actorUserId !== undefined && { actorUserId }),
          ...(filter?.at && {
            at: {
              ...(filter.at.from && { gte: filter.at.from }),
              ...(filter.at.to && { lte: filter.at.to }),
            },
          }),
        },
      ],
    };

    const page = Math.max(1, pagination?.page ?? 1);
    const limit = Math.min(100, pagination?.limit ?? 25);
    const [rows, total] = await Promise.all([
      this.prisma.dbRaw.auditLog.findMany({
        where,
        orderBy: { at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.dbRaw.auditLog.count({ where }),
    ]);

    const userIds = [
      ...new Set(
        rows
          .flatMap((r) => [r.actorUserId, r.onBehalfOfUserId])
          .filter((id): id is number => id != null),
      ),
    ];
    const users = await this.prisma.dbRaw.user.findMany({
      where: { id: { in: userIds } },
      include: { employee: true },
    });
    const byId = new Map(
      users.map((u) => [
        u.id,
        {
          uniqueId: u.uniqueId,
          email: u.email,
          fullName: `${u.employee.firstName} ${u.employee.lastName}`,
        },
      ]),
    );

    return {
      data: rows.map((r) => ({
        id: r.id.toString(),
        at: r.at,
        actor: r.actorUserId ? byId.get(r.actorUserId) : null,
        onBehalfOf: r.onBehalfOfUserId ? byId.get(r.onBehalfOfUserId) : null,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        before: r.before == null ? null : JSON.stringify(r.before),
        after: r.after == null ? null : JSON.stringify(r.after),
        ipAddress: r.ipAddress,
      })),
      ...buildPaginationMeta(total, page, limit),
    };
  }
}
