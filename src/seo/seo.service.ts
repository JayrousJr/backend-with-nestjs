import { Injectable } from '@nestjs/common';
import { AppConfigService } from '@config';
import { PaginationInput, offsetPaginate } from '@common';
import { PostRepository } from '../content/post.repository';
import { RedirectRepository } from './redirect.repository';
import { CreateRedirectInput } from './dto/redirect.types';

/** Routes the SPA serves that are always indexable, with their priority. */
const STATIC_ROUTES: { path: string; priority: number; changefreq: string }[] =
  [
    { path: '/', priority: 1.0, changefreq: 'weekly' },
    { path: '/blog', priority: 0.8, changefreq: 'daily' },
  ];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

@Injectable()
export class SeoService {
  constructor(
    private readonly posts: PostRepository,
    private readonly redirects: RedirectRepository,
    private readonly config: AppConfigService,
  ) {}

  private get siteUrl(): string {
    return this.config.frontendUrl.replace(/\/$/, '');
  }

  /**
   * Sitemap of everything crawlable: the static public routes plus published,
   * indexable posts. Translations of the same post are emitted as xhtml:link
   * alternates so search engines can serve the right locale.
   */
  async buildSitemap(): Promise<string> {
    const posts = await this.posts.findIndexable();

    const byTranslation = new Map<string, { slug: string; locale: string }[]>();
    for (const post of posts) {
      const group = byTranslation.get(post.translationKey) ?? [];
      group.push({ slug: post.slug, locale: post.locale });
      byTranslation.set(post.translationKey, group);
    }

    const urls: string[] = STATIC_ROUTES.map(
      ({ path, priority, changefreq }) => `  <url>
    <loc>${escapeXml(this.siteUrl + path)}</loc>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority.toFixed(1)}</priority>
  </url>`,
    );

    for (const post of posts) {
      const alternates = (byTranslation.get(post.translationKey) ?? [])
        .map(
          (alt) =>
            `    <xhtml:link rel="alternate" hreflang="${alt.locale}" href="${escapeXml(
              `${this.siteUrl}/blog/${alt.slug}`,
            )}" />`,
        )
        .join('\n');

      urls.push(`  <url>
    <loc>${escapeXml(`${this.siteUrl}/blog/${post.slug}`)}</loc>
    <lastmod>${(post.publishedAt ?? post.updatedAt).toISOString()}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
${alternates}
  </url>`);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>`;
  }

  /** Only the public surface is crawlable; everything authenticated is denied. */
  buildRobotsTxt(): string {
    return [
      'User-agent: *',
      'Allow: /',
      'Disallow: /dashboard',
      'Disallow: /settings',
      'Disallow: /users',
      'Disallow: /roles',
      'Disallow: /campaigns',
      'Disallow: /subscribers',
      'Disallow: /visitors',
      'Disallow: /auth/',
      '',
      `Sitemap: ${this.config.sitemapUrl}`,
      '',
    ].join('\n');
  }

  /** Looks up a moved URL; counts the hit so dead redirects can be pruned. */
  async resolveRedirect(path: string) {
    const redirect = await this.redirects.findByPath(path);
    if (!redirect) return null;
    await this.redirects.recordHit(redirect.id);
    return { toPath: redirect.toPath, statusCode: redirect.statusCode };
  }

  getRedirects(pagination?: PaginationInput) {
    return offsetPaginate(
      (args) => this.redirects.findMany(args),
      () => this.redirects.count(),
      pagination,
    );
  }

  createRedirect(input: CreateRedirectInput) {
    return this.redirects.upsert(
      input.fromPath,
      input.toPath,
      input.statusCode ?? 301,
    );
  }

  async deleteRedirect(uniqueId: string) {
    await this.redirects.softDelete(uniqueId);
  }
}
