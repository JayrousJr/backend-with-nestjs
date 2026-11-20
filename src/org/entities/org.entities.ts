import { Field, Int, ObjectType } from '@nestjs/graphql';
import { BaseEntity } from '@common';

@ObjectType('EmployeeRef')
export class EmployeeRefEntity {
  @Field(() => String)
  uniqueId: string;

  @Field(() => String)
  employeeNumber: string;

  @Field(() => String)
  fullName: string;

  @Field(() => String)
  companyEmail: string;
}

@ObjectType('DepartmentRef')
export class DepartmentRefEntity {
  @Field(() => String)
  uniqueId: string;

  @Field(() => String)
  code: string;

  @Field(() => String)
  name: string;
}

@ObjectType('ActingAssignment')
export class ActingAssignmentEntity {
  @Field(() => String)
  uniqueId: string;

  @Field(() => EmployeeRefEntity)
  employee: EmployeeRefEntity;

  @Field(() => Date)
  from: Date;

  @Field(() => Date)
  to: Date;

  @Field(() => String, { nullable: true })
  reason?: string | null;

  @Field(() => Boolean)
  isActive: boolean;
}

@ObjectType('DepartmentHeadChange')
export class DepartmentHeadChangeEntity {
  @Field(() => EmployeeRefEntity, { nullable: true })
  employee?: EmployeeRefEntity | null;

  @Field(() => Date)
  from: Date;

  @Field(() => Date, { nullable: true })
  to?: Date | null;
}

@ObjectType('Department')
export class DepartmentEntity extends BaseEntity {
  @Field(() => String)
  code: string;

  @Field(() => String)
  name: string;

  @Field(() => DepartmentRefEntity, { nullable: true })
  parent?: DepartmentRefEntity | null;

  @Field(() => EmployeeRefEntity, { nullable: true })
  head?: EmployeeRefEntity | null;

  @Field(() => EmployeeRefEntity, { nullable: true })
  deputy?: EmployeeRefEntity | null;

  @Field(() => ActingAssignmentEntity, {
    nullable: true,
    description: 'Acting HOD in force today, if any',
  })
  actingHead?: ActingAssignmentEntity | null;

  @Field(() => Int)
  activeEmployeeCount: number;
}

@ObjectType('JobTitle')
export class JobTitleEntity extends BaseEntity {
  @Field(() => String)
  code: string;

  @Field(() => String)
  name: string;
}

@ObjectType('EmploymentType')
export class EmploymentTypeEntity extends BaseEntity {
  @Field(() => String)
  code: string;

  @Field(() => String)
  name: string;

  @Field(() => Boolean)
  requiresEndDate: boolean;
}
