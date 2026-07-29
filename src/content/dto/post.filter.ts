import { Field, InputType } from '@nestjs/graphql';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { Prisma, PostStatus } from '@db';
import { i18nValidationMessage } from 'nestjs-i18n';

@InputType()
export class PostFilterInput {
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String, { nullable: true })
  search?: string;

  @IsOptional()
  @IsEnum(PostStatus, { message: i18nValidationMessage('validation.isEnum') })
  @Field(() => PostStatus, { nullable: true })
  status?: PostStatus;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Field(() => String, { nullable: true })
  locale?: string;
}

export function buildPostWhere(
  filter?: PostFilterInput,
): Prisma.PostWhereInput {
  return {
    ...(filter?.status && { status: filter.status }),
    ...(filter?.locale && { locale: filter.locale }),
    ...(filter?.search && {
      OR: [
        { title: { contains: filter.search, mode: 'insensitive' as const } },
        { slug: { contains: filter.search, mode: 'insensitive' as const } },
      ],
    }),
  };
}
