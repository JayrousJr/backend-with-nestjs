import { Field, InputType, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsOptional } from 'class-validator';
import { Prisma } from '@db';
import { BaseFilterInput, OrderDirection, buildBaseWhere } from '@common';
import { i18nValidationMessage } from 'nestjs-i18n';

export enum FileOrderField {
  FILENAME = 'filename',
  SIZE = 'size',
  CREATED_AT = 'createdAt',
}

registerEnumType(FileOrderField, { name: 'FileOrderField' });

@InputType()
export class FileFilterInput extends BaseFilterInput {
  @IsOptional()
  @Field(() => String, { nullable: true })
  filename?: string;

  @IsOptional()
  @Field(() => String, { nullable: true })
  mimeType?: string;
}

@InputType()
export class FileOrderInput {
  @IsEnum(FileOrderField, {
    message: i18nValidationMessage('validation.isEnum'),
  })
  @Field(() => FileOrderField, { defaultValue: FileOrderField.CREATED_AT })
  field: FileOrderField = FileOrderField.CREATED_AT;

  @IsEnum(OrderDirection, {
    message: i18nValidationMessage('validation.isEnum'),
  })
  @Field(() => OrderDirection, { defaultValue: OrderDirection.DESC })
  direction: OrderDirection = OrderDirection.DESC;
}

export function buildFileWhere(
  filter?: FileFilterInput,
): Prisma.FileWhereInput {
  return {
    ...buildBaseWhere(filter),
    ...(filter?.filename && {
      filename: { contains: filter.filename, mode: 'insensitive' },
    }),
    ...(filter?.mimeType && {
      mimeType: { contains: filter.mimeType, mode: 'insensitive' },
    }),
  };
}

export function buildFileOrderBy(
  orderBy?: FileOrderInput,
): Prisma.FileOrderByWithRelationInput {
  if (!orderBy) return { createdAt: 'desc' };
  const direction = orderBy.direction === OrderDirection.ASC ? 'asc' : 'desc';
  return { [orderBy.field]: direction };
}
