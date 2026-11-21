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
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  AssetCondition,
  BeneficiaryType,
  StockDocType,
  TransferReason,
  TransferStatus,
} from '@db';
import { StoreRefEntity } from './store.types';

registerEnumType(TransferStatus, { name: 'TransferStatus' });
registerEnumType(TransferReason, { name: 'TransferReason' });
registerEnumType(StockDocType, { name: 'StockDocType' });
registerEnumType(BeneficiaryType, { name: 'BeneficiaryType' });

@ObjectType('TransferLine')
export class TransferLineEntity {
  @Field(() => Int) lineNo: number;
  @Field() productUniqueId: string;
  @Field(() => String, { nullable: true }) productCode?: string | null;
  @Field() productName: string;
  @Field(() => String, { nullable: true }) assetUniqueId?: string | null;
  @Field(() => String, { nullable: true }) assetTag?: string | null;
  @Field(() => [String], { description: 'Kit components travelling along' })
  components: string[];
  @Field(() => String, { nullable: true }) batchNumber?: string | null;
  @Field(() => Int) quantity: number;
  @Field(() => String, { nullable: true }) fromLocation?: string | null;
  @Field(() => Int, { nullable: true }) dispatchedQty?: number | null;
  @Field(() => AssetCondition, { nullable: true })
  dispatchCondition?: AssetCondition | null;
  @Field(() => Int, { nullable: true }) receivedQty?: number | null;
  @Field(() => AssetCondition, { nullable: true })
  receivedCondition?: AssetCondition | null;
  @Field(() => String, { nullable: true }) toLocation?: string | null;
  @Field(() => String, { nullable: true }) note?: string | null;
}

@ObjectType('TransferPermissions')
export class TransferCanEntity {
  @Field() dispatch: boolean;
  @Field() receive: boolean;
  @Field() cancel: boolean;
}

@ObjectType('Transfer')
export class TransferEntity {
  @Field() uniqueId: string;
  @Field() number: string;
  @Field(() => TransferStatus) status: TransferStatus;
  @Field(() => TransferReason) reason: TransferReason;
  @Field(() => String, { nullable: true }) note?: string | null;
  @Field(() => String, { nullable: true }) problem?: string | null;
  @Field(() => StoreRefEntity) fromStore: StoreRefEntity;
  @Field(() => StoreRefEntity) toStore: StoreRefEntity;
  @Field() requestedBy: string;
  @Field(() => String, { nullable: true }) dispatchedBy?: string | null;
  @Field(() => Date, { nullable: true }) dispatchedAt?: Date | null;
  @Field(() => String, { nullable: true }) carriedBy?: string | null;
  @Field(() => String, { nullable: true }) vehicle?: string | null;
  @Field(() => Date, { nullable: true }) expectedArrival?: Date | null;
  @Field(() => String, { nullable: true }) receivedBy?: string | null;
  @Field(() => Date, { nullable: true }) receivedAt?: Date | null;
  @Field(() => String, { nullable: true }) discrepancyNote?: string | null;
  @Field() createdAt: Date;
  @Field(() => String, { nullable: true }) approvalRequestUniqueId?:
    string | null;
  @Field(() => String, { nullable: true }) discrepancyRequestUniqueId?:
    string | null;
  @Field(() => Int) lineCount: number;
  @Field() overdue: boolean;
  @Field(() => [TransferLineEntity]) lines: TransferLineEntity[];
  @Field(() => TransferCanEntity) can: TransferCanEntity;
}

@InputType()
export class TransferLineInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  assetUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  productUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  fromLocationUniqueId?: string;
  @IsOptional()
  @Length(1, 40)
  @Field(() => String, { nullable: true })
  batchNumber?: string;
  @IsOptional()
  @IsInt()
  @Min(1)
  @Field(() => Int, { nullable: true })
  quantity?: number;
}

@InputType()
export class CreateTransferInput {
  @IsString() @Field() fromStoreUniqueId: string;
  @IsString() @Field() toStoreUniqueId: string;
  @IsEnum(TransferReason) @Field(() => TransferReason) reason: TransferReason;
  @IsOptional()
  @Length(0, 1000)
  @Field(() => String, { nullable: true })
  note?: string;
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => TransferLineInput)
  @Field(() => [TransferLineInput])
  lines: TransferLineInput[];
}

