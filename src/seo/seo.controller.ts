import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '@common';
import { SeoService } from './seo.service';

/**
 * Crawler-facing endpoints. Served from the API so the sitemap always reflects
 * live content; point your CDN/nginx at these for /sitemap.xml and /robots.txt.
 */
@ApiTags('seo')
@Controller()
export class SeoController {
  constructor(private readonly seoService: SeoService) {}

  @Public()
  @Get('sitemap.xml')
  @Header('Content-Type', 'application/xml')
  @Header('Cache-Control', 'public, max-age=3600')
  sitemap() {
    return this.seoService.buildSitemap();
  }

  @Public()
  @Get('robots.txt')
  @Header('Content-Type', 'text/plain')
  @Header('Cache-Control', 'public, max-age=86400')
  robots() {
    return this.seoService.buildRobotsTxt();
  }
}
