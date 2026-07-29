import { BaseEntity } from '@common';
import { ObjectType, Field, registerEnumType } from '@nestjs/graphql';
import { PostStatus } from '@db';

registerEnumType(PostStatus, { name: 'PostStatus' });

@ObjectType()
export class PostEntity extends BaseEntity {
  @Field(() => String)
  slug: string;

  @Field(() => String)
  title: string;

  @Field(() => String, { nullable: true })
  excerpt?: string | null;

  @Field(() => String)
  bodyHtml: string;

  @Field(() => PostStatus)
  status: PostStatus;

  @Field(() => String)
  locale: string;

  @Field(() => String, {
    description: 'Shared by translations of the same article (hreflang groups)',
  })
  translationKey: string;

  @Field(() => Date, { nullable: true })
  publishedAt?: Date | null;

  @Field(() => String, { nullable: true })
  metaTitle?: string | null;

  @Field(() => String, { nullable: true })
  metaDescription?: string | null;

  @Field(() => String, { nullable: true })
  canonicalUrl?: string | null;

  @Field(() => Boolean)
  noIndex: boolean;

  @Field(() => String, {
    nullable: true,
    description: 'Cover image URI, resolved from the linked file',
  })
  coverImage?: string | null;
}
