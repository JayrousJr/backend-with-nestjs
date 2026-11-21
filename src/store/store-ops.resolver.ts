import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DisposalStatus, MaintenanceStatus } from '@db';
import { AuthUser } from '@common';
import type { CurrentUser } from '@common';
import { RequirePermission } from '@access';
import { CountsService } from './counts.service';
import { MaintenanceService } from './maintenance.service';
import { DisposalsService } from './disposals.service';
import { AssetsService } from './assets.service';
import { AssetEntity } from './store.types';
import {
  CompleteMaintenanceInput,
  CountEntity,
  CreateCountInput,
  DisposalEntity,
  MaintenanceEntity,
  OpenMaintenanceInput,
  ProposeDisposalInput,
  RecordCountInput,
} from './store-ops.types';

/** Counts, maintenance, disposal, and missing / lost assets (B2 §8, §10, §6.1). */
@Resolver()
export class StoreOpsResolver {
  constructor(
    private readonly countsService: CountsService,
    private readonly maintenanceService: MaintenanceService,
    private readonly disposalsService: DisposalsService,
    private readonly assetsService: AssetsService,
  ) {}

  // ── counts ──
  @Query(() => [CountEntity])
  stockCounts(
    @AuthUser() user: CurrentUser,
    @Args('storeUniqueId', { nullable: true }) storeUniqueId?: string,
  ) {
    return this.countsService.list(user, storeUniqueId);
  }

  @Query(() => CountEntity)
  stockCount(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.countsService.get(user, uniqueId);
  }

  @RequirePermission('stock_count.create')
  @Mutation(() => CountEntity, {
    description: 'Start a count: snapshot + freeze',
  })
  startStockCount(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateCountInput,
  ) {
    return this.countsService.create(user, input);
  }

  @RequirePermission('stock_count.count')
  @Mutation(() => CountEntity)
  recordStockCount(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('input') input: RecordCountInput,
  ) {
    return this.countsService.record(user, uniqueId, input.entries);
  }

  @RequirePermission('stock_count.count')
  @Mutation(() => CountEntity, {
    description: 'Scan an asset tag during the count',
  })
  scanStockCount(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('tag') tag: string,
    @Args('locationUniqueId', { nullable: true }) locationUniqueId?: string,
  ) {
    return this.countsService.scan(user, uniqueId, tag, locationUniqueId);
  }

  @RequirePermission('stock_count.count')
  @Mutation(() => CountEntity)
  submitStockCount(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.countsService.submit(user, uniqueId);
  }

  @RequirePermission('stock_count.create')
  @Mutation(() => CountEntity)
  cancelStockCount(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('reason') reason: string,
  ) {
    return this.countsService.cancel(user, uniqueId, reason);
  }

  @RequirePermission('stock_count.create')
  @Mutation(() => CountEntity)
  retryPostStockCount(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.countsService.retryPost(user, uniqueId);
  }

  // ── maintenance ──
  @Query(() => [MaintenanceEntity])
  maintenanceTickets(
    @AuthUser() user: CurrentUser,
    @Args('status', { type: () => MaintenanceStatus, nullable: true })
    status?: MaintenanceStatus,
    @Args('assetUniqueId', { nullable: true }) assetUniqueId?: string,
  ) {
    return this.maintenanceService.list(user, status, assetUniqueId);
  }

  @Query(() => MaintenanceEntity)
  maintenanceTicket(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.maintenanceService.get(user, uniqueId);
  }

  @RequirePermission('maintenance.create')
  @Mutation(() => MaintenanceEntity)
  async openMaintenance(
    @AuthUser() user: CurrentUser,
    @Args('input') input: OpenMaintenanceInput,
  ) {
    return (await this.maintenanceService.open(user, input))!;
  }

  @RequirePermission('maintenance.update')
  @Mutation(() => MaintenanceEntity)
  startMaintenance(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.maintenanceService.start(user, uniqueId);
  }

  @RequirePermission('maintenance.update')
  @Mutation(() => MaintenanceEntity)
  sendMaintenanceToVendor(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('vendorName') vendorName: string,
  ) {
    return this.maintenanceService.sendToVendor(user, uniqueId, vendorName);
  }

  @RequirePermission('maintenance.update')
  @Mutation(() => MaintenanceEntity)
  completeMaintenance(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('input') input: CompleteMaintenanceInput,
  ) {
    return this.maintenanceService.complete(user, uniqueId, input);
  }

  @RequirePermission('maintenance.update')
  @Mutation(() => MaintenanceEntity)
  cancelMaintenance(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('reason') reason: string,
  ) {
    return this.maintenanceService.cancel(user, uniqueId, reason);
  }

  // ── disposals ──
  @Query(() => [DisposalEntity])
  disposals(
    @AuthUser() user: CurrentUser,
    @Args('status', { type: () => DisposalStatus, nullable: true })
    status?: DisposalStatus,
  ) {
    return this.disposalsService.list(user, status);
  }

  @Query(() => DisposalEntity)
  disposal(@AuthUser() user: CurrentUser, @Args('uniqueId') uniqueId: string) {
    return this.disposalsService.get(user, uniqueId);
  }

  @RequirePermission('disposal.propose')
  @Mutation(() => DisposalEntity)
  proposeDisposal(
    @AuthUser() user: CurrentUser,
    @Args('input') input: ProposeDisposalInput,
  ) {
    return this.disposalsService.propose(user, input);
  }

  @Mutation(() => DisposalEntity, {
    description: 'Record the disposal after approval',
  })
  completeDisposal(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('note') note: string,
  ) {
    return this.disposalsService.complete(user, uniqueId, note);
  }

  @Mutation(() => DisposalEntity)
  cancelDisposal(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('reason') reason: string,
  ) {
    return this.disposalsService.cancel(user, uniqueId, reason);
  }

  // ── missing / lost ──
  @RequirePermission('store.manage')
  @Mutation(() => AssetEntity)
  markAssetLost(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('reason') reason: string,
  ) {
    return this.assetsService.markLost(user, uniqueId, reason);
  }

  @RequirePermission('stock.adjust')
  @Mutation(() => AssetEntity)
  markAssetFound(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('locationUniqueId') locationUniqueId: string,
    @Args('note', { nullable: true }) note?: string,
  ) {
    return this.assetsService.markFound(
      user,
      uniqueId,
      locationUniqueId,
      note ?? '',
    );
  }
}
