import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { PaginationInput, Public } from '@common';
import {
  createMessageResponse,
  IMessageMutationResponse,
} from '@common/dto/mutation-response.type';
import { PERMISSIONS, RequirePermission } from '@permissions';
import { SeoService } from './seo.service';
import { RedirectEntity } from './entities/redirect.entity';
import {
  CreateRedirectInput,
  RedirectListResponse,
  RedirectMutationResponse,
  ResolvedRedirect,
} from './dto/redirect.types';

const DeleteRedirectResponse = createMessageResponse('DeleteRedirectResponse');

@Resolver(() => RedirectEntity)
export class SeoResolver {
  constructor(private readonly seoService: SeoService) {}

  /** Public: the SPA's not-found route asks whether a path has moved. */
  @Public()
  @Query(() => ResolvedRedirect, { name: 'resolveRedirect', nullable: true })
  resolveRedirect(@Args('path') path: string) {
    return this.seoService.resolveRedirect(path);
  }

  @RequirePermission(PERMISSIONS.SEO.MANAGE)
  @Query(() => RedirectListResponse, { name: 'getRedirects' })
  getRedirects(
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
  ) {
    return this.seoService.getRedirects(pagination);
  }

  @RequirePermission(PERMISSIONS.SEO.MANAGE)
  @Mutation(() => RedirectMutationResponse)
  async createRedirect(
    @Args('input') input: CreateRedirectInput,
  ): Promise<RedirectMutationResponse> {
    const data = await this.seoService.createRedirect(input);
    return { data, message: 'success.REDIRECT_CREATE' };
  }

  @RequirePermission(PERMISSIONS.SEO.MANAGE)
  @Mutation(() => DeleteRedirectResponse)
  async deleteRedirect(
    @Args('uniqueId') uniqueId: string,
  ): Promise<IMessageMutationResponse> {
    await this.seoService.deleteRedirect(uniqueId);
    return { message: 'success.REDIRECT_DELETE' };
  }
}
