import {
  Field,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  AssetCondition,
  AssetStatus,
  CountScope,
  CountStatus,
  DisposalStatus,
  MaintenanceSource,
  MaintenanceStatus,
} from '@db';
import { StoreRefEntity } from './store.types';

registerEnumType(CountScope, { name: 'CountScope' });
registerEnumType(CountStatus, { name: 'CountStatus' });
registerEnumType(MaintenanceStatus, { name: 'MaintenanceStatus' });
registerEnumType(MaintenanceSource, { name: 'MaintenanceSource' });
registerEnumType(DisposalStatus, { name: 'DisposalStatus' });

// ── counts ──

@ObjectType('StockCountLine')
export class CountLineEntity {
  @Field(() => Int) id: number;
  @Field() productName: string;
  @Field(() => String, { nullable: true }) productCode?: string | null;
  @Field() unit: string;
  @Field(() => String, { nullable: true }) assetUniqueId?: string | null;
  @Field(() => String, { nullable: true }) assetTag?: string | null;
  @Field(() => String, { nullable: true }) serialNumber?: string | null;
  @Field() location: string;
  @Field(() => String, { nullable: true }) batchNumber?: string | null;
  @Field(() => Int, {
    nullable: true,
    description: 'Hidden while counting (blind count)',
  })
  expectedQty?: number | null;
  @Field(() => Int, { nullable: true }) countedQty?: number | null;
  @Field(() => Int, { nullable: true }) variance?: number | null;
  @Field() unexpected: boolean;
  @Field(() => String, { nullable: true }) countedBy?: string | null;
  @Field(() => String, { nullable: true }) note?: string | null;
}

@ObjectType('StockCountPermissions')
export class CountCanEntity {
  @Field() count: boolean;
  @Field() submit: boolean;
  @Field() cancel: boolean;
  @Field() retry: boolean;
}

@ObjectType('StockCount')
export class CountEntity {
  @Field() uniqueId: string;
  @Field() number: string;
  @Field(() => CountStatus) status: CountStatus;
  @Field(() => CountScope) scope: CountScope;
  @Field() scopeLabel: string;
  @Field(() => StoreRefEntity) store: StoreRefEntity;
  @Field(() => String, { nullable: true }) note?: string | null;
  @Field() createdBy: string;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) submittedAt?: Date | null;
  @Field(() => Date, { nullable: true }) postedAt?: Date | null;
  @Field(() => String, { nullable: true }) postError?: string | null;
  @Field(() => String, { nullable: true }) approvalRequestUniqueId?:
    string | null;
  @Field(() => Int) lineCount: number;
  @Field(() => Int) countedCount: number;
  @Field(() => Int, { nullable: true }) varianceCount?: number | null;
  @Field(() => [CountLineEntity]) lines: CountLineEntity[];
  @Field(() => CountCanEntity) can: CountCanEntity;
}

@InputType()
export class CreateCountInput {
  @IsString() @Field() storeUniqueId: string;
  @IsEnum(CountScope) @Field(() => CountScope) scope: CountScope;
  @IsOptional()
  @IsArray()
  @Field(() => [String], { nullable: true })
  locationUniqueIds?: string[];
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  categoryUniqueId?: string;
  @IsOptional()
  @Length(0, 500)
  @Field(() => String, { nullable: true })
  note?: string;
}

@InputType()
export class CountEntryInput {
  @IsInt() @Field(() => Int) lineId: number;
  @IsInt() @Min(0) @Field(() => Int) countedQty: number;
  @IsOptional()
  @Length(0, 300)
  @Field(() => String, { nullable: true })
  note?: string;
}

@InputType()
export class RecordCountInput {
  @ValidateNested({ each: true })
  @Type(() => CountEntryInput)
  @Field(() => [CountEntryInput])
  entries: CountEntryInput[];
}

// ── maintenance ──

