export { AccessModule } from './access.module';
export { AccessService } from './access.service';
export type {
  EffectiveGrant,
  ResolvedScope,
  ScopeSubject,
} from './access.service';
export { AccessIntegrityService } from './access-integrity.service';
export { UserRolesService } from './user-roles.service';
export type { RoleAssignment } from './user-roles.service';
export { RequirePermission } from './decorators/require-permission.decorator';
export { PermissionsGuard } from './guards/permissions.guard';
export { PERMISSION_CATALOGUE, ALL_PERMISSION_CODES } from './catalogue';
export type { PermissionCode, PermissionDefinition } from './catalogue';
export { syncPermissionCatalogue } from './permission-sync';
