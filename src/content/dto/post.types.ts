import { Field, InputType } from '@nestjs/graphql';
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PostStatus } from '@db';
import { i18nValidationMessage } from 'nestjs-i18n';

@InputType()
export class CreatePostInput {
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String)
  title: string;

  /** Optional — derived from the title when omitted. */
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String, { nullable: true })
  slug?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String, { nullable: true })
  excerpt?: string;

  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String)
  bodyHtml: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String, { nullable: true })
  locale?: string;

  /** Link this post as a translation of an existing one. */
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String, { nullable: true })
  translationKey?: string;

  @IsOptional()
  @IsEnum(PostStatus, { message: i18nValidationMessage('validation.isEnum') })
  @Field(() => PostStatus, { nullable: true })
  status?: PostStatus;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(70, { message: i18nValidationMessage('validation.maxLength') })
  @Field(() => String, { nullable: true })
  metaTitle?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(160, { message: i18nValidationMessage('validation.maxLength') })
  @Field(() => String, { nullable: true })
  metaDescription?: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String, { nullable: true })
  canonicalUrl?: string;

  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @Field(() => Boolean, { nullable: true })
  noIndex?: boolean;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String, { nullable: true })
  coverImageUniqueId?: string;

  @IsOptional()
  @IsDate({ message: i18nValidationMessage('validation.isDate') })
  @Field(() => Date, { nullable: true })
  publishedAt?: Date;
}

@InputType()
export class UpdatePostInput extends CreatePostInput {
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String)
  uniqueId: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String, { nullable: true })
  declare title: string;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String, { nullable: true })
  declare bodyHtml: string;
}
