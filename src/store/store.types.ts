import {
  Field,
  Float,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  AdjustmentStatus,
  AdjustmentType,
  AssetCondition,
  AssetSource,
  AssetStatus,
  LocationKind,
  StockTxnType,
  StoreType,
} from '@db';

registerEnumType(StoreType, { name: 'StoreType' });
registerEnumType(LocationKind, { name: 'LocationKind' });
registerEnumType(AssetStatus, { name: 'AssetStatus' });
registerEnumType(AssetCondition, { name: 'AssetCondition' });
registerEnumType(AssetSource, { name: 'AssetSource' });
registerEnumType(StockTxnType, { name: 'StockTxnType' });
registerEnumType(AdjustmentType, { name: 'AdjustmentType' });
registerEnumType(AdjustmentStatus, { name: 'AdjustmentStatus' });

@ObjectType('StoreRef')
export class StoreRefEntity {
  @Field() uniqueId: string;
  @Field() code: string;
  @Field() name: string;
}

@ObjectType('StorePerson')
export class StorePersonEntity {
  @Field() uniqueId: string;
  @Field() fullName: string;
  @Field() email: string;
}

@ObjectType('StoreLocation')
export class StoreLocationEntity {
  @Field() uniqueId: string;
  @Field() code: string;
  @Field() name: string;
  @Field(() => LocationKind) kind: LocationKind;
  @Field() isActive: boolean;
  @Field(() => String, { nullable: true }) parentUniqueId?: string | null;
  @Field({ description: 'Full path, e.g. A / A-01 / Bin 3' }) path: string;
}

@ObjectType('Store')
export class StoreEntity {
  @Field() uniqueId: string;
  @Field() code: string;
  @Field() name: string;
  @Field(() => StoreType) type: StoreType;
  @Field(() => String, { nullable: true }) address?: string | null;
  @Field() isActive: boolean;
  @Field(() => StoreRefEntity) managingDepartment: StoreRefEntity;
  @Field(() => [StoreLocationEntity]) locations: StoreLocationEntity[];
  @Field(() => [StorePersonEntity]) storekeepers: StorePersonEntity[];
  @Field(() => Int) assetCount: number;
}

@InputType()
export class SaveStoreInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  uniqueId?: string;
  @Length(2, 20) @Field() code: string;
  @Length(2, 120) @Field() name: string;
  @IsEnum(StoreType) @Field(() => StoreType) type: StoreType;
  @IsString() @Field() managingDepartmentUniqueId: string;
  @IsOptional()
  @Length(0, 300)
  @Field(() => String, { nullable: true })
  address?: string;
  @IsBoolean() @Field() isActive: boolean;
}

@InputType()
export class SaveLocationInput {
  @IsString() @Field() storeUniqueId: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  uniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  parentUniqueId?: string;
  @Length(1, 30) @Field() code: string;
  @Length(1, 120) @Field() name: string;
  @IsBoolean() @Field() isActive: boolean;
}

@ObjectType('StockSetting')
export class StockSettingEntity {
  @Field() productUniqueId: string;
  @Field(() => String, { nullable: true }) productCode?: string | null;
  @Field() productName: string;
  @Field() unit: string;
  @Field(() => Int) minLevel: number;
  @Field(() => Int) reorderLevel: number;
  @Field(() => Int, { nullable: true }) maxLevel?: number | null;
  @Field(() => String, { nullable: true })
  defaultLocationUniqueId?: string | null;
}

@InputType()
export class StockSettingInput {
  @IsString() @Field() storeUniqueId: string;
  @IsString() @Field() productUniqueId: string;
  @IsInt() @Min(0) @Field(() => Int) minLevel: number;
  @IsInt() @Min(0) @Field(() => Int) reorderLevel: number;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  maxLevel?: number;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  defaultLocationUniqueId?: string;
}

// ── stock levels ───────────────────────────────────────────────────────────

@ObjectType('StockLevel')
export class StockLevelEntity {
  @Field(() => StoreRefEntity) store: StoreRefEntity;
  @Field() productUniqueId: string;
  @Field(() => String, { nullable: true }) productCode?: string | null;
  @Field() productName: string;
  @Field() categoryName: string;
  @Field() departmentName: string;
  @Field() unit: string;
  @Field() serialised: boolean;
  @Field(() => Int) onHand: number;
  @Field(() => Int) quarantine: number;
  @Field(() => Int) reserved: number;
  @Field(() => Int) available: number;
  @Field(() => Int, { description: 'With employees, productions, repair' })
  out: number;
  @Field(() => Int) inTransit: number;
  @Field(() => Int, { nullable: true }) reorderLevel?: number | null;
  @Field() belowReorder: boolean;
}

