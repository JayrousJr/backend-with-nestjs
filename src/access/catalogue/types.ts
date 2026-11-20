import type { Scope } from '@db';

export interface PermissionDefinition {
  /** Module code used to group permissions in the role builder (A1, B1…). */
  module: string;
  description: string;
  /** Scopes an administrator may grant this permission with. */
  scopes: readonly Scope[];
}

/**
 * Helper that keeps the literal permission codes as keys so
 * `PermissionCode` is a compile-time-checked union.
 */
export function definePermissions<
  const T extends Record<string, Omit<PermissionDefinition, 'module'>>,
>(module: string, defs: T): { [K in keyof T]: PermissionDefinition } {
  const out = {} as { [K in keyof T]: PermissionDefinition };
  for (const code of Object.keys(defs) as (keyof T)[]) {
    out[code] = { module, ...defs[code] };
  }
  return out;
}
