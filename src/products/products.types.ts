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
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  AcquisitionMethod,
  ProductStatus,
  ProductVersionStatus,
  SpecRule,
  StoreItemType,
  TrackingType,
} from '@db';

registerEnumType(ProductStatus, { name: 'ProductStatus' });
registerEnumType(ProductVersionStatus, { name: 'ProductVersionStatus' });
registerEnumType(SpecRule, { name: 'SpecRule' });
registerEnumType(StoreItemType, { name: 'StoreItemType' });
registerEnumType(TrackingType, { name: 'TrackingType' });
registerEnumType(AcquisitionMethod, { name: 'AcquisitionMethod' });

// ── categories ─────────────────────────────────────────────────────────────

@ObjectType('CategoryCriterion')
export class CategoryCriterionEntity {
  @Field() uniqueId: string;
  @Field() text: string;
  @Field(() => Int) sortOrder: number;
  @Field() isActive: boolean;
}

@ObjectType('ProductCategory')
export class ProductCategoryEntity {
  @Field() uniqueId: string;
  @Field() code: string;
  @Field() name: string;
  @Field() tagPrefix: string;
  @Field() isActive: boolean;
  @Field(() => [CategoryCriterionEntity])
  criteria: CategoryCriterionEntity[];
  @Field(() => Int) productCount: number;
}

@InputType()
export class SaveCategoryInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  uniqueId?: string;
  @Length(2, 10) @Field() code: string;
  @Length(2, 80) @Field() name: string;
  @Length(2, 6) @Field() tagPrefix: string;
  @IsBoolean() @Field() isActive: boolean;
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Length(3, 300, { each: true })
  @Field(() => [String], { description: 'Active criteria, in order' })
  criteria: string[];
}

// ── products ───────────────────────────────────────────────────────────────

@ObjectType('ProductRef')
export class RefEntity {
  @Field() uniqueId: string;
  @Field() code: string;
  @Field() name: string;
}

@ObjectType('ProductSpec')
export class ProductSpecEntity {
  @Field() attribute: string;
  @Field(() => SpecRule) rule: SpecRule;
  @Field() value: string;
  @Field(() => String, { nullable: true }) valueMax?: string | null;
  @Field(() => String, { nullable: true }) unit?: string | null;
}

@ObjectType('ProductCriterion')
export class ProductCriterionEntity {
  @Field() text: string;
  @Field() fromLibrary: boolean;
}

@ObjectType('ProductAttachment')
export class ProductAttachmentEntity {
  @Field() uniqueId: string;
  @Field() filename: string;
  @Field() mimeType: string;
  @Field(() => Int) size: number;
  @Field() uri: string;
}

@ObjectType('ProductVersion')
export class ProductVersionEntity {
  @Field() uniqueId: string;
  @Field(() => Int) version: number;
  @Field(() => ProductVersionStatus) status: ProductVersionStatus;
  @Field() name: string;
  @Field() description: string;
  @Field(() => RefEntity) category: RefEntity;
  @Field() unit: string;
  @Field(() => Float, { nullable: true }) referencePrice?: number | null;
  @Field() author: string;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) submittedAt?: Date | null;
  @Field(() => Date, { nullable: true }) activatedAt?: Date | null;
  @Field(() => String, { nullable: true })
  approvalRequestUniqueId?: string | null;
  @Field(() => [ProductSpecEntity]) specs: ProductSpecEntity[];
  @Field(() => [ProductCriterionEntity]) criteria: ProductCriterionEntity[];
  @Field(() => [ProductAttachmentEntity])
  attachments: ProductAttachmentEntity[];
}

@ObjectType('ProductPermissions')
export class ProductPermissionsEntity {
  @Field() edit: boolean;
  @Field() submit: boolean;
  @Field() revise: boolean;
  @Field() manage: boolean;
  @Field() merge: boolean;
}

@ObjectType('Product')
export class ProductEntity {
  @Field() uniqueId: string;
  @Field(() => String, { nullable: true }) code?: string | null;
  @Field(() => ProductStatus) status: ProductStatus;
  @Field({ description: 'Name of the version in force, else the draft' })
  name: string;
  @Field() categoryName: string;
  @Field() unit: string;
  @Field(() => RefEntity) owningDepartment: RefEntity;
  @Field(() => StoreItemType, { nullable: true })
  itemType?: StoreItemType | null;
  @Field(() => TrackingType, { nullable: true })
  trackingType?: TrackingType | null;
  @Field(() => AcquisitionMethod, { nullable: true })
  acquisitionMethod?: AcquisitionMethod | null;
  @Field(() => String, { nullable: true })
  singleSourceVendor?: string | null;
  @Field(() => Float, { nullable: true }) vatRate?: number | null;
  @Field() isVehicle: boolean;
  @Field(() => RefEntity, { nullable: true }) mergedInto?: RefEntity | null;
  @Field(() => ProductVersionEntity, {
    nullable: true,
    description: 'The version in force',
  })
  current?: ProductVersionEntity | null;
  @Field(() => ProductVersionEntity, {
    nullable: true,
    description: 'Open draft / in-approval / returned version',
  })
  pending?: ProductVersionEntity | null;
  @Field(() => Int) assetCount: number;
  @Field() createdAt: Date;
  @Field(() => ProductPermissionsEntity) can: ProductPermissionsEntity;
}

