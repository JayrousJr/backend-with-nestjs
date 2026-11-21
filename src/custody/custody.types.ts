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
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import {
  AckMethod,
  AssetCondition,
  AssetReportStatus,
  AssetReportType,
  AssetStatus,
  CustodyTransferStatus,
  HandoverSource,
  HandoverStatus,
  ResponsibilityDecision,
  ReturnStatus,
} from '@db';
import { StoreRefEntity } from '../store/store.types';
import { RequestEmployeeEntity } from '../requests/requests.types';

registerEnumType(HandoverStatus, { name: 'HandoverStatus' });
registerEnumType(HandoverSource, { name: 'HandoverSource' });
registerEnumType(AckMethod, { name: 'AckMethod' });
registerEnumType(ReturnStatus, { name: 'ReturnStatus' });
registerEnumType(AssetReportType, { name: 'AssetReportType' });
registerEnumType(AssetReportStatus, { name: 'AssetReportStatus' });
registerEnumType(ResponsibilityDecision, { name: 'ResponsibilityDecision' });
registerEnumType(CustodyTransferStatus, { name: 'CustodyTransferStatus' });

@ObjectType('FileRef')
export class FileRefEntity {
  @Field() uniqueId: string;
  @Field() filename: string;
  @Field() uri: string;
}

@ObjectType('HandoverLine')
export class HandoverLineEntity {
  @Field() assetUniqueId: string;
  @Field() tag: string;
  @Field() productName: string;
  @Field(() => String, { nullable: true }) serialNumber?: string | null;
  @Field(() => AssetCondition) condition: AssetCondition;
  @Field(() => [String]) accessories: string[];
  @Field(() => [String]) components: string[];
  @Field(() => [FileRefEntity]) photos: FileRefEntity[];
  @Field(() => Date, { nullable: true }) returnedAt?: Date | null;
}

@ObjectType('HandoverPermissions')
export class HandoverCanEntity {
  @Field() acknowledge: boolean;
  @Field() dispute: boolean;
  @Field() sendLink: boolean;
  @Field() counterCode: boolean;
  @Field() resolveDispute: boolean;
  @Field() cancel: boolean;
}

@ObjectType('Handover')
export class HandoverEntity {
  @Field() uniqueId: string;
  @Field() number: string;
  @Field(() => HandoverStatus) status: HandoverStatus;
  @Field(() => HandoverSource) source: HandoverSource;
  @Field(() => String, { nullable: true }) sourceRef?: string | null;
  @Field(() => String, { nullable: true }) internalRequestUniqueId?:
    string | null;
  @Field(() => RequestEmployeeEntity) custodian: RequestEmployeeEntity;
  @Field() custodianHasUser: boolean;
  @Field(() => StoreRefEntity, { nullable: true })
  department?: StoreRefEntity | null;
  @Field(() => StoreRefEntity) store: StoreRefEntity;
  @Field() purpose: string;
  @Field(() => Date, { nullable: true }) expectedReturnDate?: Date | null;
  @Field(() => String, { nullable: true }) termsText?: string | null;
  @Field(() => String, { nullable: true }) preparedBy?: string | null;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) acknowledgedAt?: Date | null;
  @Field(() => AckMethod, { nullable: true }) ackMethod?: AckMethod | null;
  @Field(() => String, { nullable: true }) ackBy?: string | null;
  @Field(() => String, { nullable: true }) disputeNote?: string | null;
  @Field(() => String, { nullable: true }) cancelReason?: string | null;
  @Field(() => [HandoverLineEntity]) lines: HandoverLineEntity[];
  @Field(() => HandoverCanEntity) can: HandoverCanEntity;
}

@ObjectType('AckDelivery')
export class AckDeliveryEntity {
  @Field() sent: boolean;
  @Field(() => String, {
    nullable: true,
    description: 'Development only (no mail server)',
  })
  devLink?: string | null;
  @Field(() => String, {
    nullable: true,
    description: 'Development only (no mail server)',
  })
  devCode?: string | null;
}

@InputType()
export class HandoverLineInput {
  @IsString() @Field() assetUniqueId: string;
  @IsOptional()
  @IsArray()
  @Field(() => [String], { nullable: true })
  accessories?: string[];
  @IsOptional()
  @IsArray()
  @Field(() => [String], { nullable: true })
  photoFileUniqueIds?: string[];
}