@InputType()
export class StockLevelFilterInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  storeUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  categoryUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  search?: string;
  @IsOptional()
  @IsBoolean()
  @Field(() => Boolean, { nullable: true })
  belowReorderOnly?: boolean;
}

// ── assets ─────────────────────────────────────────────────────────────────

@ObjectType('AssetProductRef')
export class AssetProductEntity {
  @Field() uniqueId: string;
  @Field(() => String, { nullable: true }) code?: string | null;
  @Field() name: string;
  @Field() categoryName: string;
  @Field(() => Int) version: number;
  @Field() isVehicle: boolean;
}

@ObjectType('AssetCustodian')
export class AssetCustodianEntity {
  @Field() uniqueId: string;
  @Field() employeeNumber: string;
  @Field() fullName: string;
}

@ObjectType('AssetComponent')
export class AssetComponentEntity {
  @Field() uniqueId: string;
  @Field() tag: string;
  @Field() productName: string;
  @Field(() => AssetStatus) status: AssetStatus;
  @Field(() => AssetCondition) condition: AssetCondition;
}

@ObjectType('VehicleDetails')
export class VehicleDetailsEntity {
  @Field() registrationNumber: string;
  @Field(() => String, { nullable: true }) chassisNumber?: string | null;
  @Field(() => String, { nullable: true }) engineNumber?: string | null;
  @Field(() => String, { nullable: true }) fuelType?: string | null;
  @Field(() => Int, { nullable: true }) seatingCapacity?: number | null;
  @Field(() => Date, { nullable: true }) insuranceExpiry?: Date | null;
  @Field(() => Date, { nullable: true }) roadLicenceExpiry?: Date | null;
  @Field(() => Int, { nullable: true }) serviceIntervalKm?: number | null;
  @Field(() => Int, { nullable: true })
  serviceIntervalMonths?: number | null;
}

@ObjectType('Asset')
export class AssetEntity {
  @Field() uniqueId: string;
  @Field() tag: string;
  @Field(() => String, { nullable: true }) serialNumber?: string | null;
  @Field(() => String, { nullable: true }) brand?: string | null;
  @Field(() => String, { nullable: true }) model?: string | null;
  @Field(() => AssetProductEntity) product: AssetProductEntity;
  @Field(() => StoreRefEntity) owningDepartment: StoreRefEntity;
  @Field(() => AssetSource) source: AssetSource;
  @Field(() => String, { nullable: true }) lpoRef?: string | null;
  @Field(() => String, { nullable: true }) grnRef?: string | null;
  @Field(() => String, { nullable: true }) inspectionRef?: string | null;
  @Field(() => String, { nullable: true }) vendorRef?: string | null;
  @Field(() => Float, { nullable: true }) purchasePrice?: number | null;
  @Field() priceEstimated: boolean;
  @Field(() => Date, { nullable: true }) purchaseDate?: Date | null;
  @Field(() => Date, { nullable: true }) warrantyExpiry?: Date | null;
  @Field(() => StoreRefEntity, { nullable: true })
  store?: StoreRefEntity | null;
  @Field(() => StoreLocationEntity, { nullable: true })
  location?: StoreLocationEntity | null;
  @Field(() => AssetCustodianEntity, { nullable: true })
  custodian?: AssetCustodianEntity | null;
  @Field(() => AssetCondition) condition: AssetCondition;
  @Field(() => AssetStatus) status: AssetStatus;
  @Field() isKit: boolean;
  @Field(() => AssetComponentEntity, { nullable: true })
  parent?: AssetComponentEntity | null;
  @Field(() => [AssetComponentEntity]) components: AssetComponentEntity[];
  @Field(() => VehicleDetailsEntity, { nullable: true })
  vehicle?: VehicleDetailsEntity | null;
  @Field(() => String, { nullable: true }) notes?: string | null;
  @Field() createdAt: Date;
  @Field() canEdit: boolean;
}

@ObjectType('AssetList')
export class AssetListEntity {
  @Field(() => [AssetEntity]) data: AssetEntity[];
  @Field(() => Int) total: number;
  @Field(() => Int) page: number;
  @Field(() => Int) limit: number;
  @Field(() => Int) totalPages: number;
}