@ObjectType('ProductSummary')
export class ProductSummaryEntity {
  @Field() uniqueId: string;
  @Field(() => String, { nullable: true }) code?: string | null;
  @Field(() => ProductStatus) status: ProductStatus;
  @Field() name: string;
  @Field() categoryName: string;
  @Field() unit: string;
  @Field() departmentName: string;
  @Field(() => StoreItemType, { nullable: true })
  itemType?: StoreItemType | null;
  @Field(() => TrackingType, { nullable: true })
  trackingType?: TrackingType | null;
  @Field() hasPendingVersion: boolean;
  @Field() updatedAt: Date;
}

@ObjectType('ProductList')
export class ProductListEntity {
  @Field(() => [ProductSummaryEntity]) data: ProductSummaryEntity[];
  @Field(() => Int) total: number;
  @Field(() => Int) page: number;
  @Field(() => Int) limit: number;
  @Field(() => Int) totalPages: number;
}

@InputType()
export class ProductFilterInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  search?: string;
  @IsOptional()
  @IsEnum(ProductStatus, { each: true })
  @Field(() => [ProductStatus], { nullable: true })
  statuses?: ProductStatus[];
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  categoryUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  departmentUniqueId?: string;
  @IsOptional()
  @IsEnum(StoreItemType)
  @Field(() => StoreItemType, { nullable: true })
  itemType?: StoreItemType;
  @IsOptional()
  @IsBoolean()
  @Field(() => Boolean, {
    nullable: true,
    description: 'Only products waiting for activation or with an open version',
  })
  pendingOnly?: boolean;
}

@InputType()
export class SpecInput {
  @Length(1, 80) @Field() attribute: string;
  @IsEnum(SpecRule) @Field(() => SpecRule) rule: SpecRule;
  @Length(1, 300) @Field() value: string;
  @IsOptional()
  @Length(1, 80)
  @Field(() => String, { nullable: true })
  valueMax?: string;
  @IsOptional()
  @Length(0, 20)
  @Field(() => String, { nullable: true })
  unit?: string;
}

@InputType()
export class CriterionInput {
  @Length(3, 300) @Field() text: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  libraryUniqueId?: string;
}

@InputType()
export class ProductVersionInput {
  @Length(3, 150) @Field() name: string;
  @Length(3, 4000) @Field() description: string;
  @IsString() @Field() categoryUniqueId: string;
  @Length(1, 20) @Field() unit: string;
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  referencePrice?: number;
  @ValidateNested({ each: true })
  @ArrayMaxSize(60)
  @Type(() => SpecInput)
  @Field(() => [SpecInput])
  specs: SpecInput[];
  @ValidateNested({ each: true })
  @ArrayMaxSize(60)
  @Type(() => CriterionInput)
  @Field(() => [CriterionInput])
  criteria: CriterionInput[];
  @IsString({ each: true })
  @ArrayMaxSize(20)
  @Field(() => [String], { description: 'File uniqueIds' })
  attachmentUniqueIds: string[];
}

@InputType()
export class CreateProductInput extends ProductVersionInput {
  @IsOptional()
  @IsString()
  @Field(() => String, {
    nullable: true,
    description: 'Owning department (default: your own)',
  })
  departmentUniqueId?: string;
}

@InputType()
export class ProductActivationInput {
  @IsString() @Field() productUniqueId: string;
  @IsOptional()
  @Length(2, 30)
  @Field(() => String, {
    nullable: true,
    description: 'Blank = next code in the category series',
  })
  code?: string;
  @IsEnum(StoreItemType)
  @Field(() => StoreItemType)
  itemType: StoreItemType;
  @IsEnum(TrackingType)
  @Field(() => TrackingType)
  trackingType: TrackingType;
  @IsEnum(AcquisitionMethod)
  @Field(() => AcquisitionMethod)
  acquisitionMethod: AcquisitionMethod;
  @IsOptional()
  @Length(2, 150)
  @Field(() => String, { nullable: true })
  singleSourceVendor?: string;
  @IsNumber()
  @Min(0)
  @Max(100)
  @Field(() => Float)
  vatRate: number;
  @IsBoolean() @Field() isVehicle: boolean;
}