@InputType()
export class PrepareHandoverInput {
  @IsString() @Field() storeUniqueId: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  internalRequestUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  custodyTransferUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, {
    nullable: true,
    description: 'Temporary replacement for this report',
  })
  assetReportUniqueId?: string;
  @Length(3, 500) @Field() purpose: string;
  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  expectedReturnDate?: string;
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => HandoverLineInput)
  @Field(() => [HandoverLineInput])
  lines: HandoverLineInput[];
}

// ── custody views ──

@ObjectType('CustodyItem')
export class CustodyItemEntity {
  @Field() assetUniqueId: string;
  @Field() tag: string;
  @Field() productName: string;
  @Field() categoryName: string;
  @Field(() => String, { nullable: true }) serialNumber?: string | null;
  @Field(() => AssetStatus) status: AssetStatus;
  @Field(() => AssetCondition) condition: AssetCondition;
  @Field() isComponent: boolean;
  @Field(() => RequestEmployeeEntity) custodian: RequestEmployeeEntity;
  @Field() departmentName: string;
  @Field(() => String, { nullable: true }) handoverUniqueId?: string | null;
  @Field(() => String, { nullable: true }) handoverNumber?: string | null;
  @Field() acknowledged: boolean;
  @Field(() => Date, { nullable: true }) expectedReturnDate?: Date | null;
  @Field() overdue: boolean;
  @Field() from: Date;
  @Field(() => Date, { nullable: true }) to?: Date | null;
  @Field(() => String, { nullable: true }) endReason?: string | null;
  @Field(() => Date, { nullable: true }) lastInspection?: Date | null;
  @Field(() => Date, { nullable: true }) nextInspection?: Date | null;
  @Field(() => Int) openReports: number;
}

// ── returns ──

@ObjectType('AssetReturnLine')
export class ReturnLineEntity {
  @Field() assetUniqueId: string;
  @Field() tag: string;
  @Field() productName: string;
  @Field() isKit: boolean;
  @Field() received: boolean;
  @Field(() => AssetCondition, { nullable: true })
  condition?: AssetCondition | null;
  @Field(() => [String]) accessoriesReturned: string[];
  @Field(() => String, { nullable: true }) missing?: string | null;
  @Field(() => String, { nullable: true }) note?: string | null;
}

@ObjectType('AssetReturn')
export class ReturnEntity {
  @Field() uniqueId: string;
  @Field() number: string;
  @Field(() => ReturnStatus) status: ReturnStatus;
  @Field() trigger: string;
  @Field(() => String, { nullable: true }) reason?: string | null;
  @Field(() => RequestEmployeeEntity) custodian: RequestEmployeeEntity;
  @Field(() => StoreRefEntity, { nullable: true })
  store?: StoreRefEntity | null;
  @Field(() => String, { nullable: true }) requestedBy?: string | null;
  @Field(() => String, { nullable: true }) receivedBy?: string | null;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) receivedAt?: Date | null;
  @Field(() => [ReturnLineEntity]) lines: ReturnLineEntity[];
}

@InputType()
export class RequestReturnInput {
  @ArrayMinSize(1) @IsArray() @Field(() => [String]) assetUniqueIds: string[];
  @Length(3, 1000) @Field() reason: string;
  @IsOptional()
  @IsBoolean()
  @Field(() => Boolean, {
    nullable: true,
    description: 'Recall by store / owning department',
  })
  recall?: boolean;
}

@InputType()
export class ReceiveReturnLineInput {
  @IsString() @Field() assetUniqueId: string;
  @IsEnum(AssetCondition)
  @Field(() => AssetCondition)
  condition: AssetCondition;
  @IsString() @Field() locationUniqueId: string;
  @IsOptional()
  @IsArray()
  @Field(() => [String], { nullable: true })
  accessoriesReturned?: string[];
  @IsOptional()
  @Length(0, 500)
  @Field(() => String, { nullable: true })
  missing?: string;
  @IsOptional()
  @IsArray()
  @Field(() => [String], { nullable: true })
  photoFileUniqueIds?: string[];
  @IsOptional()
  @Length(0, 500)
  @Field(() => String, { nullable: true })
  note?: string;
}