@ObjectType('MaintenanceAsset')
export class MaintenanceAssetEntity {
  @Field() uniqueId: string;
  @Field() tag: string;
  @Field() productName: string;
  @Field(() => AssetStatus) status: AssetStatus;
  @Field(() => AssetCondition) condition: AssetCondition;
  @Field(() => String, { nullable: true }) storeUniqueId?: string | null;
  @Field(() => String, { nullable: true }) storeName?: string | null;
}

@ObjectType('MaintenancePermissions')
export class MaintenanceCanEntity {
  @Field() start: boolean;
  @Field() sendOut: boolean;
  @Field() complete: boolean;
  @Field() cancel: boolean;
}

@ObjectType('MaintenanceTicket')
export class MaintenanceEntity {
  @Field() uniqueId: string;
  @Field() number: string;
  @Field(() => MaintenanceStatus) status: MaintenanceStatus;
  @Field(() => MaintenanceSource) source: MaintenanceSource;
  @Field() description: string;
  @Field() external: boolean;
  @Field(() => String, { nullable: true }) vendorName?: string | null;
  @Field() underWarranty: boolean;
  @Field() openedBy: string;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) startedAt?: Date | null;
  @Field(() => Date, { nullable: true }) sentOutAt?: Date | null;
  @Field(() => Date, { nullable: true }) backAt?: Date | null;
  @Field(() => Date, { nullable: true }) completedAt?: Date | null;
  @Field(() => String, { nullable: true }) completedBy?: string | null;
  @Field(() => String, { nullable: true }) outcome?: string | null;
  @Field(() => AssetCondition, { nullable: true })
  outcomeCondition?: AssetCondition | null;
  @Field(() => Int, { nullable: true }) downtimeHours?: number | null;
  @Field(() => MaintenanceAssetEntity) asset: MaintenanceAssetEntity;
  @Field(() => MaintenanceCanEntity) can: MaintenanceCanEntity;
}

@InputType()
export class OpenMaintenanceInput {
  @IsString() @Field() assetUniqueId: string;
  @IsEnum(MaintenanceSource)
  @Field(() => MaintenanceSource)
  source: MaintenanceSource;
  @Length(3, 2000) @Field() description: string;
}

@InputType()
export class CompleteMaintenanceInput {
  @Length(3, 2000) @Field() outcome: string;
  @IsEnum(AssetCondition)
  @Field(() => AssetCondition)
  condition: AssetCondition;
  @IsString() @Field() locationUniqueId: string;
}

// ── disposals ──

@ObjectType('DisposalAsset')
export class DisposalAssetEntity {
  @Field() uniqueId: string;
  @Field() tag: string;
  @Field() productName: string;
  @Field(() => AssetStatus) status: AssetStatus;
  @Field(() => AssetCondition) condition: AssetCondition;
  @Field(() => String, { nullable: true }) storeName?: string | null;
  @Field() departmentName: string;
}

@ObjectType('DisposalPermissions')
export class DisposalCanEntity {
  @Field() complete: boolean;
  @Field() cancel: boolean;
}

@ObjectType('Disposal')
export class DisposalEntity {
  @Field() uniqueId: string;
  @Field() number: string;
  @Field(() => DisposalStatus) status: DisposalStatus;
  @Field() reason: string;
  @Field() method: string;
  @Field(() => AssetStatus) previousStatus: AssetStatus;
  @Field() proposedBy: string;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) completedAt?: Date | null;
  @Field(() => String, { nullable: true }) completedBy?: string | null;
  @Field(() => String, { nullable: true }) completionNote?: string | null;
  @Field(() => String, { nullable: true }) approvalRequestUniqueId?:
    string | null;
  @Field(() => DisposalAssetEntity) asset: DisposalAssetEntity;
  @Field(() => DisposalCanEntity) can: DisposalCanEntity;
}

@InputType()
export class ProposeDisposalInput {
  @IsString() @Field() assetUniqueId: string;
  @Length(3, 2000) @Field() reason: string;
  @Length(2, 60)
  @Field({ description: 'scrap, sale, donation, destruction, write-off…' })
  method: string;
}
