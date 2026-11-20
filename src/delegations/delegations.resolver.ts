import {
  Args,
  Field,
  InputType,
  Mutation,
  ObjectType,
  Query,
  registerEnumType,
  Resolver,
} from '@nestjs/graphql';
import {
  ArrayMaxSize,
  IsDate,
  IsOptional,
  IsUUID,
  Length,
} from 'class-validator';
import { DelegationStatus } from '@db';
import { AuthUser, PaginationInput, QueryListResponse } from '@common';
import type { CurrentUser } from '@common';
import { DelegationsService } from './delegations.service';

registerEnumType(DelegationStatus, { name: 'DelegationStatus' });

@ObjectType('DelegationUser')
class DelegationUserEntity {
  @Field() uniqueId: string;
  @Field() email: string;
  @Field() fullName: string;
  @Field() departmentName: string;
}

@ObjectType('DelegationRole')
class DelegationRoleEntity {
  @Field() uniqueId: string;
  @Field() name: string;
}

@ObjectType('Delegation')
export class DelegationEntity {
  @Field() uniqueId: string;
  @Field(() => DelegationUserEntity) from: DelegationUserEntity;
  @Field(() => DelegationUserEntity) to: DelegationUserEntity;
  @Field(() => DelegationUserEntity, { nullable: true })
  approvedBy?: DelegationUserEntity | null;
  @Field(() => [DelegationRoleEntity]) roles: DelegationRoleEntity[];
  @Field() allRoles: boolean;
  @Field() start: Date;
  @Field() end: Date;
  @Field() reason: string;
  @Field(() => DelegationStatus) status: DelegationStatus;
  @Field() inForce: boolean;
  @Field(() => Date, { nullable: true }) decidedAt?: Date | null;
  @Field() createdAt: Date;
}

@ObjectType()
class DelegationListResponse extends QueryListResponse(DelegationEntity) {}

@InputType()
class CreateDelegationInput {
  @IsOptional()
  @IsUUID()
  @Field(() => String, {
    nullable: true,
    description: 'Delegator (defaults to yourself; others need scope ALL)',
  })
  fromUserUniqueId?: string;

  @IsUUID()
  @Field()
  toUserUniqueId: string;

  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  @Field(() => [String], { description: 'Empty = all roles' })
  roleUniqueIds: string[];

  @IsDate() @Field() start: Date;
  @IsDate() @Field() end: Date;

  @Length(3, 500)
  @Field()
  reason: string;
}

@Resolver(() => DelegationEntity)
export class DelegationsResolver {
  constructor(private readonly service: DelegationsService) {}

  @Query(() => DelegationListResponse, {
    description:
      'scope: mine | pending | all (pending/all need delegation.approve)',
  })
  delegations(
    @AuthUser() user: CurrentUser,
    @Args('scope', { defaultValue: 'mine' }) scope: string,
    @Args('status', { type: () => DelegationStatus, nullable: true })
    status?: DelegationStatus,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
  ) {
    const s = (['mine', 'pending', 'all'] as const).find((x) => x === scope);
    return this.service.list(user, s ?? 'mine', status, pagination);
  }

  @Mutation(() => DelegationEntity)
  createDelegation(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateDelegationInput,
  ) {
    return this.service.create(user, input);
  }

  @Mutation(() => DelegationEntity)
  decideDelegation(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('approve') approve: boolean,
  ) {
    return this.service.decide(user, uniqueId, approve);
  }

  @Mutation(() => DelegationEntity)
  cancelDelegation(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.cancel(user, uniqueId);
  }
}
