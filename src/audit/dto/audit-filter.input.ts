import { Field, InputType } from '@nestjs/graphql';
import { IsOptional, IsString } from 'class-validator';
import { DateRangeInput } from '@common';

@InputType()
export class AuditFilterInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  entityType?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  entityId?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true, description: 'Prefix match' })
  action?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true, description: 'Actor user uniqueId' })
  actorUniqueId?: string;

  @IsOptional()
  @Field(() => DateRangeInput, { nullable: true })
  at?: DateRangeInput;
}
