import {
  Field,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  InternalRequestStatus,
  PurchaseRequestStatus,
  TrackingType,
} from '@db';
import { StoreRefEntity } from '../store/store.types';

registerEnumType(InternalRequestStatus, { name: 'InternalRequestStatus' });
registerEnumType(PurchaseRequestStatus, { name: 'PurchaseRequestStatus' });

@ObjectType('RequestEmployee')
export class RequestEmployeeEntity {
  @Field() uniqueId: string;
  @Field() employeeNumber: string;
  @Field() fullName: string;
  @Field() companyEmail: string;
}

@ObjectType('RequestProduct')
export class RequestProductEntity {
  @Field() uniqueId: string;
  @Field(() => String, { nullable: true }) code?: string | null;
  @Field() name: string;
  @Field() unit: string;
  @Field(() => TrackingType, { nullable: true })
  trackingType?: TrackingType | null;
  @Field() status: string;
}

@ObjectType('InternalRequestPermissions')
export class InternalRequestCanEntity {
  @Field() edit: boolean;
  @Field() submit: boolean;
  @Field() accept: boolean;
  @Field() plan: boolean;
  @Field() purchase: boolean;
  @Field() close: boolean;
  @Field() cancel: boolean;
}

@ObjectType('InternalRequest')
export class InternalRequestEntity {
  @Field() uniqueId: string;
  @Field() number: string;
  @Field(() => InternalRequestStatus) status: InternalRequestStatus;
  @Field(() => StoreRefEntity) requestingDepartment: StoreRefEntity;
  @Field(() => StoreRefEntity) owningDepartment: StoreRefEntity;
  @Field(() => RequestEmployeeEntity, { nullable: true })
  beneficiary?: RequestEmployeeEntity | null;
  @Field(() => RequestProductEntity) product: RequestProductEntity;
  @Field(() => Int) quantity: number;
  @Field(() => Date, { nullable: true }) requiredBy?: Date | null;
  @Field() justification: string;
  @Field(() => String, { nullable: true }) productionRef?: string | null;
  @Field() createdBy: string;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) submittedAt?: Date | null;
  @Field(() => Date, { nullable: true }) acceptedAt?: Date | null;
  @Field(() => Int, { nullable: true }) acceptedQty?: number | null;
  @Field(() => String, { nullable: true }) acceptNote?: string | null;
  @Field(() => StoreRefEntity, { nullable: true })
  store?: StoreRefEntity | null;
  @Field(() => Int) fromStoreQty: number;
  @Field(() => Int) toPurchaseQty: number;
  @Field(() => Int) deliveredQty: number;
  @Field(() => String, { nullable: true }) approvalRequestUniqueId?:
    string | null;
  @Field(() => InternalRequestCanEntity) can: InternalRequestCanEntity;
}

@InputType()
export class CreateInternalRequestInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  departmentUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, {
    nullable: true,
    description: 'Empty = for the department',
  })
  beneficiaryEmployeeUniqueId?: string;
  @IsString() @Field() productUniqueId: string;
  @IsInt() @Min(1) @Field(() => Int) quantity: number;
  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  requiredBy?: string;
  @Length(3, 2000) @Field() justification: string;
  @IsOptional()
  @Length(1, 120)
  @Field(() => String, { nullable: true })
  productionRef?: string;
}

@InputType()
export class UpdateInternalRequestInput {
  @IsInt() @Min(1) @Field(() => Int) quantity: number;
  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  requiredBy?: string;
  @Length(3, 2000) @Field() justification: string;
}

@InputType()
export class PlanInternalRequestInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  storeUniqueId?: string;
  @IsInt() @Min(0) @Field(() => Int) fromStoreQty: number;
  @IsInt() @Min(0) @Field(() => Int) toPurchaseQty: number;
}

@ObjectType('PurchaseRequestLine')
export class PurchaseLineEntity {
  @Field(() => Int) lineNo: number;
  @Field() productUniqueId: string;
  @Field(() => String, { nullable: true }) productCode?: string | null;
  @Field() productName: string;
  @Field() productStatus: string;
  @Field() unit: string;
  @Field(() => Int) quantity: number;
  @Field(() => String, { nullable: true }) beneficiary?: string | null;
  @Field(() => String, { nullable: true }) internalRequestNumber?:
    string | null;
  @Field(() => String, { nullable: true }) internalRequestUniqueId?:
    string | null;
  @Field(() => String, { nullable: true }) note?: string | null;
}

@ObjectType('PurchaseRequestPermissions')
export class PurchaseCanEntity {
  @Field() submit: boolean;
  @Field() cancel: boolean;
}

@ObjectType('PurchaseRequest')
export class PurchaseRequestEntity {
  @Field() uniqueId: string;
  @Field() number: string;
  @Field(() => PurchaseRequestStatus) status: PurchaseRequestStatus;
  @Field(() => StoreRefEntity) department: StoreRefEntity;
  @Field() justification: string;
  @Field() createdBy: string;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) submittedAt?: Date | null;
  @Field(() => Date, { nullable: true }) decidedAt?: Date | null;
  @Field(() => String, { nullable: true }) approvalRequestUniqueId?:
    string | null;
  @Field(() => Int) lineCount: number;
  @Field(() => [PurchaseLineEntity]) lines: PurchaseLineEntity[];
  @Field(() => PurchaseCanEntity) can: PurchaseCanEntity;
}

@InputType()
export class PurchaseLineInput {
  @IsString() @Field() productUniqueId: string;
  @IsInt() @Min(1) @Field(() => Int) quantity: number;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  beneficiaryEmployeeUniqueId?: string;
  @IsOptional()
  @Length(1, 120)
  @Field(() => String, { nullable: true })
  productionRef?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  internalRequestUniqueId?: string;
  @IsOptional()
  @Length(0, 500)
  @Field(() => String, { nullable: true })
  note?: string;
}

@InputType()
export class CreatePurchaseRequestInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  departmentUniqueId?: string;
  @Length(3, 2000) @Field() justification: string;
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineInput)
  @Field(() => [PurchaseLineInput])
  lines: PurchaseLineInput[];
}
