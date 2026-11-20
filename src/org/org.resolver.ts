import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthUser } from '@common';
import type { CurrentUser } from '@common';
import { RequirePermission } from '@access';
import { DepartmentsService } from './departments.service';
import { LookupsService } from './lookups.service';
import {
  ActingAssignmentEntity,
  DepartmentEntity,
  DepartmentHeadChangeEntity,
  EmploymentTypeEntity,
  JobTitleEntity,
} from './entities/org.entities';
import {
  CreateActingAssignmentInput,
  CreateDepartmentInput,
  LookupInput,
  SetDepartmentPersonInput,
  UpdateDepartmentInput,
  UpdateLookupInput,
} from './dto/org.inputs';

@Resolver()
export class OrgResolver {
  constructor(
    private readonly departmentsService: DepartmentsService,
    private readonly lookups: LookupsService,
  ) {}

  // ── departments ──────────────────────────────────────────────────────────

  @RequirePermission('department.view')
  @Query(() => [DepartmentEntity])
  departments(
    @Args('includeInactive', { nullable: true }) includeInactive?: boolean,
  ) {
    return this.departmentsService.list(includeInactive ?? false);
  }

  @RequirePermission('department.view')
  @Query(() => DepartmentEntity)
  department(@Args('uniqueId') uniqueId: string) {
    return this.departmentsService.get(uniqueId);
  }

  @RequirePermission('department.view')
  @Query(() => [DepartmentHeadChangeEntity])
  departmentHeadHistory(@Args('uniqueId') uniqueId: string) {
    return this.departmentsService.headHistory(uniqueId);
  }

  @RequirePermission('department.view')
  @Query(() => [ActingAssignmentEntity])
  actingAssignments(@Args('departmentUniqueId') uniqueId: string) {
    return this.departmentsService.actingAssignments(uniqueId);
  }

  @RequirePermission('department.manage')
  @Mutation(() => DepartmentEntity)
  createDepartment(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateDepartmentInput,
  ) {
    return this.departmentsService.create(user, input);
  }

  @RequirePermission('department.manage')
  @Mutation(() => DepartmentEntity)
  updateDepartment(
    @AuthUser() user: CurrentUser,
    @Args('input') input: UpdateDepartmentInput,
  ) {
    return this.departmentsService.update(user, input);
  }

  @RequirePermission('department.manage')
  @Mutation(() => DepartmentEntity)
  setDepartmentHead(
    @AuthUser() user: CurrentUser,
    @Args('input') input: SetDepartmentPersonInput,
  ) {
    return this.departmentsService.setHead(user, input);
  }

  @RequirePermission('department.manage')
  @Mutation(() => DepartmentEntity)
  setDepartmentDeputy(
    @AuthUser() user: CurrentUser,
    @Args('input') input: SetDepartmentPersonInput,
  ) {
    return this.departmentsService.setDeputy(user, input);
  }

  @RequirePermission('department.manage')
  @Mutation(() => DepartmentEntity)
  setDepartmentActive(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('isActive') isActive: boolean,
  ) {
    return this.departmentsService.setActive(user, uniqueId, isActive);
  }

  @RequirePermission('department.manage')
  @Mutation(() => ActingAssignmentEntity)
  createActingAssignment(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateActingAssignmentInput,
  ) {
    return this.departmentsService.createActing(user, input);
  }

  @RequirePermission('department.manage')
  @Mutation(() => ActingAssignmentEntity)
  cancelActingAssignment(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.departmentsService.cancelActing(user, uniqueId);
  }

  // ── job titles & employment types (lists readable by any staff user) ─────

  @Query(() => [JobTitleEntity])
  jobTitles(
    @Args('includeInactive', { nullable: true }) includeInactive?: boolean,
  ) {
    return this.lookups.jobTitles(includeInactive ?? false);
  }

  @RequirePermission('job_title.manage')
  @Mutation(() => JobTitleEntity)
  createJobTitle(
    @AuthUser() user: CurrentUser,
    @Args('input') input: LookupInput,
  ) {
    return this.lookups.createJobTitle(user, input);
  }

  @RequirePermission('job_title.manage')
  @Mutation(() => JobTitleEntity)
  updateJobTitle(
    @AuthUser() user: CurrentUser,
    @Args('input') input: UpdateLookupInput,
  ) {
    return this.lookups.updateJobTitle(user, input);
  }

  @RequirePermission('job_title.manage')
  @Mutation(() => JobTitleEntity)
  setJobTitleActive(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('isActive') isActive: boolean,
  ) {
    return this.lookups.setJobTitleActive(user, uniqueId, isActive);
  }

  @Query(() => [EmploymentTypeEntity])
  employmentTypes(
    @Args('includeInactive', { nullable: true }) includeInactive?: boolean,
  ) {
    return this.lookups.employmentTypes(includeInactive ?? false);
  }

  @RequirePermission('employment_type.manage')
  @Mutation(() => EmploymentTypeEntity)
  createEmploymentType(
    @AuthUser() user: CurrentUser,
    @Args('input') input: LookupInput,
  ) {
    return this.lookups.createEmploymentType(user, input);
  }

  @RequirePermission('employment_type.manage')
  @Mutation(() => EmploymentTypeEntity)
  updateEmploymentType(
    @AuthUser() user: CurrentUser,
    @Args('input') input: UpdateLookupInput,
  ) {
    return this.lookups.updateEmploymentType(user, input);
  }

  @RequirePermission('employment_type.manage')
  @Mutation(() => EmploymentTypeEntity)
  setEmploymentTypeActive(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('isActive') isActive: boolean,
  ) {
    return this.lookups.setEmploymentTypeActive(user, uniqueId, isActive);
  }
}
