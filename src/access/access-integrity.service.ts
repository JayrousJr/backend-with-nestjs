import type { DbTx } from '@prisma';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Scope } from '@db';
import type { CurrentUser } from '@common';
import { PolicyService } from '../policy/policy.service';
import { AccessService } from './access.service';
import { PERMISSION_CATALOGUE } from './catalogue';

/** Modules whose action permissions administrators may not hold. */
const PROCUREMENT_MODULES = new Set(['B1', 'B1T']);
/** Permissions that make a user an "administrator" for SOD_ADMIN_PROCUREMENT. */
const ADMIN_PERMISSIONS = ['role.manage', 'user.assign_role'];
const MIN_ROLE_MANAGERS = 2;

type Tx = DbTx;

/**
 * Protection against privilege escalation (user-employee-spec.md §6.7):
 * grant only what you hold, never to yourself, admins hold no procurement
 * actions, and at least two active users always hold role.manage.
 */
@Injectable()
export class AccessIntegrityService {
  constructor(
    private readonly access: AccessService,
    private readonly policy: PolicyService,
  ) {}

  /** Validate grants against the catalogue (exists, active, allowed scope). */
  async validateGrants(
    tx: Tx,
    grants: { permissionCode: string; scope: Scope }[],
  ): Promise<void> {
    const codes = [...new Set(grants.map((g) => g.permissionCode))];
    const perms = await tx.permission.findMany({
      where: { code: { in: codes }, isActive: true },
    });
    const byCode = new Map(perms.map((p) => [p.code, p]));
    for (const g of grants) {
      const p = byCode.get(g.permissionCode);
      if (!p) {
        throw new BadRequestException({
          message: 'errors.permission_not_found',
          args: { permission: g.permissionCode },
        });
      }
      if (!p.allowedScopes.includes(g.scope)) {
        throw new BadRequestException({
          message: 'errors.scope_not_allowed',
          args: { permission: g.permissionCode, scope: g.scope },
        });
      }
    }
  }

  /** SOD_GRANT_ONLY_HELD: the actor must hold each grant (same scope or ALL). */
  async assertActorHolds(
    actor: CurrentUser,
    grants: { permissionCode: string; scope: Scope }[],
  ): Promise<void> {
    const held = await this.access.getGrants(actor.id);
    const missing = grants.some(
      (g) =>
        !held.some(
          (h) =>
            h.permission === g.permissionCode &&
            !h.onBehalfOfUserId &&
            (h.scope === 'ALL' || h.scope === g.scope),
        ),
    );
    await this.policy.enforceSod('SOD_GRANT_ONLY_HELD', missing);
  }

  /** SOD_ROLE_SELF_GRANT. */
  async assertNotSelf(actor: CurrentUser, affectedUserIds: number[]) {
    await this.policy.enforceSod(
      'SOD_ROLE_SELF_GRANT',
      affectedUserIds.includes(actor.id),
    );
  }

  /** Users who hold a role directly or via a group. */
  async holdersOfRole(tx: Tx, roleId: number): Promise<number[]> {
    const [direct, viaGroups] = await Promise.all([
      tx.userRole.findMany({ where: { roleId }, select: { userId: true } }),
      tx.userGroupMember.findMany({
        where: {
          group: {
            isActive: true,
            isDeleted: false,
            roles: { some: { roleId } },
          },
        },
        select: { userId: true },
      }),
    ]);
    return [...new Set([...direct, ...viaGroups].map((r) => r.userId))];
  }

  /** Users who are members of a group. */
  async membersOfGroup(tx: Tx, groupId: number): Promise<number[]> {
    const rows = await tx.userGroupMember.findMany({
      where: { groupId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  async countRoleManagers(tx: Tx): Promise<number> {
    const users = await tx.user.findMany({
      where: {
        status: 'ACTIVE',
        isDeleted: false,
        OR: [
          {
            roles: {
              some: {
                role: {
                  isActive: true,
                  isDeleted: false,
                  grants: { some: { permissionCode: 'role.manage' } },
                },
              },
            },
          },
          {
            groups: {
              some: {
                group: {
                  isActive: true,
                  isDeleted: false,
                  roles: {
                    some: {
                      role: {
                        isActive: true,
                        isDeleted: false,
                        grants: { some: { permissionCode: 'role.manage' } },
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
    return users.length;
  }

  /**
   * Run after a change inside its transaction. Throws (rolling the change
   * back) if the result breaks the two-role-managers rule or makes an
   * administrator hold procurement actions.
   */
  async verifyAfterChange(
    tx: Tx,
    opts: { roleManagersBefore: number; affectedUserIds: number[] },
  ): Promise<void> {
    const after = await this.countRoleManagers(tx);
    if (after < MIN_ROLE_MANAGERS && after < opts.roleManagersBefore) {
      throw new BadRequestException({
        message: 'errors.min_role_managers',
        args: { min: MIN_ROLE_MANAGERS },
      });
    }

    if (!(await this.policy.isEnabled('SOD_ADMIN_PROCUREMENT'))) return;
    for (const userId of opts.affectedUserIds) {
      const codes = await this.codesInTx(tx, userId);
      const isAdmin = ADMIN_PERMISSIONS.some((p) => codes.has(p));
      // Action permissions only: read access (".view") is not a procurement action.
      const hasProcurement = [...codes].some(
        (c) =>
          !c.endsWith('.view') &&
          PROCUREMENT_MODULES.has(
            (PERMISSION_CATALOGUE as Record<string, { module: string }>)[c]
              ?.module ?? '',
          ),
      );
      await this.policy.enforceSod(
        'SOD_ADMIN_PROCUREMENT',
        isAdmin && hasProcurement,
      );
    }
  }

  private async codesInTx(tx: Tx, userId: number): Promise<Set<string>> {
    const grants = await tx.roleGrant.findMany({
      where: {
        role: {
          isActive: true,
          isDeleted: false,
          OR: [
            { users: { some: { userId } } },
            {
              groupRoles: {
                some: { group: { members: { some: { userId } } } },
              },
            },
          ],
        },
      },
      select: { permissionCode: true },
    });
    return new Set(grants.map((g) => g.permissionCode));
  }

  /** Sessions are ended on role change (spec §7). */
  async endSessions(tx: Tx, userIds: number[]): Promise<void> {
    if (!userIds.length) return;
    await tx.session.updateMany({
      where: { userId: { in: userIds }, isDeleted: false },
      data: { isDeleted: true, deletedAt: new Date() },
    });
  }
}
