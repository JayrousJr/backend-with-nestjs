import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { RoleContextType, Scope } from '@db';
import { PrismaService } from '@prisma';
import { RequestContext } from '@common';
import type { CurrentUser } from '@common';
import type { PermissionCode } from './catalogue';

const CACHE_TTL_MS = 60_000;
const VERSION_KEY = 'access:grants:version';

/** Sensitive permissions whose denials are logged. */
const SENSITIVE_PREFIXES = ['role.', 'user.', 'policy.', 'workflow.', 'audit.'];

export interface EffectiveGrant {
  permission: string;
  scope: Scope;
  contextType: RoleContextType | null;
  contextId: number | null;
  valueLimit: number | null;
  roleId: number;
  /** Set when the grant comes from a delegation ("by X on behalf of Y"). */
  onBehalfOfUserId: number | null;
}

/**
 * Describes the record an action targets, so scopes can be matched.
 * Only fill what the record has; missing facts never match a scope.
 */
export interface ScopeSubject {
  /** Department the record belongs to. */
  departmentId?: number | null;
  /** Users who created / own the record. */
  ownerUserIds?: (number | null | undefined)[];
  /** Employee the record is about (e.g. the employee's own profile). */
  subjectEmployeeId?: number | null;
  /** Users assigned to the record (committee, inspector, approval task). */
  assignedUserIds?: number[];
  storeId?: number | null;
  productionId?: number | null;
}

/**
 * What a user may see for one permission, used to build list filters in
 * the database query (lists are filtered by scope, never in memory).
 */
export interface ResolvedScope {
  all: boolean;
  departmentIds: number[];
  ownRecords: boolean;
  assigned: boolean;
  storeIds: number[];
  assignedProduction: boolean;
}

