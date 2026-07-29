import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';
import { PaginationInput, RequestContext, offsetPaginate } from '@common';
import { PrismaService } from '@prisma';
import { PostRepository } from './post.repository';
import { RedirectRepository } from '../seo/redirect.repository';
import { CreatePostInput, UpdatePostInput } from './dto/post.types';
import { PostFilterInput, buildPostWhere } from './dto/post.filter';

/** Post bodies are author-written HTML — never store what we would not render. */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img',
    'figure',
    'figcaption',
    'h1',
    'h2',
  ]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    a: ['href', 'name', 'target', 'rel'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
};

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

@Injectable()
export class ContentService {
  constructor(
    private readonly posts: PostRepository,
    private readonly redirects: RedirectRepository,
    private readonly prisma: PrismaService,
  ) {}

  private toEntity<T extends { coverImage?: { uri: string } | null }>(post: T) {
    return { ...post, coverImage: post.coverImage?.uri ?? null };
  }

  /** Appends -2, -3 … until the slug is free for that locale. */
  private async uniqueSlug(base: string, locale: string, exceptId?: number) {
    const root = slugify(base);
    if (!root) throw new BadRequestException('errors.invalid_slug');

    let candidate = root;
    let suffix = 2;
    while (await this.posts.slugExists(candidate, locale, exceptId)) {
      candidate = `${root}-${suffix++}`;
    }
    return candidate;
  }

  private async coverImageId(uniqueId?: string) {
    if (!uniqueId) return undefined;
    const file = await this.prisma.db.file.findFirst({
      where: { uniqueId },
      select: { id: true },
    });
    if (!file) throw new NotFoundException('errors.record_not_found');
    return file.id;
  }

  getPosts(filter?: PostFilterInput, pagination?: PaginationInput) {
    const where = buildPostWhere(filter);
    return offsetPaginate(
      async (args) => {
        const rows = await this.posts.findMany({ ...args, where });
        return rows.map((row) => this.toEntity(row));
      },
      () => this.posts.count(where),
      pagination,
    );
  }

  /** Public listing — published posts only. */
  getPublishedPosts(locale?: string, pagination?: PaginationInput) {
    const where = {
      status: 'PUBLISHED' as const,
      ...(locale && { locale }),
    };
    return offsetPaginate(
      async (args) => {
        const rows = await this.posts.findMany({
          ...args,
          where,
          orderBy: { publishedAt: 'desc' },
        });
        return rows.map((row) => this.toEntity(row));
      },
      () => this.posts.count(where),
      pagination,
    );
  }

  async getPostBySlug(slug: string, locale = 'en') {
    const post = await this.posts.findBySlug(slug, locale);
    if (!post || post.status !== 'PUBLISHED') {
      throw new NotFoundException('errors.record_not_found');
    }
    return this.toEntity(post);
  }

  async getPost(uniqueId: string) {
    const post = await this.posts.findByUniqueId(uniqueId);
    if (!post) throw new NotFoundException('errors.record_not_found');
    return this.toEntity(post);
  }

  async createPost(input: CreatePostInput) {
    const locale = input.locale ?? 'en';
    const slug = await this.uniqueSlug(input.slug || input.title, locale);
    const coverImageId = await this.coverImageId(input.coverImageUniqueId);
    const user = RequestContext.getUser();

    const post = await this.posts.create({
      title: input.title,
      slug,
      locale,
      excerpt: input.excerpt,
      bodyHtml: sanitizeHtml(input.bodyHtml, SANITIZE_OPTIONS),
      status: input.status ?? 'DRAFT',
      metaTitle: input.metaTitle,
      metaDescription: input.metaDescription,
      canonicalUrl: input.canonicalUrl,
      noIndex: input.noIndex ?? false,
      ...(input.translationKey && { translationKey: input.translationKey }),
      ...(coverImageId && { coverImage: { connect: { id: coverImageId } } }),
      ...(user && { author: { connect: { id: user.id } } }),
      publishedAt:
        input.publishedAt ??
        (input.status === 'PUBLISHED' ? new Date() : undefined),
    });
    return this.toEntity(post);
  }

  async updatePost(input: UpdatePostInput) {
    const existing = await this.posts.findByUniqueId(input.uniqueId);
    if (!existing) throw new NotFoundException('errors.record_not_found');

    const locale = input.locale ?? existing.locale;
    let slug = existing.slug;
    if (input.slug && slugify(input.slug) !== existing.slug) {
      slug = await this.uniqueSlug(input.slug, locale, existing.id);
      // Preserve the ranking of the old URL instead of leaving a dead link.
      await this.redirects.upsert(`/blog/${existing.slug}`, `/blog/${slug}`);
    }

    const coverImageId = await this.coverImageId(input.coverImageUniqueId);
    const becomingPublished =
      input.status === 'PUBLISHED' && existing.status !== 'PUBLISHED';

    const post = await this.posts.updateByUniqueId(input.uniqueId, {
      ...(input.title && { title: input.title }),
      slug,
      locale,
      ...(input.excerpt !== undefined && { excerpt: input.excerpt }),
      ...(input.bodyHtml && {
        bodyHtml: sanitizeHtml(input.bodyHtml, SANITIZE_OPTIONS),
      }),
      ...(input.status && { status: input.status }),
      ...(input.metaTitle !== undefined && { metaTitle: input.metaTitle }),
      ...(input.metaDescription !== undefined && {
        metaDescription: input.metaDescription,
      }),
      ...(input.canonicalUrl !== undefined && {
        canonicalUrl: input.canonicalUrl,
      }),
      ...(input.noIndex !== undefined && { noIndex: input.noIndex }),
      ...(coverImageId && { coverImage: { connect: { id: coverImageId } } }),
      ...(input.publishedAt && { publishedAt: input.publishedAt }),
      ...(becomingPublished &&
        !input.publishedAt && { publishedAt: new Date() }),
    });
    return this.toEntity(post);
  }

  async deletePost(uniqueId: string) {
    await this.getPost(uniqueId);
    await this.posts.softDelete(uniqueId);
  }
}
