import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthUser, PaginationInput } from '@common';
import type { CurrentUser } from '@common';
import { RequirePermission } from '@access';
import { EmployeesService } from './employees.service';
import {
  EmployeeEntity,
  EmployeeHistoryEntity,
  EmployeeListResponse,
} from './entities/employee.entity';
import {
  ChangeEmployeeStatusInput,
  CreateEmployeeInput,
  EmployeeFilterInput,
  SetDriverProfileInput,
  UpdateEmployeeInput,
} from './dto/employee.inputs';

@Resolver(() => EmployeeEntity)
export class EmployeesResolver {
  constructor(private readonly service: EmployeesService) {}

  @RequirePermission('employee.view')
  @Query(() => EmployeeListResponse)
  employees(
    @AuthUser() user: CurrentUser,
    @Args('filter', { type: () => EmployeeFilterInput, nullable: true })
    filter?: EmployeeFilterInput,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
  ) {
    return this.service.list(user, filter, pagination);
  }

  @Query(() => EmployeeEntity, {
    description:
      'Scope-checked inside (own record always allowed with own_records)',
  })
  employee(@AuthUser() user: CurrentUser, @Args('uniqueId') uniqueId: string) {
    return this.service.get(user, uniqueId);
  }

  @RequirePermission('employee.view_personal')
  @Query(() => [EmployeeHistoryEntity])
  employeeHistory(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.history(user, uniqueId);
  }

  @RequirePermission('employee.manage')
  @Mutation(() => EmployeeEntity)
  createEmployee(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateEmployeeInput,
  ) {
    return this.service.create(user, input);
  }

  @RequirePermission('employee.manage')
  @Mutation(() => EmployeeEntity)
  updateEmployee(
    @AuthUser() user: CurrentUser,
    @Args('input') input: UpdateEmployeeInput,
  ) {
    return this.service.update(user, input);
  }

  @Mutation(() => EmployeeEntity, {
    description: 'employee.manage, or employee.exit for Exited',
  })
  changeEmployeeStatus(
    @AuthUser() user: CurrentUser,
    @Args('input') input: ChangeEmployeeStatusInput,
  ) {
    return this.service.changeStatus(user, input);
  }

  @RequirePermission('driver_profile.manage')
  @Mutation(() => EmployeeEntity)
  setDriverProfile(
    @AuthUser() user: CurrentUser,
    @Args('input') input: SetDriverProfileInput,
  ) {
    return this.service.setDriverProfile(user, input);
  }

  @RequirePermission('driver_profile.manage')
  @Mutation(() => EmployeeEntity)
  removeDriverProfile(
    @AuthUser() user: CurrentUser,
    @Args('employeeUniqueId') employeeUniqueId: string,
  ) {
    return this.service.removeDriverProfile(user, employeeUniqueId);
  }
}
