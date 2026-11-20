import { Field, InputType } from '@nestjs/graphql';
import { IsBoolean, IsJSON, IsOptional, IsString } from 'class-validator';

@InputType()
export class UpdatePolicySettingInput {
  @IsString()
  @Field(() => String)
  code: string;

  @IsOptional()
  @IsBoolean()
  @Field(() => Boolean, { nullable: true })
  enabled?: boolean;

  @IsOptional()
  @IsJSON()
  @Field(() => String, { nullable: true, description: 'JSON object' })
  parameters?: string;
}
