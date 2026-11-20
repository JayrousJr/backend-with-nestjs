import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';
import { EmployeeStatus, Gender, UserStatus } from '@db';
import { BaseEntity, QueryListResponse } from '@common';
import {
  DepartmentRefEntity,
  EmployeeRefEntity,
} from '../../org/entities/org.entities';

registerEnumType(Gender, { name: 'Gender' });
registerEnumType(EmployeeStatus, { name: 'EmployeeStatus' });
registerEnumType(UserStatus, { name: 'UserStatus' });

@ObjectType('LookupRef')
export class LookupRefEntity {
  @Field(() => String)
  uniqueId: string;

  @Field(() => String)
  code: string;

  @Field(() => String)
  name: string;
}

@ObjectType('DriverProfile')
export class DriverProfileEntity {
  @Field(() => String)
  licenceNumber: string;

  @Field(() => String)
  licenceClass: string;

  @Field(() => Date)
  licenceExpiry: Date;
}

@ObjectType('EmployeeUserRef')
export class EmployeeUserRefEntity {
  @Field(() => String)
  uniqueId: string;

  @Field(() => UserStatus)
  status: UserStatus;
}

@ObjectType('Employee')
export class EmployeeEntity extends BaseEntity {
  @Field(() => String)
  employeeNumber: string;

  @Field(() => String)
  firstName: string;

  @Field(() => String, { nullable: true })
  middleName?: string | null;

  @Field(() => String)
  lastName: string;

  @Field(() => String)
  fullName: string;

  @Field(() => Gender)
  gender: Gender;

  @Field(() => String)
  companyEmail: string;

  @Field(() => String, {
    nullable: true,
    description: 'Null unless the viewer holds employee.view_personal',
  })
  phone?: string | null;

  @Field(() => DepartmentRefEntity)
  department: DepartmentRefEntity;

  @Field(() => LookupRefEntity)
  jobTitle: LookupRefEntity;

  @Field(() => LookupRefEntity)
  employmentType: LookupRefEntity;

  @Field(() => Date)
  startDate: Date;

  @Field(() => Date, { nullable: true })
  contractEndDate?: Date | null;

  @Field(() => EmployeeRefEntity, { nullable: true })
  supervisor?: EmployeeRefEntity | null;

  @Field(() => String, { nullable: true })
  workLocation?: string | null;

  @Field(() => EmployeeStatus)
  status: EmployeeStatus;

  @Field(() => [String])
  skills: string[];

  @Field(() => [String])
  qualifications: string[];

  @Field(() => [String])
  professionalRoles: string[];

  @Field(() => DriverProfileEntity, { nullable: true })
  driverProfile?: DriverProfileEntity | null;

  @Field(() => EmployeeUserRefEntity, { nullable: true })
  user?: EmployeeUserRefEntity | null;

  @Field(() => String, {
    nullable: true,
    description: 'Photo file uniqueId (personal field)',
  })
  photoFileId?: string | null;

  @Field(() => Boolean, {
    description: 'Whether personal fields were included for this viewer',
  })
  personalVisible: boolean;
}

@ObjectType()
export class EmployeeListResponse extends QueryListResponse(EmployeeEntity) {}

@ObjectType('EmployeeHistoryEntry')
export class EmployeeHistoryEntity {
  @Field(() => String)
  field: string;

  @Field(() => String, { nullable: true })
  oldValue?: string | null;

  @Field(() => String, { nullable: true })
  newValue?: string | null;

  @Field(() => Date)
  effectiveDate: Date;

  @Field(() => String, { nullable: true })
  changedBy?: string | null;

  @Field(() => String, { nullable: true })
  reason?: string | null;

  @Field(() => Date)
  createdAt: Date;
}
