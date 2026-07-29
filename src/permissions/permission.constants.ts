/**
 * Central registry of permission keys. Each leaf string is persisted as a
 * `Permission.name` row in the database (seeded from ALL_PERMISSIONS below)
 * and referenced via `@RequirePermission(PERMISSIONS.USERS.DELETE)` on
 * resolvers/controllers — giving compile-time-checked references to a
 * DB-driven permission set.
 */
export const PERMISSIONS = {
  USERS: {
    CREATE: 'users.create',
    READ: 'users.read',
    UPDATE: 'users.update',
    DELETE: 'users.delete',
  },
  ROLES: {
    READ: 'roles.read',
    MANAGE: 'roles.manage',
  },
  PERMISSIONS: {
    READ: 'permissions.read',
    MANAGE: 'permissions.manage',
  },
  CAMPAIGNS: {
    READ: 'campaigns.read',
    MANAGE: 'campaigns.manage',
  },
  NEWSLETTER: {
    READ: 'newsletter.read',
  },
  FILES: {
    READ: 'files.read',
    DELETE: 'files.delete',
  },
  ANALYTICS: {
    READ: 'analytics.read',
  },
  CONTENT: {
    READ: 'content.read',
    MANAGE: 'content.manage',
  },
  SEO: {
    MANAGE: 'seo.manage',
  },
} as const;

type PermissionGroups = typeof PERMISSIONS;

export type PermissionAction = {
  [K in keyof PermissionGroups]: PermissionGroups[K][keyof PermissionGroups[K]];
}[keyof PermissionGroups];

export const ALL_PERMISSIONS: PermissionAction[] = Object.values(
  PERMISSIONS,
).flatMap((group) => Object.values(group));

// Role assigned to new accounts on registration.
export const DEFAULT_ROLE_NAME = 'USER';

// Role that bypasses permission checks entirely (see PermissionsGuard).
export const ADMIN_ROLE_NAME = 'ADMIN';
