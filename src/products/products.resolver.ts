import { BadRequestException } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthUser } from '@common';
import type { CurrentUser } from '@common';
import { RequirePermission } from '@access';
import { ProductsService } from './products.service';
import {
  CreateProductInput,
  ProductActivationInput,
  ProductCategoryEntity,
  ProductEntity,
  ProductFilterInput,
  ProductListEntity,
  ProductSummaryEntity,
  ProductVersionEntity,
  ProductVersionInput,
  SaveCategoryInput,
} from './products.types';

const STATUSES = ['ACTIVE', 'INACTIVE', 'RETIRED'] as const;

@Resolver(() => ProductEntity)
export class ProductsResolver {
  constructor(private readonly service: ProductsService) {}

  @Query(() => [ProductCategoryEntity])
  productCategories(
    @Args('includeInactive', { nullable: true }) includeInactive?: boolean,
  ) {
    return this.service.categories(includeInactive ?? false);
  }

  @RequirePermission('item_category.manage')
  @Mutation(() => ProductCategoryEntity)
  saveProductCategory(
    @AuthUser() user: CurrentUser,
    @Args('input') input: SaveCategoryInput,
  ) {
    return this.service.saveCategory(user, input);
  }

  @Query(() => ProductListEntity)
  products(
    @AuthUser() user: CurrentUser,
    @Args('filter', { type: () => ProductFilterInput, nullable: true })
    filter?: ProductFilterInput,
    @Args('page', { type: () => Int, nullable: true }) page?: number,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ) {
    return this.service.list(user, filter ?? {}, page ?? 1, limit ?? 20);
  }

  @Query(() => ProductEntity)
  product(@AuthUser() user: CurrentUser, @Args('uniqueId') uniqueId: string) {
    return this.service.get(user, uniqueId);
  }

  @Query(() => [ProductVersionEntity])
  productVersions(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.versions(user, uniqueId);
  }

  @RequirePermission('item.view')
  @Query(() => [ProductSummaryEntity], {
    description: 'Search before create: similar product names',
  })
  similarProducts(
    @AuthUser() user: CurrentUser,
    @Args('name') name: string,
    @Args('excludeUniqueId', { nullable: true }) excludeUniqueId?: string,
  ) {
    return this.service.similar(user, name, excludeUniqueId);
  }

  @RequirePermission('item.create')
  @Mutation(() => ProductEntity)
  createProduct(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateProductInput,
  ) {
    return this.service.create(user, input);
  }

  @RequirePermission('item.edit_draft')
  @Mutation(() => ProductEntity)
  updateProductDraft(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('input') input: ProductVersionInput,
  ) {
    return this.service.updateDraft(user, uniqueId, input);
  }

  @RequirePermission('item.edit_draft')
  @Mutation(() => ProductEntity, {
    description: 'Start a new version of an Active product',
  })
  reviseProduct(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.revise(user, uniqueId);
  }

  @RequirePermission('item.submit')
  @Mutation(() => ProductEntity)
  async submitProduct(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return (await this.service.submit(user, uniqueId))!;
  }

  @RequirePermission('item.manage')
  @Mutation(() => ProductEntity)
  setProductActivation(
    @AuthUser() user: CurrentUser,
    @Args('input') input: ProductActivationInput,
  ) {
    return this.service.setActivation(user, input);
  }

  @RequirePermission('item.manage')
  @Mutation(() => ProductEntity, {
    description: 'status: ACTIVE | INACTIVE | RETIRED',
  })
  setProductStatus(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('status') status: string,
    @Args('reason') reason: string,
  ) {
    const s = STATUSES.find((x) => x === status);
    if (!s) throw new BadRequestException('errors.invalid_status');
    return this.service.setStatus(user, uniqueId, s, reason);
  }

  @RequirePermission('item.manage')
  @Mutation(() => ProductEntity)
  transferProductOwnership(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('departmentUniqueId') departmentUniqueId: string,
    @Args('reason') reason: string,
  ) {
    return this.service.transferOwnership(
      user,
      uniqueId,
      departmentUniqueId,
      reason,
    );
  }

  @RequirePermission('item.merge')
  @Mutation(() => ProductEntity)
  mergeProduct(
    @AuthUser() user: CurrentUser,
    @Args('fromUniqueId') fromUniqueId: string,
    @Args('intoUniqueId') intoUniqueId: string,
    @Args('reason') reason: string,
  ) {
    return this.service.merge(user, fromUniqueId, intoUniqueId, reason);
  }
}
