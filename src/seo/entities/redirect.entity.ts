import { BaseEntity } from '@common';
import { ObjectType, Field, Int } from '@nestjs/graphql';

@ObjectType()
export class RedirectEntity extends BaseEntity {
  @Field(() => String)
  fromPath: string;

  @Field(() => String)
  toPath: string;

  @Field(() => Int)
  statusCode: number;

  @Field(() => Int, { description: 'How often this redirect has been served' })
  hitCount: number;
}
