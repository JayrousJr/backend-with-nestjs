import {
  Field,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequestStatus,
  ApproverType,
  ChainVersionStatus,
} from '@db';

registerEnumType(ApproverType, { name: 'ApproverType' });
registerEnumType(ApprovalMode, { name: 'ApprovalMode' });
registerEnumType(ApprovalDecision, { name: 'ApprovalDecision' });
registerEnumType(ApprovalRequestStatus, { name: 'ApprovalRequestStatus' });
registerEnumType(ChainVersionStatus, { name: 'ChainVersionStatus' });

@ObjectType('ApprovalStepConfig')
export class StepConfigEntity {
  @Field(() => Int) order: number;
  @Field() code: string;
  @Field() name: string;
  @Field(() => ApproverType) approverType: ApproverType;
  @Field(() => String, { nullable: true }) approverUniqueId?: string | null;
  @Field() approverLabel: string;
  @Field(() => String, { nullable: true }) rule?: string | null;
  @Field(() => ApprovalMode) mode: ApprovalMode;
  @Field(() => Int) requiredCount: number;
  @Field() allowDelegation: boolean;
  @Field(() => String, { nullable: true }) condition?: string | null;
  @Field(() => Int, { nullable: true }) slaHours?: number | null;
}

@ObjectType('ApprovalChainVersion')
export class ChainVersionEntity {
  @Field() uniqueId: string;
  @Field(() => Int) version: number;
  @Field(() => ChainVersionStatus) status: ChainVersionStatus;
  @Field(() => Date, { nullable: true }) activatedAt?: Date | null;
  @Field() createdAt: Date;
  @Field(() => [StepConfigEntity]) steps: StepConfigEntity[];
}

@ObjectType('ApprovalPointSummary')
export class PointSummaryEntity {
  @Field() code: string;
  @Field() module: string;
  @Field() name: string;
  @Field() description: string;
  @Field() registered: boolean;
  @Field(() => ChainVersionEntity, { nullable: true })
  activeVersion?: ChainVersionEntity | null;
  @Field() hasDraft: boolean;
  @Field(() => Int) pendingRequests: number;
}

@ObjectType('ApprovalPoint')
export class PointEntity {
  @Field() code: string;
  @Field() module: string;
  @Field() name: string;
  @Field() description: string;
  @Field(() => [ChainVersionEntity]) versions: ChainVersionEntity[];
}

@ObjectType('AssigneeRule')
export class AssigneeRuleEntity {
  @Field() code: string;
  @Field() description: string;
}

@ObjectType('ApprovalPerson')
export class PersonEntity {
  @Field() uniqueId: string;
  @Field() fullName: string;
  @Field() email: string;
}

@ObjectType('ApprovalStepState')
export class StepStateEntity {
  @Field(() => Int) order: number;
  @Field() name: string;
  @Field(() => ApprovalMode) mode: ApprovalMode;
  @Field(() => Int) requiredCount: number;
  @Field({ description: 'CURRENT | DONE | SKIPPED | WAITING | NOT_REACHED' })
  state: string;
}

@ObjectType('ApprovalActionEntry')
export class ActionEntity {
  @Field(() => ApprovalDecision) decision: ApprovalDecision;
  @Field(() => String, { nullable: true }) stepName?: string | null;
  @Field(() => String, { nullable: true }) comment?: string | null;
  @Field() at: Date;
  @Field(() => PersonEntity, { nullable: true }) user?: PersonEntity | null;
  @Field(() => PersonEntity, { nullable: true })
  onBehalfOf?: PersonEntity | null;
}

@ObjectType('ApprovalRequest')
export class RequestEntity {
  @Field() uniqueId: string;
  @Field() pointCode: string;
  @Field() pointName: string;
  @Field() title: string;
  @Field() subjectType: string;
  @Field() subjectId: string;
  @Field(() => ApprovalRequestStatus) status: ApprovalRequestStatus;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) completedAt?: Date | null;
  @Field(() => PersonEntity, { nullable: true })
  requester?: PersonEntity | null;
  @Field(() => String, { nullable: true }) currentStep?: string | null;
  @Field(() => [StepStateEntity]) steps: StepStateEntity[];
  @Field(() => [PersonEntity]) assignees: PersonEntity[];
  @Field({ description: 'Pending but nobody can decide the step' })
  noApprover: boolean;
  @Field(() => [ActionEntity]) actions: ActionEntity[];
  @Field() canDecide: boolean;
}

@InputType()
export class StepInput {
  @Length(1, 60) @Field() code: string;
  @Length(1, 120) @Field() name: string;
  @IsEnum(ApproverType) @Field(() => ApproverType) approverType: ApproverType;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  approverUniqueId?: string;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  rule?: string;
  @IsEnum(ApprovalMode) @Field(() => ApprovalMode) mode: ApprovalMode;
  @IsOptional()
  @IsInt()
  @Min(1)
  @Field(() => Int, { nullable: true })
  requiredCount?: number;
  @IsBoolean() @Field() allowDelegation: boolean;
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  condition?: string;
  @IsOptional()
  @IsInt()
  @Min(1)
  @Field(() => Int, { nullable: true })
  slaHours?: number;
}

@InputType()
export class SaveChainInput {
  @IsString() @Field() pointCode: string;
  @ValidateNested({ each: true })
  @Type(() => StepInput)
  @Field(() => [StepInput])
  steps: StepInput[];
}

@InputType()
export class DecideApprovalInput {
  @IsString() @Field() uniqueId: string;
  @IsIn(['APPROVE', 'REJECT', 'RETURN', 'COMMENT'])
  @Field(() => ApprovalDecision)
  decision: 'APPROVE' | 'REJECT' | 'RETURN' | 'COMMENT';
  @IsOptional()
  @Length(0, 2000)
  @Field(() => String, { nullable: true })
  comment?: string;
}
