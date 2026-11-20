import { Field, InputType } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  IsBoolean,
  IsDate,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { EmployeeStatus, Gender } from '@db';

@InputType()
export class EmployeeFilterInput {
  @IsOptional()
  @IsString()
  @Field(() => String, {
    nullable: true,
    description: 'Name, employee number or email',
  })
  search?: string;

  @IsOptional()
  @IsUUID()
  @Field(() => String, { nullable: true })
  departmentUniqueId?: string;

  @IsOptional()
  @IsEnum(EmployeeStatus, { each: true })
  @Field(() => [EmployeeStatus], { nullable: true })
  statuses?: EmployeeStatus[];

  @IsOptional()
  @IsUUID()
  @Field(() => String, { nullable: true })
  jobTitleUniqueId?: string;

  @IsOptional()
  @IsUUID()
  @Field(() => String, { nullable: true })
  employmentTypeUniqueId?: string;

  @IsOptional()
  @IsBoolean()
  @Field(() => Boolean, { nullable: true })
  hasUser?: boolean;

  @IsOptional()
  @IsBoolean()
  @Field(() => Boolean, { nullable: true })
  isDriver?: boolean;

  @IsOptional()
  @IsDate()
  @Field(() => Date, {
    nullable: true,
    description: 'Contract ending on or before this date',
  })
  contractEndsBefore?: Date;
}

@InputType()
export class CreateEmployeeInput {
  @Matches(/^[A-Za-z0-9/_-]+$/, { message: 'validation.employee_number' })
  @Length(1, 30)
  @Field(() => String)
  employeeNumber: string;

  @Length(1, 80)
  @Field(() => String)
  firstName: string;

  @IsOptional()
  @Length(1, 80)
  @Field(() => String, { nullable: true })
  middleName?: string;

  @Length(1, 80)
  @Field(() => String)
  lastName: string;

  @IsEnum(Gender)
  @Field(() => Gender)
  gender: Gender;

  @IsEmail()
  @Field(() => String)
  companyEmail: string;

  @Matches(/^\+?[0-9 ]{9,16}$/, { message: 'validation.phone' })
  @Field(() => String)
  phone: string;

  @IsUUID()
  @Field(() => String)
  departmentUniqueId: string;

  @IsUUID()
  @Field(() => String)
  jobTitleUniqueId: string;

  @IsUUID()
  @Field(() => String)
  employmentTypeUniqueId: string;

  @IsDate()
  @Field(() => Date)
  startDate: Date;

  @IsOptional()
  @IsDate()
  @Field(() => Date, { nullable: true })
  contractEndDate?: Date;

  @IsOptional()
  @IsUUID()
  @Field(() => String, { nullable: true })
  supervisorUniqueId?: string;

  @IsOptional()
  @Length(1, 120)
  @Field(() => String, { nullable: true })
  workLocation?: string;

  @IsOptional()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Field(() => [String], { nullable: true })
  skills?: string[];

  @IsOptional()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Field(() => [String], { nullable: true })
  qualifications?: string[];

  @IsOptional()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Field(() => [String], { nullable: true })
  professionalRoles?: string[];
}

@InputType()
export class UpdateEmployeeInput {
  @IsUUID()
  @Field(() => String)
  uniqueId: string;

  @IsOptional()
  @Length(1, 80)
  @Field(() => String, { nullable: true })
  firstName?: string;

  @IsOptional()
  @Length(0, 80)
  @Field(() => String, { nullable: true })
  middleName?: string;

  @IsOptional()
  @Length(1, 80)
  @Field(() => String, { nullable: true })
  lastName?: string;

  @IsOptional()
  @IsEnum(Gender)
  @Field(() => Gender, { nullable: true })
  gender?: Gender;

  @IsOptional()
  @IsEmail()
  @Field(() => String, { nullable: true })
  companyEmail?: string;

  @IsOptional()
  @Matches(/^\+?[0-9 ]{9,16}$/, { message: 'validation.phone' })
  @Field(() => String, { nullable: true })
  phone?: string;

  @IsOptional()
  @IsUUID()
  @Field(() => String, { nullable: true })
  departmentUniqueId?: string;

  @IsOptional()
  @IsUUID()
  @Field(() => String, { nullable: true })
  jobTitleUniqueId?: string;

  @IsOptional()
  @IsUUID()
  @Field(() => String, { nullable: true })
  employmentTypeUniqueId?: string;

  @IsOptional()
  @IsDate()
  @Field(() => Date, { nullable: true })
  contractEndDate?: Date;

  @IsOptional()
  @IsBoolean()
  @Field(() => Boolean, { nullable: true })
  clearContractEndDate?: boolean;

  @IsOptional()
  @IsUUID()
  @Field(() => String, { nullable: true })
  supervisorUniqueId?: string;

  @IsOptional()
  @IsBoolean()
  @Field(() => Boolean, { nullable: true })
  clearSupervisor?: boolean;

  @IsOptional()
  @Length(0, 120)
  @Field(() => String, { nullable: true })
  workLocation?: string;

  @IsOptional()
  @IsString({ each: true })
  @Field(() => [String], { nullable: true })
  skills?: string[];

  @IsOptional()
  @IsString({ each: true })
  @Field(() => [String], { nullable: true })
  qualifications?: string[];

  @IsOptional()
  @IsString({ each: true })
  @Field(() => [String], { nullable: true })
  professionalRoles?: string[];

  @IsOptional()
  @IsDate()
  @Field(() => Date, {
    nullable: true,
    description: 'Effective date for tracked changes (default today)',
  })
  effectiveDate?: Date;

  @IsOptional()
  @Length(0, 500)
  @Field(() => String, { nullable: true })
  reason?: string;
}

@InputType()
export class ChangeEmployeeStatusInput {
  @IsUUID()
  @Field(() => String)
  uniqueId: string;

  @IsEnum(EmployeeStatus)
  @Field(() => EmployeeStatus)
  status: EmployeeStatus;

  @IsOptional()
  @IsDate()
  @Field(() => Date, { nullable: true })
  effectiveDate?: Date;

  @Length(3, 500)
  @Field(() => String)
  reason: string;

  @IsOptional()
  @IsDate()
  @Field(() => Date, {
    nullable: true,
    description: 'Rehire only: the new employment start date',
  })
  newStartDate?: Date;
}

@InputType()
export class SetDriverProfileInput {
  @IsUUID()
  @Field(() => String)
  employeeUniqueId: string;

  @Length(3, 40)
  @Field(() => String)
  licenceNumber: string;

  @Length(1, 20)
  @Field(() => String)
  licenceClass: string;

  @IsDate()
  @Field(() => Date)
  licenceExpiry: Date;
}
