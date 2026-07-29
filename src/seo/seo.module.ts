import { Module } from '@nestjs/common';
import { SeoService } from './seo.service';
import { SeoController } from './seo.controller';
import { SeoResolver } from './seo.resolver';
import { RedirectRepository } from './redirect.repository';
import { PostRepository } from '../content/post.repository';

// PostRepository is provided here directly (rather than importing ContentModule)
// to avoid a circular import: content needs redirects for slug changes.
@Module({
  providers: [SeoService, SeoResolver, RedirectRepository, PostRepository],
  controllers: [SeoController],
  exports: [SeoService, RedirectRepository],
})
export class SeoModule {}
