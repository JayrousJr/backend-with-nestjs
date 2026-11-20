import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthUser, PaginationInput } from '@common';
import type { CurrentUser } from '@common';
import { RequirePermission } from '@access';
import { UsersService } from './users.service';
import {
  CreateUsersResultEntity,
  LoginEventEntity,
  LoginEventListResponse,
  MeEntity,
  UserEntity,
  UserListResponse,
} from './entities/user.entity';
import {
  CreateUsersFromEmployeesInput,
  SetUserRolesInput,
  UpdateMyPreferencesInput,
  UserFilterInput,
} from './dto/user.inputs';

@Resolver(() => UserEntity)
export class UsersResolver {
  constructor(private readonly service: UsersService) {}

  // ── self ─────────────────────────────────────────────────────────────────

  @Query(() => MeEntity)
  me(@AuthUser() user: CurrentUser) {
    return this.service.me(user);
  }

  @Mutation(() => MeEntity)
  updateMyPreferences(
    @AuthUser() user: CurrentUser,
    @Args('input') input: UpdateMyPreferencesInput,
  ) {
    return this.service.updatePreferences(user, input.preferredLocale);
  }

  @Query(() => [LoginEventEntity])
  myLoginEvents(@AuthUser() user: CurrentUser) {
    return this.service.myLoginEvents(user);
  }

  // ── administration ───────────────────────────────────────────────────────

  @RequirePermission('user.view')
  @Query(() => UserListResponse)
  users(
    @Args('filter', { type: () => UserFilterInput, nullable: true })
    filter?: UserFilterInput,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
  ) {
    return this.service.list(filter, pagination);
  }

  @RequirePermission('user.view')
  @Query(() => UserEntity)
  user(@Args('uniqueId') uniqueId: string) {
    return this.service.get(uniqueId);
  }

  @RequirePermission('user.manage')
  @Mutation(() => CreateUsersResultEntity)
  createUsersFromEmployees(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateUsersFromEmployeesInput,
  ) {
    return this.service.createFromEmployees(user, input);
  }

  @RequirePermission('user.manage')
  @Mutation(() => UserEntity)
  resendActivation(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.resendActivation(user, uniqueId);
  }

  @RequirePermission('user.manage')
  @Mutation(() => UserEntity)
  deactivateUser(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.deactivate(user, uniqueId);
  }

  @RequirePermission('user.manage')
  @Mutation(() => UserEntity)
  reactivateUser(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.reactivate(user, uniqueId);
  }

  @RequirePermission('user.manage')
  @Mutation(() => UserEntity)
  unlockUser(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.unlock(user, uniqueId);
  }

  @RequirePermission('user.reset_password')
  @Mutation(() => Boolean)
  sendPasswordReset(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.sendPasswordReset(user, uniqueId);
  }

  @RequirePermission('user.assign_role')
  @Mutation(() => UserEntity)
  setUserRoles(
    @AuthUser() user: CurrentUser,
    @Args('input') input: SetUserRolesInput,
  ) {
    return this.service.setRoles(user, input.userUniqueId, input.roles);
  }

  @RequirePermission('security.view_logins')
  @Query(() => LoginEventListResponse)
  loginEvents(
    @Args('userUniqueId', { nullable: true }) userUniqueId?: string,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
  ) {
    return this.service.loginEvents(userUniqueId, pagination);
  }
}
