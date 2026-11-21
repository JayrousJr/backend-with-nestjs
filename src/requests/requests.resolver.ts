import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { InternalRequestStatus, PurchaseRequestStatus } from '@db';
import { AuthUser } from '@common';
import type { CurrentUser } from '@common';
import { RequirePermission } from '@access';
import { RequestsService } from './requests.service';
import {
  CreateInternalRequestInput,
  CreatePurchaseRequestInput,
  InternalRequestEntity,
  PlanInternalRequestInput,
  PurchaseRequestEntity,
  UpdateInternalRequestInput,
} from './requests.types';

const VIEWS = ['mine', 'owning', 'deliver', 'all'] as const;

@Resolver()
export class RequestsResolver {
  constructor(private readonly service: RequestsService) {}

  @Query(() => [InternalRequestEntity], {
    description: 'view: mine | owning | deliver | all',
  })
  internalRequests(
    @AuthUser() user: CurrentUser,
    @Args('view', { nullable: true }) view?: string,
    @Args('statuses', { type: () => [InternalRequestStatus], nullable: true })
    statuses?: InternalRequestStatus[],
  ) {
    return this.service.listInternal(user, {
      view: VIEWS.find((v) => v === view) ?? 'all',
      statuses,
    });
  }

  @Query(() => InternalRequestEntity)
  internalRequest(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.getInternal(user, uniqueId);
  }

  @RequirePermission('internal_request.create')
  @Mutation(() => InternalRequestEntity)
  createInternalRequest(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateInternalRequestInput,
  ) {
    return this.service.createInternal(user, input);
  }

  @RequirePermission('internal_request.create')
  @Mutation(() => InternalRequestEntity)
  updateInternalRequest(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('input') input: UpdateInternalRequestInput,
  ) {
    return this.service.updateInternal(user, uniqueId, input);
  }

  @RequirePermission('internal_request.submit')
  @Mutation(() => InternalRequestEntity)
  submitInternalRequest(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.submitInternal(user, uniqueId);
  }

  @RequirePermission('internal_request.accept')
  @Mutation(() => InternalRequestEntity, {
    description:
      'Owning department accepts (quantity < requested = partial, note required)',
  })
  acceptInternalRequest(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('quantity', { type: () => Int }) quantity: number,
    @Args('note', { nullable: true }) note?: string,
  ) {
    return this.service.acceptInternal(user, uniqueId, quantity, note);
  }

  @RequirePermission('internal_request.fulfil')
  @Mutation(() => InternalRequestEntity)
  planInternalRequest(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('input') input: PlanInternalRequestInput,
  ) {
    return this.service.planInternal(user, uniqueId, input);
  }

  @RequirePermission('internal_request.create')
  @Mutation(() => InternalRequestEntity)
  closeInternalRequest(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.closeInternal(user, uniqueId);
  }

  @RequirePermission('internal_request.cancel')
  @Mutation(() => InternalRequestEntity)
  cancelInternalRequest(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('reason') reason: string,
  ) {
    return this.service.cancelInternal(user, uniqueId, reason);
  }

  @Query(() => [PurchaseRequestEntity])
  purchaseRequests(
    @AuthUser() user: CurrentUser,
    @Args('statuses', { type: () => [PurchaseRequestStatus], nullable: true })
    statuses?: PurchaseRequestStatus[],
  ) {
    return this.service.listPurchase(user, statuses);
  }

  @Query(() => PurchaseRequestEntity)
  purchaseRequest(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.getPurchase(user, uniqueId);
  }

  @RequirePermission('purchase_request.create')
  @Mutation(() => PurchaseRequestEntity)
  createPurchaseRequest(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreatePurchaseRequestInput,
  ) {
    return this.service.createPurchase(user, input);
  }

  @RequirePermission('purchase_request.submit')
  @Mutation(() => PurchaseRequestEntity)
  submitPurchaseRequest(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.service.submitPurchase(user, uniqueId);
  }

  @RequirePermission('purchase_request.cancel')
  @Mutation(() => PurchaseRequestEntity)
  cancelPurchaseRequest(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('reason') reason: string,
  ) {
    return this.service.cancelPurchase(user, uniqueId, reason);
  }
}
