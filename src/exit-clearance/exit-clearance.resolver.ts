import {
  Args,
  Field,
  Mutation,
  ObjectType,
  Query,
  registerEnumType,
  Resolver,
} from '@nestjs/graphql';
import { ClearanceItemType, ClearanceStatus } from '@db';
import { AuthUser } from '@common';
import type { CurrentUser } from '@common';
import {
  ExitClearanceService,
  type ItemAction,
} from './exit-clearance.service';

registerEnumType(ClearanceStatus, { name: 'ClearanceStatus' });
registerEnumType(ClearanceItemType, { name: 'ClearanceItemType' });

@ObjectType('ClearanceEmployee')
class ClearanceEmployee {
  @Field() uniqueId: string;
  @Field() employeeNumber: string;
  @Field() fullName: string;
  @Field() companyEmail: string;
  @Field() departmentName: string;
  @Field() jobTitle: string;
}

@ObjectType('ClearanceItem')
class ClearanceItem {
  @Field() uniqueId: string;
  @Field(() => ClearanceItemType) type: ClearanceItemType;
  @Field(() => String, { nullable: true }) reference?: string | null;
  @Field() description: string;
  @Field() resolved: boolean;
  @Field(() => String, { nullable: true }) resolution?: string | null;
  @Field(() => String, { nullable: true }) resolvedBy?: string | null;
  @Field(() => Date, { nullable: true }) resolvedAt?: Date | null;
}

@ObjectType('ExitClearance')
export class ExitClearanceEntity {
  @Field() uniqueId: string;
  @Field(() => ClearanceStatus) status: ClearanceStatus;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) completedAt?: Date | null;
  @Field(() => String, { nullable: true }) signedOffBy?: string | null;
  @Field(() => String, { nullable: true }) approvalRequestUniqueId?:
    string | null;
  @Field(() => ClearanceEmployee) employee: ClearanceEmployee;
  @Field(() => [ClearanceItem]) items: ClearanceItem[];
  @Field() openItems: number;
}

const ACTIONS: ItemAction[] = ['REASSIGN', 'CANCEL_REQUEST', 'RESOLVE'];

@Resolver(() => ExitClearanceEntity)
export class ExitClearanceResolver {
  constructor(private readonly service: ExitClearanceService) {}

  @Query(() => [ExitClearanceEntity])
  exitClearances(
    @AuthUser() user: CurrentUser,
    @Args('status', { type: () => ClearanceStatus, nullable: true })
    status?: ClearanceStatus,
  ) {
    return this.service.list(user, status);
  }

  @Query(() => ExitClearanceEntity)
  exitClearance(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.get(user, uniqueId);
  }

  @Query(() => ExitClearanceEntity, { nullable: true })
  employeeExitClearance(
    @AuthUser() user: CurrentUser,
    @Args('employeeUniqueId') employeeUniqueId: string,
  ) {
    return this.service.forEmployee(user, employeeUniqueId);
  }

  @Mutation(() => ExitClearanceEntity)
  startExitClearance(
    @AuthUser() user: CurrentUser,
    @Args('employeeUniqueId') employeeUniqueId: string,
  ) {
    return this.service.start(user, employeeUniqueId);
  }

  @Mutation(() => ExitClearanceEntity, {
    description: 'action: REASSIGN | CANCEL_REQUEST | RESOLVE (note required)',
  })
  resolveExitClearanceItem(
    @AuthUser() user: CurrentUser,
    @Args('itemUniqueId') itemUniqueId: string,
    @Args('action') action: string,
    @Args('note', { nullable: true }) note?: string,
  ) {
    const a = ACTIONS.find((x) => x === action);
    return this.service.resolveItem(user, itemUniqueId, a ?? 'RESOLVE', note);
  }

  @Mutation(() => ExitClearanceEntity)
  submitExitClearance(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.submit(user, uniqueId);
  }
}