@InputType()
export class AssetFilterInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true, description: 'Tag, serial, product' })
  search?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  storeUniqueId?: string;
  @IsOptional()
  @IsEnum(AssetStatus, { each: true })
  @Field(() => [AssetStatus], { nullable: true })
  statuses?: AssetStatus[];
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  categoryUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  departmentUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  productUniqueId?: string;
  @IsOptional()
  @IsBoolean()
  @Field(() => Boolean, { nullable: true })
  vehiclesOnly?: boolean;
}

@InputType()
export class VehicleInput {
  @Length(2, 20) @Field() registrationNumber: string;
  @IsOptional()
  @Length(0, 40)
  @Field(() => String, { nullable: true })
  chassisNumber?: string;
  @IsOptional()
  @Length(0, 40)
  @Field(() => String, { nullable: true })
  engineNumber?: string;
  @IsOptional()
  @Length(0, 20)
  @Field(() => String, { nullable: true })
  fuelType?: string;
  @IsOptional()
  @IsInt()
  @Min(1)
  @Field(() => Int, { nullable: true })
  seatingCapacity?: number;
  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  insuranceExpiry?: string;
  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  roadLicenceExpiry?: string;
  @IsOptional()
  @IsInt()
  @Min(1)
  @Field(() => Int, { nullable: true })
  serviceIntervalKm?: number;
  @IsOptional()
  @IsInt()
  @Min(1)
  @Field(() => Int, { nullable: true })
  serviceIntervalMonths?: number;
}

@InputType()
export class UpdateAssetInput {
  @IsString() @Field() uniqueId: string;
  @IsOptional()
  @Length(0, 80)
  @Field(() => String, { nullable: true })
  serialNumber?: string;
  @IsOptional()
  @Length(0, 80)
  @Field(() => String, { nullable: true })
  brand?: string;
  @IsOptional()
  @Length(0, 80)
  @Field(() => String, { nullable: true })
  model?: string;
  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  warrantyExpiry?: string;
  @IsOptional()
  @Length(0, 1000)
  @Field(() => String, { nullable: true })
  notes?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => VehicleInput)
  @Field(() => VehicleInput, { nullable: true })
  vehicle?: VehicleInput;
  @Length(3, 500)
  @Field({ description: 'Why the record is corrected' })
  reason: string;
}

@ObjectType('StockMovement')
export class StockMovementEntity {
  @Field() uniqueId: string;
  @Field(() => StockTxnType) type: StockTxnType;
  @Field() at: Date;
  @Field(() => String, { nullable: true }) user?: string | null;
  @Field(() => StoreRefEntity) store: StoreRefEntity;
  @Field(() => String, { nullable: true }) location?: string | null;
  @Field(() => String, { nullable: true }) toLocation?: string | null;
  @Field() productName: string;
  @Field(() => String, { nullable: true }) productCode?: string | null;
  @Field(() => String, { nullable: true }) assetTag?: string | null;
  @Field(() => String, { nullable: true }) assetUniqueId?: string | null;
  @Field(() => String, { nullable: true }) batchNumber?: string | null;
  @Field(() => Int) quantity: number;
  @Field(() => AssetStatus, { nullable: true }) fromStatus?: AssetStatus | null;
  @Field(() => AssetStatus, { nullable: true }) toStatus?: AssetStatus | null;
  @Field(() => AssetCondition, { nullable: true })
  condition?: AssetCondition | null;
  @Field(() => String, { nullable: true }) referenceType?: string | null;
  @Field(() => String, { nullable: true }) referenceId?: string | null;
  @Field(() => String, { nullable: true }) reason?: string | null;
}

@InputType()
export class MovementFilterInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  storeUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  productUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  assetUniqueId?: string;
  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  from?: string;
  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  to?: string;
}

// ── tags ───────────────────────────────────────────────────────────────────

@ObjectType('AssetTag')
export class AssetTagEntity {
  @Field() tag: string;
  @Field() prefix: string;
  @Field(() => Int) number: number;
  @Field() issuedAt: Date;
  @Field(() => Date, { nullable: true }) printedAt?: Date | null;
  @Field(() => String, { nullable: true }) assetUniqueId?: string | null;
  @Field(() => String, { nullable: true }) productName?: string | null;
  @Field(() => String, { nullable: true }) serialNumber?: string | null;
}

