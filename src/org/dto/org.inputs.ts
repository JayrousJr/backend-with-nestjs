import { Field, InputType } from '@nestjs/graphql';
import {
  IsBoolean,
  IsDate,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';

const CODE = /^[A-Z0-9_-]+$/;

@InputType()
export class CreateDepartmentInput {
  @Matches(CODE, { message: 'validation.code_format' })
  @Length(2, 20)
  @Field(() => String)
  code: string;

  @Length(2, 120)
  @Field(() => String)
  name: string;

  @IsOptional()
  @IsUUID()
  @Field(() => String, { nullable: true, description: 'Parent department' })
  parentUniqueId?: string;
}

@InputType()
export class UpdateDepartmentInput {
  @IsUUID()
  @Field(() => String)
  uniqueId: string;

  @IsOptional()
  @Length(2, 120)
  @Field(() => String, { nullable: true })
  name?: string;

  @IsOptional()
  @IsUUID()
  @Field(() => String, {
    nullable: true,
    description: 'Parent department; empty string clears it',
  })
  parentUniqueId?: string;

  @IsOptional()
  @IsBoolean()
  @Field(() => Boolean, { nullable: true })
  clearParent?: boolean;
}

@InputType()
export class SetDepartmentPersonInput {
  @IsUUID()
  @Field(() => String)
  departmentUniqueId: string;

  @IsOptional()
  @IsUUID()
  @Field(() => String, { nullable: true, description: 'Null clears it' })
  employeeUniqueId?: string | null;
}

@InputType()
export class CreateActingAssignmentInput {
  @IsUUID()
  @Field(() => String)
  departmentUniqueId: string;

  @IsUUID()
  @Field(() => String)
  employeeUniqueId: string;

  @IsDate()
  @Field(() => Date)
  from: Date;

  @IsDate()
  @Field(() => Date)
  to: Date;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  reason?: string;
}

@InputType()
export class LookupInput {
  @Matches(CODE, { message: 'validation.code_format' })
  @Length(2, 30)
  @Field(() => String)
  code: string;

  @Length(2, 120)
  @Field(() => String)
  name: string;

  @IsOptional()
  @IsBoolean()
  @Field(() => Boolean, {
    nullable: true,
    description: 'Employment types only',
  })
  requiresEndDate?: boolean;
}

@InputType()
export class UpdateLookupInput {
  @IsUUID()
  @Field(() => String)
  uniqueId: string;

  @IsOptional()
  @Length(2, 120)
  @Field(() => String, { nullable: true })
  name?: string;

  @IsOptional()
  @IsBoolean()
  @Field(() => Boolean, { nullable: true })
  requiresEndDate?: boolean;
}
