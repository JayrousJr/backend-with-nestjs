import { Module } from '@nestjs/common';
import { ContentService } from './content.service';
import { ContentResolver } from './content.resolver';
import { PostRepository } from './post.repository';
import { SeoModule } from '../seo/seo.module';

@Module({
  imports: [SeoModule],
  providers: [ContentResolver, ContentService, PostRepository],
  exports: [ContentService, PostRepository],
})
export class ContentModule {}
