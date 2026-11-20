import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import type { RoleContextType } from '@db';
import { AuditService } from '../audit/audit.service';
import { AccessService } from './access.service';
import { AccessIntegrityService } from './access-integrity.service';

export interface RoleAssignment {
  roleUniqueId: string;
  /** Store or department uniqueId, required for context roles. */
  contextUniqueId?: string;
}

/** Assigning roles to users (user.assign_role) within the §6.7 rules. */
@Injectable()
export class UserRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly integrity: AccessIntegrityService,
    private readonly audit: AuditService,
  ) {}

  /** Replace the user's direct role assignments. */
  async setUserRoles(
    actor: CurrentUser,
    userUniqueId: string,
    assignments: RoleAssignment[],
  ): Promise<void> {
    await this.prisma.db.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { uniqueId: userUniqueId, isDeleted: false },
        include: { roles: true },
      });
      if (!user) throw new NotFoundException('errors.user_not_found');
      await this.integrity.assertNotSelf(actor, [user.id]);

      const roles = await tx.role.findMany({
        where: {
          uniqueId: { in: assignments.map((a) => a.roleUniqueId) },
          isActive: true,
          isDeleted: false,
        },
        include: { grants: true },
      });
      const byUid = new Map(roles.map((r) => [r.uniqueId, r]));

      const rows: {
        roleId: number;
        contextType: RoleContextType | null;
        contextId: number | null;
      }[] = [];
      for (const a of assignments) {
        const role = byUid.get(a.roleUniqueId);
        if (!role) throw new BadRequestException('errors.role_not_found');
        let contextId: number | null = null;
        if (role.contextType === 'DEPARTMENT') {
          if (!a.contextUniqueId) {
            throw new BadRequestException('errors.role_context_required');
          }
          const dept = await tx.department.findFirst({
            where: { uniqueId: a.contextUniqueId, isActive: true },
          });
          if (!dept)
            throw new BadRequestException('errors.department_not_found');
          contextId = dept.id;
        } else if (role.contextType === 'STORE') {
          if (!a.contextUniqueId) {
            throw new BadRequestException('errors.role_context_required');
          }
          const store = await tx.store.findFirst({
            where: { uniqueId: a.contextUniqueId, isActive: true },
          });
          if (!store) throw new BadRequestException('errors.store_not_found');
          contextId = store.id;
        } else if (a.contextUniqueId) {
          throw new BadRequestException('errors.role_context_not_allowed');
        }
        rows.push({
          roleId: role.id,
          contextType: role.contextType,
          contextId,
        });
      }

      const key = (r: { roleId: number; contextId: number | null }) =>
        `${r.roleId}:${r.contextId ?? ''}`;
      const beforeKeys = new Set(user.roles.map(key));
      const added = rows.filter((r) => !beforeKeys.has(key(r)));
      if (added.length) {
        await this.integrity.assertActorHolds(
          actor,
          roles
            .filter((r) => added.some((a) => a.roleId === r.id))
            .flatMap((r) => r.grants),
        );
      }

      const managersBefore = await this.integrity.countRoleManagers(tx);
      await tx.userRole.deleteMany({ where: { userId: user.id } });
      await tx.userRole.createMany({
        data: rows.map((r) => ({
          ...r,
          userId: user.id,
          assignedById: actor.id,
        })),
        skipDuplicates: true,
      });
      await this.integrity.verifyAfterChange(tx, {
        roleManagersBefore: managersBefore,
        affectedUserIds: [user.id],
      });
      await this.integrity.endSessions(tx, [user.id]);
      await this.audit.log(
        {
          action: 'user.assign_roles',
          entityType: 'User',
          entityId: user.uniqueId,
          before: user.roles.map((r) => ({
            roleId: r.roleId,
            contextType: r.contextType,
            contextId: r.contextId,
          })),
          after: rows,
        },
        tx,
      );
    });
    await this.access.invalidateAll();
  }
}