// ── adjustments ────────────────────────────────────────────────────────────

@ObjectType('AdjustmentLine')
export class AdjustmentLineEntity {
  @Field(() => Int) lineNo: number;
  @Field() productUniqueId: string;
  @Field(() => String, { nullable: true }) productCode?: string | null;
  @Field() productName: string;
  @Field() location: string;
  @Field(() => Int) quantity: number;
  @Field(() => String, { nullable: true }) batchNumber?: string | null;
  @Field(() => Date, { nullable: true }) expiryDate?: Date | null;
  @Field(() => String, { nullable: true }) tag?: string | null;
  @Field(() => String, { nullable: true }) serialNumber?: string | null;
  @Field(() => String, { nullable: true }) brand?: string | null;
  @Field(() => String, { nullable: true }) model?: string | null;
  @Field(() => AssetCondition, { nullable: true })
  condition?: AssetCondition | null;
  @Field(() => String, { nullable: true }) holder?: string | null;
  @Field(() => String, { nullable: true }) kitTag?: string | null;
  @Field(() => String, { nullable: true }) assetUniqueId?: string | null;
}

@ObjectType('StockAdjustment')
export class StockAdjustmentEntity {
  @Field() uniqueId: string;
  @Field() number: string;
  @Field(() => AdjustmentType) type: AdjustmentType;
  @Field(() => AdjustmentStatus) status: AdjustmentStatus;
  @Field(() => StoreRefEntity) store: StoreRefEntity;
  @Field() reason: string;
  @Field() createdBy: string;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) postedAt?: Date | null;
  @Field(() => String, { nullable: true }) postError?: string | null;
  @Field(() => String, { nullable: true })
  approvalRequestUniqueId?: string | null;
  @Field(() => Int) lineCount: number;
  @Field(() => Int) assetCount: number;
  @Field(() => Int) quantityTotal: number;
  @Field(() => [AdjustmentLineEntity]) lines: AdjustmentLineEntity[];
  @Field() canResubmit: boolean;
  @Field() canCancel: boolean;
}

@InputType()
export class AdjustmentAssetInput {
  @IsOptional()
  @Length(3, 40)
  @Field(() => String, {
    nullable: true,
    description: 'Pre-printed tag (blank = issue a new one)',
  })
  tag?: string;
  @IsOptional()
  @Length(0, 80)
  @Field(() => String, { nullable: true })
  serialNumber?: string;
  @IsOptional()
  @Length(0, 80)
  @Field(() => String, { nullable: true })
  brand?: string;
  @IsOptional()
  @Length(0, 80)
  @Field(() => String, { nullable: true })
  model?: string;
  @IsEnum(AssetCondition)
  @Field(() => AssetCondition)
  condition: AssetCondition;
  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  purchaseDate?: string;
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  purchasePrice?: number;
  @IsOptional()
  @IsBoolean()
  @Field(() => Boolean, { nullable: true })
  priceEstimated?: boolean;
  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  warrantyExpiry?: string;
  @IsOptional()
  @Length(0, 1000)
  @Field(() => String, { nullable: true })
  notes?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => VehicleInput)
  @Field(() => VehicleInput, { nullable: true })
  vehicle?: VehicleInput;
}

@InputType()
export class AdjustmentLineInput {
  @IsString() @Field() productUniqueId: string;
  @IsString() @Field() locationUniqueId: string;
  @IsInt()
  @Min(-100000)
  @Max(100000)
  @Field(() => Int, { description: 'Serialised: 1' })
  quantity: number;
  @IsOptional()
  @Length(1, 40)
  @Field(() => String, { nullable: true })
  batchNumber?: string;
  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  expiryDate?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => AdjustmentAssetInput)
  @Field(() => AdjustmentAssetInput, { nullable: true })
  asset?: AdjustmentAssetInput;
}

@InputType()
export class CreateAdjustmentInput {
  @IsString() @Field() storeUniqueId: string;
  @IsIn(['FOUND', 'DONATED', 'CORRECTION', 'OPENING_BALANCE'])
  @Field(() => AdjustmentType)
  type: AdjustmentType;
  @Length(3, 1000) @Field() reason: string;
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AdjustmentLineInput)
  @Field(() => [AdjustmentLineInput])
  lines: AdjustmentLineInput[];
}