@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // ── grant resolution ─────────────────────────────────────────────────────

  /** Own roles + roles of the user's groups + roles delegated to the user. */
  async getGrants(userId: number): Promise<EffectiveGrant[]> {
    const version = await this.version();
    const key = `access:grants:v${version}:user:${userId}`;
    const cached = await this.cache.get<EffectiveGrant[]>(key);
    if (cached) return cached;

    const grants = await this.loadGrants(userId);
    await this.cache.set(key, grants, CACHE_TTL_MS);
    return grants;
  }

  private async loadGrants(userId: number): Promise<EffectiveGrant[]> {
    const db = this.prisma.db;
    const now = new Date();

    const [userRoles, groupRoles, delegations] = await Promise.all([
      db.userRole.findMany({
        where: { userId, role: { isActive: true, isDeleted: false } },
        include: { role: { include: { grants: true } } },
      }),
      db.groupRole.findMany({
        where: {
          role: { isActive: true, isDeleted: false },
          group: {
            isActive: true,
            isDeleted: false,
            members: { some: { userId } },
          },
        },
        include: { role: { include: { grants: true } } },
      }),
      db.delegation.findMany({
        where: {
          toUserId: userId,
          status: 'APPROVED',
          start: { lte: now },
          end: { gte: now },
        },
      }),
    ]);

    const out: EffectiveGrant[] = [];
    const push = (
      role: {
        id: number;
        grants: {
          permissionCode: string;
          scope: Scope;
          valueLimit: unknown;
        }[];
      },
      contextType: RoleContextType | null,
      contextId: number | null,
      onBehalfOfUserId: number | null,
    ) => {
      for (const g of role.grants) {
        out.push({
          permission: g.permissionCode,
          scope: g.scope,
          contextType,
          contextId,
          valueLimit: g.valueLimit == null ? null : Number(g.valueLimit),
          roleId: role.id,
          onBehalfOfUserId,
        });
      }
    };

    for (const ur of userRoles) {
      push(ur.role, ur.contextType, ur.contextId, null);
    }
    for (const gr of groupRoles) {
      push(gr.role, null, null, null);
    }

    for (const d of delegations) {
      // Delegations are cancelled when either user is deactivated; double
      // check the delegator is still active before honouring it.
      const delegated = await db.userRole.findMany({
        where: {
          userId: d.fromUserId,
          user: { status: 'ACTIVE' },
          role: { isActive: true, isDeleted: false },
          ...(d.roleIds.length ? { roleId: { in: d.roleIds } } : {}),
        },
        include: { role: { include: { grants: true } } },
      });
      for (const ur of delegated) {
        push(ur.role, ur.contextType, ur.contextId, d.fromUserId);
      }
    }

    return out;
  }

  /** Grant changes apply on the next request: bump the cache version. */
  async invalidateAll(): Promise<void> {
    const version = await this.version();
    await this.cache.set(VERSION_KEY, version + 1, 0);
  }

  private async version(): Promise<number> {
    return (await this.cache.get<number>(VERSION_KEY)) ?? 1;
  }

  /** Active users holding a permission through their roles or groups (for notifications). */
  async usersWithPermission(permission: PermissionCode): Promise<number[]> {
    const users = await this.prisma.dbRaw.user.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          {
            roles: {
              some: {
                role: {
                  isActive: true,
                  isDeleted: false,
                  grants: { some: { permissionCode: permission } },
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
                        isDeleted: false,
                        grants: { some: { permissionCode: permission } },
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
    return users.map((u) => u.id);
  }

  /** Distinct permission codes the user holds with any scope. */
  async getPermissionCodes(userId: number): Promise<string[]> {
    const grants = await this.getGrants(userId);
    return [...new Set(grants.map((g) => g.permission))];
  }

  // ── checks ───────────────────────────────────────────────────────────────

  /** True when the user holds the permission with any scope. */
  async hasAny(
    user: CurrentUser,
    permission: PermissionCode,
  ): Promise<boolean> {
    const grants = (await this.getGrants(user.id)).filter(
      (g) => g.permission === permission,
    );
    this.noteDelegation(grants);
    return grants.length > 0;
  }

  /**
   * "By X on behalf of Y": when only delegated grants allow the action, the
   * delegator is put in the request context and the audit log records it.
   */
  /** The delegator when the permission is held only through a delegation. */
  async delegatorFor(
    user: CurrentUser,
    permission: PermissionCode,
  ): Promise<number | undefined> {
    const grants = (await this.getGrants(user.id)).filter(
      (g) => g.permission === permission,
    );
    if (!grants.length || grants.some((g) => g.onBehalfOfUserId == null)) {
      return undefined;
    }
    return grants[0].onBehalfOfUserId!;
  }

  private noteDelegation(matched: EffectiveGrant[]) {
    if (!matched.length || matched.some((g) => g.onBehalfOfUserId == null)) {
      return;
    }
    RequestContext.setOnBehalfOf(matched[0].onBehalfOfUserId!);
  }

  /**
   * can(user, permission, record): a grant for the permission whose scope
   * matches the record. Without a record, any grant counts (used for
   * "may open this screen at all"; the list itself is scope-filtered).
   * SoD rules are enforced by the calling service via SodService.
   */
  async can(
    user: CurrentUser,
    permission: PermissionCode,
    subject?: ScopeSubject,
  ): Promise<boolean> {
    const grants = (await this.getGrants(user.id)).filter(
      (g) => g.permission === permission,
    );
    if (!subject) return grants.length > 0;

    const deptIds = await this.ownDepartmentIds(user);
    const matched = grants.filter((g) =>
      this.matches(g, user, subject, deptIds),
    );
    this.noteDelegation(matched);
    return matched.length > 0;
  }

  async assert(
    user: CurrentUser,
    permission: PermissionCode,
    subject?: ScopeSubject,
  ): Promise<void> {
    if (await this.can(user, permission, subject)) return;
    if (SENSITIVE_PREFIXES.some((p) => permission.startsWith(p))) {
      this.logger.warn(
        `Denied ${permission} for user #${user.id}${subject ? ` on ${JSON.stringify(subject)}` : ''}`,
      );
    }
    throw new ForbiddenException('errors.forbidden');
  }

  /** Resolve the user's scopes for one permission (for list queries). */
  async resolveScope(
    user: CurrentUser,
    permission: PermissionCode,
  ): Promise<ResolvedScope> {
    const grants = (await this.getGrants(user.id)).filter(
      (g) => g.permission === permission,
    );
    const resolved: ResolvedScope = {
      all: false,
      departmentIds: [],
      ownRecords: false,
      assigned: false,
      storeIds: [],
      assignedProduction: false,
    };
    for (const g of grants) {
      switch (g.scope) {
        case 'ALL':
          resolved.all = true;
          break;
        case 'OWN_DEPARTMENT':
          resolved.departmentIds.push(...(await this.ownDepartmentIds(user)));
          break;
        case 'OWN_RECORDS':
          resolved.ownRecords = true;
          break;
        case 'ASSIGNED':
          resolved.assigned = true;
          break;
        case 'ASSIGNED_STORE':
          if (g.contextType === 'STORE' && g.contextId != null) {
            resolved.storeIds.push(g.contextId);
          }
          break;
        case 'ASSIGNED_PRODUCTION':
          resolved.assignedProduction = true;
          break;
        case 'OWN_VENDOR':
          // Vendor portal only — never applies to staff users.
          break;
      }
    }
    resolved.departmentIds = [...new Set(resolved.departmentIds)];
    resolved.storeIds = [...new Set(resolved.storeIds)];
    return resolved;
  }

  /**
   * Turn a ResolvedScope into a Prisma `where` fragment. Pass one builder
   * per scope the model supports; scopes without a builder grant nothing.
   * Returns `{}` for ALL and throws Forbidden when nothing applies.
   */
  async scopeWhere<W extends object>(
    user: CurrentUser,
    permission: PermissionCode,
    builders: {
      department?: (departmentIds: number[]) => W;
      ownRecords?: (user: CurrentUser) => W;
      assigned?: (user: CurrentUser) => W;
      store?: (storeIds: number[]) => W;
      production?: (user: CurrentUser) => W;
    },
  ): Promise<W | { OR: W[] } | Record<string, never>> {
    const scope = await this.resolveScope(user, permission);
    if (scope.all) return {};

    const or: W[] = [];
    if (scope.departmentIds.length && builders.department) {
      or.push(builders.department(scope.departmentIds));
    }
    if (scope.ownRecords && builders.ownRecords) {
      or.push(builders.ownRecords(user));
    }
    if (scope.assigned && builders.assigned) {
      or.push(builders.assigned(user));
    }
    if (scope.storeIds.length && builders.store) {
      or.push(builders.store(scope.storeIds));
    }
    if (scope.assignedProduction && builders.production) {
      or.push(builders.production(user));
    }
    if (!or.length) throw new ForbiddenException('errors.forbidden');
    return { OR: or };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private matches(
    g: EffectiveGrant,
    user: CurrentUser,
    s: ScopeSubject,
    ownDeptIds: number[],
  ): boolean {
    switch (g.scope) {
      case 'ALL':
        return true;
      case 'OWN_DEPARTMENT':
        return s.departmentId != null && ownDeptIds.includes(s.departmentId);
      case 'OWN_RECORDS':
        return (
          (s.ownerUserIds ?? []).includes(user.id) ||
          (s.subjectEmployeeId != null &&
            s.subjectEmployeeId === user.employeeId)
        );
      case 'ASSIGNED':
        return (s.assignedUserIds ?? []).includes(user.id);
      case 'ASSIGNED_STORE':
        return (
          g.contextType === 'STORE' &&
          s.storeId != null &&
          g.contextId === s.storeId
        );
      case 'ASSIGNED_PRODUCTION':
        // Resolved by the production module (producer or crew) through
        // assignedUserIds until that module exists.
        return (
          s.productionId != null && (s.assignedUserIds ?? []).includes(user.id)
        );
      default:
        return false;
    }
  }

  /** The user's department plus its sections (two-level hierarchy). */
  async ownDepartmentIds(user: CurrentUser): Promise<number[]> {
    const key = `access:dept-tree:${user.departmentId}`;
    const cached = await this.cache.get<number[]>(key);
    if (cached) return cached;
    const children = await this.prisma.db.department.findMany({
      where: { parentId: user.departmentId },
      select: { id: true },
    });
    const ids = [user.departmentId, ...children.map((c) => c.id)];
    await this.cache.set(key, ids, CACHE_TTL_MS);
    return ids;
  }
}
