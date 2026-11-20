import { Field, Float, InputType } from '@nestjs/graphql';
import {
  ArrayUnique,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RoleContextType, Scope } from '@db';

@InputType()
export class RoleGrantInput {
  @IsString()
  @Field(() => String)
  permissionCode: string;

  @IsEnum(Scope)
  @Field(() => Scope)
  scope: Scope;

  @IsOptional()
  @IsNumber()
  @Field(() => Float, { nullable: true })
  valueLimit?: number;
}

@InputType()
export class CreateRoleInput {
  @Length(2, 80)
  @Field(() => String)
  name: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  description?: string;

  @IsOptional()
  @IsEnum(RoleContextType)
  @Field(() => RoleContextType, { nullable: true })
  contextType?: RoleContextType;

  @ValidateNested({ each: true })
  @Type(() => RoleGrantInput)
  @Field(() => [RoleGrantInput])
  grants: RoleGrantInput[];
}

@InputType()
export class UpdateRoleInput {
  @IsUUID()
  @Field(() => String)
  uniqueId: string;

  @IsOptional()
  @Length(2, 80)
  @Field(() => String, { nullable: true })
  name?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  description?: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => RoleGrantInput)
  @Field(() => [RoleGrantInput], {
    nullable: true,
    description: 'Replaces the full grant set when given',
  })
  grants?: RoleGrantInput[];
}

@InputType()
export class CreateGroupInput {
  @Length(2, 60)
  @Field(() => String)
  code: string;

  @Length(2, 120)
  @Field(() => String)
  name: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  description?: string;
}

@InputType()
export class UpdateGroupInput {
  @IsUUID()
  @Field(() => String)
  uniqueId: string;

  @IsOptional()
  @Length(2, 120)
  @Field(() => String, { nullable: true })
  name?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  description?: string;
}

@InputType()
export class SetGroupMembersInput {
  @IsUUID()
  @Field(() => String)
  groupUniqueId: string;

  @ArrayUnique()
  @IsUUID('all', { each: true })
  @Field(() => [String], { description: 'User uniqueIds' })
  userUniqueIds: string[];
}

@InputType()
export class SetGroupRolesInput {
  @IsUUID()
  @Field(() => String)
  groupUniqueId: string;

  @ArrayUnique()
  @IsUUID('all', { each: true })
  @Field(() => [String], { description: 'Role uniqueIds' })
  roleUniqueIds: string[];
}
