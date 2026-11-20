import {
  Field,
  Float,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { RoleContextType, Scope } from '@db';
import { BaseEntity, QueryListResponse } from '@common';

registerEnumType(Scope, { name: 'Scope' });
registerEnumType(RoleContextType, { name: 'RoleContextType' });

@ObjectType('Permission')
export class PermissionEntity {
  @Field(() => String)
  code: string;

  @Field(() => String)
  module: string;

  @Field(() => String)
  description: string;

  @Field(() => [Scope])
  allowedScopes: Scope[];

  @Field(() => Boolean)
  isActive: boolean;
}

@ObjectType('RoleGrant')
export class RoleGrantEntity {
  @Field(() => String)
  permissionCode: string;

  @Field(() => Scope)
  scope: Scope;

  @Field(() => Float, { nullable: true })
  valueLimit?: number | null;
}

@ObjectType('Role')
export class RoleEntity extends BaseEntity {
  @Field(() => String)
  name: string;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field(() => RoleContextType, {
    nullable: true,
    description: 'STORE / DEPARTMENT roles are assigned per context',
  })
  contextType?: RoleContextType | null;

  @Field(() => [RoleGrantEntity])
  grants: RoleGrantEntity[];

  @Field(() => Int)
  userCount: number;
}

@ObjectType()
export class RoleListResponse extends QueryListResponse(RoleEntity) {}

@ObjectType('GroupMember')
export class GroupMemberEntity {
  @Field(() => String)
  userUniqueId: string;

  @Field(() => String)
  email: string;

  @Field(() => String)
  fullName: string;

  @Field(() => String)
  departmentName: string;
}

@ObjectType('UserGroup')
export class UserGroupEntity extends BaseEntity {
  @Field(() => String)
  code: string;

  @Field(() => String)
  name: string;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field(() => [GroupMemberEntity])
  members: GroupMemberEntity[];

  @Field(() => [RoleEntity])
  roles: RoleEntity[];
}

@ObjectType('EffectiveGrant')
export class EffectiveGrantEntity {
  @Field(() => String)
  permission: string;

  @Field(() => Scope)
  scope: Scope;

  @Field(() => RoleContextType, { nullable: true })
  contextType?: RoleContextType | null;

  @Field(() => Int, { nullable: true })
  contextId?: number | null;

  @Field(() => Boolean)
  delegated: boolean;
}
