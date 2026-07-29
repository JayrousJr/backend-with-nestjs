import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { PaginationInput, Public } from '@common';
import {
  createMessageResponse,
  IMessageMutationResponse,
} from '@common/dto/mutation-response.type';
import { PERMISSIONS, RequirePermission } from '@permissions';
import { ContentService } from './content.service';
import { PostEntity } from './entities/post.entity';
import { PostListResponse, PostMutationResponse } from './dto/post.responses';
import { PostFilterInput } from './dto/post.filter';
import { CreatePostInput, UpdatePostInput } from './dto/post.types';

const DeletePostResponse = createMessageResponse('DeletePostResponse');

@Resolver(() => PostEntity)
export class ContentResolver {
  constructor(private readonly contentService: ContentService) {}

  /** Public reads — the indexable surface of the app. */
  @Public()
  @Query(() => PostListResponse, { name: 'getPublishedPosts' })
  getPublishedPosts(
    @Args('locale', { type: () => String, nullable: true }) locale?: string,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
  ) {
    return this.contentService.getPublishedPosts(locale, pagination);
  }

  @Public()
  @Query(() => PostEntity, { name: 'getPostBySlug' })
  getPostBySlug(
    @Args('slug') slug: string,
    @Args('locale', { type: () => String, nullable: true }) locale?: string,
  ) {
    return this.contentService.getPostBySlug(slug, locale);
  }

  @RequirePermission(PERMISSIONS.CONTENT.READ)
  @Query(() => PostListResponse, { name: 'getPosts' })
  getPosts(
    @Args('filter', { type: () => PostFilterInput, nullable: true })
    filter?: PostFilterInput,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
  ) {
    return this.contentService.getPosts(filter, pagination);
  }

  @RequirePermission(PERMISSIONS.CONTENT.READ)
  @Query(() => PostEntity, { name: 'getPost' })
  getPost(@Args('uniqueId') uniqueId: string) {
    return this.contentService.getPost(uniqueId);
  }

  @RequirePermission(PERMISSIONS.CONTENT.MANAGE)
  @Mutation(() => PostMutationResponse)
  async createPost(
    @Args('input') input: CreatePostInput,
  ): Promise<PostMutationResponse> {
    const data = await this.contentService.createPost(input);
    return { data, message: 'success.POST_CREATE' };
  }

  @RequirePermission(PERMISSIONS.CONTENT.MANAGE)
  @Mutation(() => PostMutationResponse)
  async updatePost(
    @Args('input') input: UpdatePostInput,
  ): Promise<PostMutationResponse> {
    const data = await this.contentService.updatePost(input);
    return { data, message: 'success.POST_UPDATE' };
  }

  @RequirePermission(PERMISSIONS.CONTENT.MANAGE)
  @Mutation(() => DeletePostResponse)
  async deletePost(
    @Args('uniqueId') uniqueId: string,
  ): Promise<IMessageMutationResponse> {
    await this.contentService.deletePost(uniqueId);
    return { message: 'success.POST_DELETE' };
  }
}