@InputType()
export class DispatchLineInput {
  @IsInt() @Field(() => Int) lineNo: number;
  @IsInt()
  @Min(0)
  @Field(() => Int, { description: '0 = not sent' })
  quantity: number;
  @IsOptional()
  @IsEnum(AssetCondition)
  @Field(() => AssetCondition, { nullable: true })
  condition?: AssetCondition;
  @IsOptional()
  @Length(0, 300)
  @Field(() => String, { nullable: true })
  note?: string;
}

@InputType()
export class DispatchTransferInput {
  @ValidateNested({ each: true })
  @Type(() => DispatchLineInput)
  @Field(() => [DispatchLineInput], {
    description: 'Omitted lines are sent in full',
  })
  lines: DispatchLineInput[];
  @IsOptional()
  @Length(0, 120)
  @Field(() => String, { nullable: true })
  carriedBy?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  vehicleAssetUniqueId?: string;
  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  expectedArrival?: string;
}

@InputType()
export class ReceiveLineInput {
  @IsInt() @Field(() => Int) lineNo: number;
  @IsInt() @Min(0) @Field(() => Int) quantity: number;
  @IsOptional()
  @IsEnum(AssetCondition)
  @Field(() => AssetCondition, { nullable: true })
  condition?: AssetCondition;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  toLocationUniqueId?: string;
  @IsOptional()
  @Length(0, 300)
  @Field(() => String, { nullable: true })
  note?: string;
}

@InputType()
export class ReceiveTransferInput {
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineInput)
  @Field(() => [ReceiveLineInput])
  lines: ReceiveLineInput[];
  @IsOptional()
  @Length(0, 1000)
  @Field(() => String, { nullable: true, description: 'Discrepancy notes' })
  note?: string;
}

// ── issues / returns ─────────────────────────────────────────────────────

@ObjectType('StockDocumentLine')
export class StockDocumentLineEntity {
  @Field(() => Int) lineNo: number;
  @Field() productUniqueId: string;
  @Field(() => String, { nullable: true }) productCode?: string | null;
  @Field() productName: string;
  @Field() unit: string;
  @Field() location: string;
  @Field(() => String, { nullable: true }) batchNumber?: string | null;
  @Field(() => Int) quantity: number;
}

@ObjectType('StockDocument')
export class StockDocumentEntity {
  @Field() uniqueId: string;
  @Field() number: string;
  @Field(() => StockDocType) type: StockDocType;
  @Field(() => StoreRefEntity) store: StoreRefEntity;
  @Field(() => BeneficiaryType) beneficiaryType: BeneficiaryType;
  @Field() beneficiary: string;
  @Field(() => String, { nullable: true }) reference?: string | null;
  @Field(() => String, { nullable: true }) note?: string | null;
  @Field() by: string;
  @Field() at: Date;
  @Field(() => [StockDocumentLineEntity]) lines: StockDocumentLineEntity[];
}

@InputType()
export class StockDocumentLineInput {
  @IsString() @Field() productUniqueId: string;
  @IsString() @Field() locationUniqueId: string;
  @IsOptional()
  @Length(1, 40)
  @Field(() => String, { nullable: true })
  batchNumber?: string;
  @IsInt() @Min(1) @Field(() => Int) quantity: number;
}

@InputType()
export class CreateStockDocumentInput {
  @IsEnum(StockDocType) @Field(() => StockDocType) type: StockDocType;
  @IsString() @Field() storeUniqueId: string;
  @IsEnum(BeneficiaryType)
  @Field(() => BeneficiaryType)
  beneficiaryType: BeneficiaryType;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  departmentUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  employeeUniqueId?: string;
  @IsOptional()
  @Length(1, 120)
  @Field(() => String, { nullable: true })
  productionRef?: string;
  @IsOptional()
  @Length(1, 60)
  @Field(() => String, { nullable: true })
  reference?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, {
    nullable: true,
    description: 'Deliver against this internal request',
  })
  internalRequestUniqueId?: string;
  @IsOptional()
  @Length(0, 1000)
  @Field(() => String, { nullable: true })
  note?: string;
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => StockDocumentLineInput)
  @Field(() => [StockDocumentLineInput])
  lines: StockDocumentLineInput[];
}
