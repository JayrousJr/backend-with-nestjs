import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthUser, PaginationInput } from '@common';
import type { CurrentUser } from '@common';
import { RequirePermission } from './decorators/require-permission.decorator';
import { AccessService } from './access.service';
import { RolesService } from './roles.service';
import { GroupsService } from './groups.service';
import {
  EffectiveGrantEntity,
  PermissionEntity,
  RoleEntity,
  RoleListResponse,
  UserGroupEntity,
} from './entities/access.entities';
import {
  CreateGroupInput,
  CreateRoleInput,
  SetGroupMembersInput,
  SetGroupRolesInput,
  UpdateGroupInput,
  UpdateRoleInput,
} from './dto/role.inputs';

@Resolver()
export class AccessResolver {
  constructor(
    private readonly access: AccessService,
    private readonly rolesService: RolesService,
    private readonly groups: GroupsService,
  ) {}

  // ── own access (every signed-in user) ────────────────────────────────────

  @Query(() => [EffectiveGrantEntity], {
    description: 'Effective grants of the signed-in user (menus/buttons)',
  })
  async myGrants(@AuthUser() user: CurrentUser) {
    const grants = await this.access.getGrants(user.id);
    return grants.map((g) => ({ ...g, delegated: g.onBehalfOfUserId != null }));
  }

  // ── permission catalogue ─────────────────────────────────────────────────

  @RequirePermission('role.view')
  @Query(() => [PermissionEntity])
  permissionCatalogue() {
    return this.rolesService.permissions();
  }

  // ── roles ────────────────────────────────────────────────────────────────

  @RequirePermission('role.view')
  @Query(() => RoleListResponse)
  roles(
    @Args('search', { nullable: true }) search?: string,
    @Args('includeRetired', { nullable: true }) includeRetired?: boolean,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
  ) {
    return this.rolesService.list(search, includeRetired ?? false, pagination);
  }

  @RequirePermission('role.view')
  @Query(() => RoleEntity)
  role(@Args('uniqueId') uniqueId: string) {
    return this.rolesService.get(uniqueId);
  }

  @RequirePermission('role.manage')
  @Mutation(() => RoleEntity)
  createRole(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateRoleInput,
  ) {
    return this.rolesService.create(user, input);
  }

  @RequirePermission('role.manage')
  @Mutation(() => RoleEntity)
  updateRole(
    @AuthUser() user: CurrentUser,
    @Args('input') input: UpdateRoleInput,
  ) {
    return this.rolesService.update(user, input);
  }

  @RequirePermission('role.manage')
  @Mutation(() => RoleEntity)
  copyRole(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('name') name: string,
  ) {
    return this.rolesService.copy(user, uniqueId, name);
  }

  @RequirePermission('role.manage')
  @Mutation(() => RoleEntity, { description: 'Retire or reinstate a role' })
  setRoleActive(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('isActive') isActive: boolean,
  ) {
    return this.rolesService.setActive(user, uniqueId, isActive);
  }

  // ── groups ───────────────────────────────────────────────────────────────

  @RequirePermission('group.manage')
  @Query(() => [UserGroupEntity])
  userGroups(
    @Args('includeInactive', { nullable: true }) includeInactive?: boolean,
  ) {
    return this.groups.list(includeInactive ?? false);
  }

  @RequirePermission('group.manage')
  @Query(() => UserGroupEntity)
  userGroup(@Args('uniqueId') uniqueId: string) {
    return this.groups.get(uniqueId);
  }

  @RequirePermission('group.manage')
  @Mutation(() => UserGroupEntity)
  createUserGroup(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateGroupInput,
  ) {
    return this.groups.create(user, input);
  }

  @RequirePermission('group.manage')
  @Mutation(() => UserGroupEntity)
  updateUserGroup(
    @AuthUser() user: CurrentUser,
    @Args('input') input: UpdateGroupInput,
  ) {
    return this.groups.update(user, input);
  }

  @RequirePermission('group.manage')
  @Mutation(() => UserGroupEntity)
  setUserGroupActive(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('isActive') isActive: boolean,
  ) {
    return this.groups.setActive(user, uniqueId, isActive);
  }

  @RequirePermission('group.manage')
  @Mutation(() => UserGroupEntity)
  setUserGroupMembers(
    @AuthUser() user: CurrentUser,
    @Args('input') input: SetGroupMembersInput,
  ) {
    return this.groups.setMembers(user, input);
  }

  @RequirePermission('group.manage')
  @Mutation(() => UserGroupEntity)
  setUserGroupRoles(
    @AuthUser() user: CurrentUser,
    @Args('input') input: SetGroupRolesInput,
  ) {
    return this.groups.setRoles(user, input);
  }
}