@InputType()
export class ReceiveReturnInput {
  @IsString() @Field() storeUniqueId: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  returnUniqueId?: string;
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveReturnLineInput)
  @Field(() => [ReceiveReturnLineInput])
  lines: ReceiveReturnLineInput[];
}

// ── reports ──

@ObjectType('AssetReportAsset')
export class ReportAssetEntity {
  @Field() uniqueId: string;
  @Field() tag: string;
  @Field() productName: string;
  @Field(() => AssetStatus) status: AssetStatus;
  @Field(() => AssetCondition) condition: AssetCondition;
}

@ObjectType('AssetReport')
export class AssetReportEntity {
  @Field() uniqueId: string;
  @Field() number: string;
  @Field(() => AssetReportType) type: AssetReportType;
  @Field(() => AssetReportStatus) status: AssetReportStatus;
  @Field(() => ReportAssetEntity) asset: ReportAssetEntity;
  @Field(() => String, { nullable: true }) custodian?: string | null;
  @Field() occurredAt: Date;
  @Field() circumstances: string;
  @Field() stillUsable: boolean;
  @Field() automatic: boolean;
  @Field(() => String, { nullable: true }) reportedBy?: string | null;
  @Field() createdAt: Date;
  @Field(() => String, { nullable: true }) maintenanceTicketUniqueId?:
    string | null;
  @Field(() => String, { nullable: true }) lossApprovalUniqueId?: string | null;
  @Field(() => ResponsibilityDecision, { nullable: true })
  responsibility?: ResponsibilityDecision | null;
  @Field(() => String, { nullable: true }) responsibilityReason?: string | null;
  @Field(() => String, { nullable: true }) responsibilityStatus?: string | null;
  @Field(() => String, { nullable: true }) responsibilityApprovalUniqueId?:
    string | null;
  @Field() canDecideResponsibility: boolean;
}

@InputType()
export class CreateAssetReportInput {
  @IsString() @Field() assetUniqueId: string;
  @IsEnum(AssetReportType) @Field(() => AssetReportType) type: AssetReportType;
  @IsDateString() @Field() occurredAt: string;
  @Length(3, 2000) @Field() circumstances: string;
  @IsBoolean() @Field() stillUsable: boolean;
  @IsOptional()
  @IsArray()
  @Field(() => [String], { nullable: true })
  fileUniqueIds?: string[];
}

@InputType()
export class InspectionInput {
  @IsString() @Field() assetUniqueId: string;
  @IsEnum(AssetCondition)
  @Field(() => AssetCondition)
  condition: AssetCondition;
  @IsOptional()
  @Length(0, 2000)
  @Field(() => String, { nullable: true })
  remarks?: string;
}

// ── custody transfers ──

@ObjectType('CustodyTransferAsset')
export class TransferAssetEntity {
  @Field() uniqueId: string;
  @Field() tag: string;
  @Field() productName: string;
  @Field(() => AssetStatus) status: AssetStatus;
}

@ObjectType('CustodyTransfer')
export class CustodyTransferEntity {
  @Field() uniqueId: string;
  @Field() number: string;
  @Field(() => CustodyTransferStatus) status: CustodyTransferStatus;
  @Field(() => RequestEmployeeEntity) from: RequestEmployeeEntity;
  @Field(() => RequestEmployeeEntity) to: RequestEmployeeEntity;
  @Field() reason: string;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) completedAt?: Date | null;
  @Field(() => String, { nullable: true }) approvalRequestUniqueId?:
    string | null;
  @Field(() => [TransferAssetEntity]) assets: TransferAssetEntity[];
}

@InputType()
export class RequestCustodyTransferInput {
  @ArrayMinSize(1) @IsArray() @Field(() => [String]) assetUniqueIds: string[];
  @IsString() @Field() toEmployeeUniqueId: string;
  @Length(3, 1000) @Field() reason: string;
}

export const RESOLVE_ACTIONS = ['RESEND', 'CANCEL'] as const;
export class ResolveGuard {
  @IsIn(RESOLVE_ACTIONS) action: (typeof RESOLVE_ACTIONS)[number];
}
