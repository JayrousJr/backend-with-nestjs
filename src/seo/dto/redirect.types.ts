import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, Matches } from 'class-validator';
import { MutationResponse, QueryListResponse } from '@common';
import { i18nValidationMessage } from 'nestjs-i18n';
import { RedirectEntity } from '../entities/redirect.entity';

@InputType()
export class CreateRedirectInput {
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Matches(/^\//, { message: i18nValidationMessage('validation.isPath') })
  @Field(() => String, { description: 'Source path, e.g. /blog/old-slug' })
  fromPath?: string;

  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String)
  toPath?: string;

  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Field(() => Int, { nullable: true, defaultValue: 301 })
  statusCode?: number;
}

@ObjectType()
export class RedirectMutationResponse extends MutationResponse(
  RedirectEntity,
) {}

@ObjectType()
export class RedirectListResponse extends QueryListResponse(RedirectEntity) {}

@ObjectType()
export class ResolvedRedirect {
  @Field(() => String)
  toPath?: string;

  @Field(() => Int)
  statusCode?: number;
}
