import { Field, ObjectType } from '@nestjs/graphql';
import { RoleContextType, UserStatus } from '@db';
import { BaseEntity, QueryListResponse } from '@common';
import {
  DepartmentRefEntity,
  EmployeeRefEntity,
} from '../../org/entities/org.entities';
import { EffectiveGrantEntity } from '../../access/entities/access.entities';
import '../../employees/entities/employee.entity'; // registers UserStatus enum

@ObjectType('UserRoleAssignment')
export class UserRoleAssignmentEntity {
  @Field(() => String)
  roleUniqueId: string;

  @Field(() => String)
  roleName: string;

  @Field(() => RoleContextType, { nullable: true })
  contextType?: RoleContextType | null;

  @Field(() => String, { nullable: true })
  contextUniqueId?: string | null;

  @Field(() => String, { nullable: true })
  contextName?: string | null;
}

@ObjectType('UserGroupRef')
export class UserGroupRefEntity {
  @Field(() => String)
  uniqueId: string;

  @Field(() => String)
  code: string;

  @Field(() => String)
  name: string;
}

@ObjectType('User')
export class UserEntity extends BaseEntity {
  @Field(() => String)
  email: string;

  @Field(() => UserStatus)
  status: UserStatus;

  @Field(() => Boolean)
  twoFactorEnabled: boolean;

  @Field(() => Date, { nullable: true })
  lastLoginAt?: Date | null;

  @Field(() => Date, { nullable: true })
  lockedUntil?: Date | null;

  @Field(() => String)
  preferredLocale: string;

  @Field(() => EmployeeRefEntity)
  employee: EmployeeRefEntity;

  @Field(() => DepartmentRefEntity)
  department: DepartmentRefEntity;

  @Field(() => String)
  jobTitle: string;

  @Field(() => [UserRoleAssignmentEntity])
  roles: UserRoleAssignmentEntity[];

  @Field(() => [UserGroupRefEntity])
  groups: UserGroupRefEntity[];

  @Field(() => String, {
    nullable: true,
    description: 'Status of the user.creation approval, if one was needed',
  })
  creationApprovalStatus?: string | null;

  @Field(() => String, { nullable: true })
  creationApprovalUniqueId?: string | null;
}

@ObjectType()
export class UserListResponse extends QueryListResponse(UserEntity) {}

@ObjectType('Me')
export class MeEntity extends UserEntity {
  @Field(() => [String], {
    description: 'Distinct permission codes held (any scope)',
  })
  permissions: string[];

  @Field(() => [EffectiveGrantEntity])
  grants: EffectiveGrantEntity[];

  @Field(() => String, { nullable: true })
  employeeStatus?: string | null;
}

@ObjectType('LoginEvent')
export class LoginEventEntity {
  @Field(() => String)
  email: string;

  @Field(() => String)
  type: string;

  @Field(() => Boolean)
  success: boolean;

  @Field(() => String, { nullable: true })
  reason?: string | null;

  @Field(() => String, { nullable: true })
  ipAddress?: string | null;

  @Field(() => String, { nullable: true })
  userAgent?: string | null;

  @Field(() => Date)
  createdAt: Date;
}

@ObjectType()
export class LoginEventListResponse extends QueryListResponse(
  LoginEventEntity,
) {}

@ObjectType('CreateUsersResult')
export class CreateUsersResultEntity {
  @Field(() => [UserEntity])
  created: UserEntity[];

  @Field(() => [String], {
    description: 'Employee uniqueIds skipped (not Active, already a user…)',
  })
  skipped: string[];
}
