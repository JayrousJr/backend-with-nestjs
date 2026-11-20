import { Field, Int, ObjectType } from '@nestjs/graphql';

@ObjectType('PolicySetting')
export class PolicySettingEntity {
  @Field(() => String)
  code: string;

  @Field(() => String, { description: 'SOD or SECURITY' })
  category: string;

  @Field(() => String)
  description: string;

  @Field(() => Boolean)
  enabled: boolean;

  @Field(() => String, { nullable: true, description: 'JSON parameters' })
  parameters?: string | null;

  @Field(() => Int)
  version: number;

  @Field(() => Date)
  updatedAt: Date;
}
