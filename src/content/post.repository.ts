import { BaseRepository } from '@common';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@prisma';
import { Prisma } from '@db';

const POST_INCLUDE = { coverImage: { select: { uri: true } } } as const;

@Injectable()
export class PostRepository extends BaseRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  protected get delegate() {
    return this.prisma.db.post;
  }

  async create(data: Prisma.PostCreateInput) {
    return this.execute(this.delegate.create({ data, include: POST_INCLUDE }));
  }

  async findMany(args: {
    where?: Prisma.PostWhereInput;
    orderBy?: Prisma.PostOrderByWithRelationInput;
    skip?: number;
    take?: number;
  }) {
    return this.execute(
      this.delegate.findMany({
        ...args,
        orderBy: args.orderBy ?? { createdAt: 'desc' },
        include: POST_INCLUDE,
      }),
    );
  }

  async count(where?: Prisma.PostWhereInput) {
    return this.execute(this.delegate.count({ where }));
  }

  async findByUniqueId(uniqueId: string) {
    return this.execute(
      this.delegate.findFirst({ where: { uniqueId }, include: POST_INCLUDE }),
    );
  }

  async findBySlug(slug: string, locale: string) {
    return this.execute(
      this.delegate.findFirst({
        where: { slug, locale },
        include: POST_INCLUDE,
      }),
    );
  }

  /** Sibling translations, used to emit hreflang alternates. */
  async findTranslations(translationKey: string) {
    return this.execute(
      this.delegate.findMany({
        where: { translationKey, status: 'PUBLISHED' },
        select: { slug: true, locale: true },
      }),
    );
  }

  async slugExists(slug: string, locale: string, exceptId?: number) {
    const found = await this.execute(
      this.delegate.findFirst({
        where: { slug, locale, ...(exceptId && { NOT: { id: exceptId } }) },
        select: { id: true },
      }),
    );
    return Boolean(found);
  }

  async updateByUniqueId(uniqueId: string, data: Prisma.PostUpdateInput) {
    return this.execute(
      this.delegate.update({
        where: { uniqueId },
        data,
        include: POST_INCLUDE,
      }),
    );
  }

  /** Every indexable post, for the sitemap. */
  async findIndexable() {
    return this.execute(
      this.delegate.findMany({
        where: { status: 'PUBLISHED', noIndex: false },
        select: {
          slug: true,
          locale: true,
          translationKey: true,
          updatedAt: true,
          publishedAt: true,
        },
        orderBy: { publishedAt: 'desc' },
      }),
    );
  }
}
