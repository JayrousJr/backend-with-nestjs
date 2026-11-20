import { Field, ObjectType } from '@nestjs/graphql';
import { QueryListResponse } from '@common';

@ObjectType('AuditActor')
export class AuditActorEntity {
  @Field(() => String)
  uniqueId: string;

  @Field(() => String)
  email: string;

  @Field(() => String)
  fullName: string;
}

@ObjectType('AuditLogEntry')
export class AuditLogEntity {
  @Field(() => String)
  id: string;

  @Field(() => Date)
  at: Date;

  @Field(() => AuditActorEntity, { nullable: true })
  actor?: AuditActorEntity | null;

  @Field(() => AuditActorEntity, { nullable: true })
  onBehalfOf?: AuditActorEntity | null;

  @Field(() => String)
  action: string;

  @Field(() => String)
  entityType: string;

  @Field(() => String, { nullable: true })
  entityId?: string | null;

  @Field(() => String, { nullable: true, description: 'JSON' })
  before?: string | null;

  @Field(() => String, { nullable: true, description: 'JSON' })
  after?: string | null;

  @Field(() => String, { nullable: true })
  ipAddress?: string | null;
}

@ObjectType()
export class AuditLogListResponse extends QueryListResponse(AuditLogEntity) {}
