import { SetMetadata } from '@nestjs/common';
import type { PermissionCode } from '../catalogue';

export const PERMISSION_KEY = 'access:permission';

/**
 * Gate a resolver/controller behind a permission. The guard only checks
 * that the user holds the permission with *some* scope; services then
 * match the scope against the record via AccessService.assert/scopeWhere.
 * There is deliberately no role-name bypass.
 */
export const RequirePermission = (permission: PermissionCode) =>
  SetMetadata(PERMISSION_KEY, permission);
