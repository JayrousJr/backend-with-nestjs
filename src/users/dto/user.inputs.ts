import { Field, InputType } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserStatus } from '@db';

@InputType()
export class UserFilterInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true, description: 'Name, number or email' })
  search?: string;

  @IsOptional()
  @IsEnum(UserStatus, { each: true })
  @Field(() => [UserStatus], { nullable: true })
  statuses?: UserStatus[];

  @IsOptional()
  @IsUUID()
  @Field(() => String, { nullable: true })
  roleUniqueId?: string;

  @IsOptional()
  @IsUUID()
  @Field(() => String, { nullable: true })
  departmentUniqueId?: string;
}

@InputType()
export class RoleAssignmentInput {
  @IsUUID()
  @Field(() => String)
  roleUniqueId: string;

  @IsOptional()
  @IsUUID()
  @Field(() => String, {
    nullable: true,
    description: 'Store / department uniqueId for context roles',
  })
  contextUniqueId?: string;
}

@InputType()
export class CreateUsersFromEmployeesInput {
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  @Field(() => [String])
  employeeUniqueIds: string[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => RoleAssignmentInput)
  @Field(() => [RoleAssignmentInput], {
    nullable: true,
    description: 'Roles given to every created user',
  })
  roles?: RoleAssignmentInput[];
}

@InputType()
export class SetUserRolesInput {
  @IsUUID()
  @Field(() => String)
  userUniqueId: string;

  @ValidateNested({ each: true })
  @Type(() => RoleAssignmentInput)
  @Field(() => [RoleAssignmentInput])
  roles: RoleAssignmentInput[];
}

@InputType()
export class UpdateMyPreferencesInput {
  @IsIn(['en', 'sw'])
  @Field(() => String)
  preferredLocale: string;
}
