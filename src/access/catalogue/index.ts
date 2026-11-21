import { A1_PERMISSIONS, SHARED_PERMISSIONS } from './a1.permissions';
import { B1_PERMISSIONS } from './b1.permissions';
import { B1T_PERMISSIONS } from './b1t.permissions';
import { B2_PERMISSIONS } from './b2.permissions';
import { B3_PERMISSIONS } from './b3.permissions';
import type { PermissionDefinition } from './types';

/**
 * The permission catalogue. Each module registers its permissions in code;
 * PermissionSyncService upserts them at boot. Add a module's definitions
 * here when the module is built (B1, B2, B3, production…).
 */
export const PERMISSION_CATALOGUE = {
  ...A1_PERMISSIONS,
  ...SHARED_PERMISSIONS,
  ...B1_PERMISSIONS,
  ...B1T_PERMISSIONS,
  ...B2_PERMISSIONS,
  ...B3_PERMISSIONS,
} satisfies Record<string, PermissionDefinition>;

export type PermissionCode = keyof typeof PERMISSION_CATALOGUE;

export const ALL_PERMISSION_CODES = Object.keys(
  PERMISSION_CATALOGUE,
) as PermissionCode[];

export type { PermissionDefinition } from './types';
