import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AdjustmentStatus, StockDocType, TransferStatus } from '@db';
import { AuthUser } from '@common';
import type { CurrentUser } from '@common';
import { RequirePermission } from '@access';
import { StoresService } from './stores.service';
import { AssetsService } from './assets.service';
import { AdjustmentsService } from './adjustments.service';
import { TransfersService } from './transfers.service';
import { IssuesService } from './issues.service';
import {
  CreateStockDocumentInput,
  CreateTransferInput,
  DispatchTransferInput,
  ReceiveTransferInput,
  StockDocumentEntity,
  TransferEntity,
} from './transfers.types';
import {
  AssetEntity,
  AssetFilterInput,
  AssetListEntity,
  AssetTagEntity,
  CreateAdjustmentInput,
  MovementFilterInput,
  SaveLocationInput,
  SaveStoreInput,
  StockAdjustmentEntity,
  StockBalanceEntity,
  StockLevelEntity,
  StockLevelFilterInput,
  StockMovementEntity,
  StockSettingEntity,
  StockSettingInput,
  StoreEntity,
  UpdateAssetInput,
} from './store.types';

@Resolver()
export class StoreResolver {
  constructor(
    private readonly storesService: StoresService,
    private readonly assetsService: AssetsService,
    private readonly adjustmentsService: AdjustmentsService,
    private readonly transfersService: TransfersService,
    private readonly issuesService: IssuesService,
  ) {}

  // ── transfers ──
  @Query(() => [TransferEntity])
  transfers(
    @AuthUser() user: CurrentUser,
    @Args('storeUniqueId', { nullable: true }) storeUniqueId?: string,
    @Args('statuses', { type: () => [TransferStatus], nullable: true })
    statuses?: TransferStatus[],
  ) {
    return this.transfersService.list(user, storeUniqueId, statuses);
  }

  @Query(() => TransferEntity)
  transfer(@AuthUser() user: CurrentUser, @Args('uniqueId') uniqueId: string) {
    return this.transfersService.get(user, uniqueId);
  }

  @RequirePermission('transfer.create')
  @Mutation(() => TransferEntity)
  createTransfer(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateTransferInput,
  ) {
    return this.transfersService.create(user, input);
  }

  @RequirePermission('transfer.dispatch')
  @Mutation(() => TransferEntity)
  dispatchTransfer(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('input') input: DispatchTransferInput,
  ) {
    return this.transfersService.dispatch(user, uniqueId, input);
  }

  @RequirePermission('transfer.receive')
  @Mutation(() => TransferEntity)
  receiveTransfer(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('input') input: ReceiveTransferInput,
  ) {
    return this.transfersService.receive(user, uniqueId, input);
  }

  @Mutation(() => TransferEntity)
  cancelTransfer(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('reason') reason: string,
  ) {
    return this.transfersService.cancel(user, uniqueId, reason);
  }

  // ── issues / returns ──
  @Query(() => [StockDocumentEntity])
  stockDocuments(
    @AuthUser() user: CurrentUser,
    @Args('storeUniqueId', { nullable: true }) storeUniqueId?: string,
    @Args('type', { type: () => StockDocType, nullable: true })
    type?: StockDocType,
  ) {
    return this.issuesService.list(user, storeUniqueId, type);
  }

  @Query(() => StockDocumentEntity)
  stockDocument(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.issuesService.get(user, uniqueId);
  }

  @Mutation(() => StockDocumentEntity, {
    description: 'Issue voucher or return note',
  })
  createStockDocument(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateStockDocumentInput,
  ) {
    return this.issuesService.create(user, input);
  }

  // ── stores ──
  @Query(() => [StoreEntity])
  stores(
    @AuthUser() user: CurrentUser,
    @Args('includeInactive', { nullable: true }) includeInactive?: boolean,
  ) {
    return this.storesService.list(user, includeInactive ?? false);
  }

  @Query(() => StoreEntity)
  store(@AuthUser() user: CurrentUser, @Args('uniqueId') uniqueId: string) {
    return this.storesService.get(user, uniqueId);
  }

  @RequirePermission('store.manage')
  @Mutation(() => StoreEntity)
  saveStore(
    @AuthUser() user: CurrentUser,
    @Args('input') input: SaveStoreInput,
  ) {
    return this.storesService.save(user, input);
  }

  @RequirePermission('store.manage')
  @Mutation(() => StoreEntity)
  saveStoreLocation(
    @AuthUser() user: CurrentUser,
    @Args('input') input: SaveLocationInput,
  ) {
    return this.storesService.saveLocation(user, input);
  }

  @Query(() => [StockSettingEntity])
  stockSettings(
    @AuthUser() user: CurrentUser,
    @Args('storeUniqueId') storeUniqueId: string,
  ) {
    return this.storesService.settings(user, storeUniqueId);
  }

  @RequirePermission('store.manage')
  @Mutation(() => [StockSettingEntity])
  saveStockSetting(
    @AuthUser() user: CurrentUser,
    @Args('input') input: StockSettingInput,
  ) {
    return this.storesService.saveSetting(user, input);
  }

  // ── stock ──
  @RequirePermission('stock.view')
  @Query(() => [StockLevelEntity])
  stockLevels(
    @AuthUser() user: CurrentUser,
    @Args('filter', { type: () => StockLevelFilterInput, nullable: true })
    filter?: StockLevelFilterInput,
  ) {
    return this.assetsService.levels(user, filter ?? {});
  }

  @Query(() => [StockMovementEntity])
  stockMovements(
    @AuthUser() user: CurrentUser,
    @Args('filter', { type: () => MovementFilterInput, nullable: true })
    filter?: MovementFilterInput,
    @Args('page', { type: () => Int, nullable: true }) page?: number,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ) {
    return this.assetsService.movements(
      user,
      filter ?? {},
      page ?? 1,
      limit ?? 50,
    );
  }

  @Query(() => [StockBalanceEntity], {
    description: 'Where a quantity product sits in a store (location, batch)',
  })
  stockBalances(
    @AuthUser() user: CurrentUser,
    @Args('storeUniqueId') storeUniqueId: string,
    @Args('productUniqueId') productUniqueId: string,
  ) {
    return this.assetsService.balances(user, storeUniqueId, productUniqueId);
  }

  // ── assets ──
  @Query(() => AssetListEntity)
  assets(
    @AuthUser() user: CurrentUser,
    @Args('filter', { type: () => AssetFilterInput, nullable: true })
    filter?: AssetFilterInput,
    @Args('page', { type: () => Int, nullable: true }) page?: number,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ) {
    return this.assetsService.list(user, filter ?? {}, page ?? 1, limit ?? 20);
  }

  @Query(() => AssetEntity)
  asset(@AuthUser() user: CurrentUser, @Args('uniqueId') uniqueId: string) {
    return this.assetsService.get(user, uniqueId);
  }

  @Query(() => AssetEntity, {
    nullable: true,
    description: 'Scan lookup by tag',
  })
  assetByTag(@AuthUser() user: CurrentUser, @Args('tag') tag: string) {
    return this.assetsService.byTag(user, tag);
  }

  @RequirePermission('asset.edit')
  @Mutation(() => AssetEntity)
  updateAsset(
    @AuthUser() user: CurrentUser,
    @Args('input') input: UpdateAssetInput,
  ) {
    return this.assetsService.update(user, input);
  }

  @Mutation(() => AssetEntity)
  moveAssetLocation(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('locationUniqueId') locationUniqueId: string,
  ) {
    return this.assetsService.moveLocation(user, uniqueId, locationUniqueId);
  }

  // ── tags ──
  @RequirePermission('asset.tag_print')
  @Mutation(() => [AssetTagEntity])
  issueAssetTags(
    @AuthUser() user: CurrentUser,
    @Args('categoryUniqueId') categoryUniqueId: string,
    @Args('count', { type: () => Int }) count: number,
  ) {
    return this.assetsService.issueTags(user, categoryUniqueId, count);
  }

  @RequirePermission('asset.tag_print')
  @Query(() => [AssetTagEntity])
  unusedAssetTags(
    @AuthUser() user: CurrentUser,
    @Args('prefix', { nullable: true }) prefix?: string,
  ) {
    return this.assetsService.unusedTags(user, prefix);
  }

  @RequirePermission('asset.tag_print')
  @Mutation(() => Int)
  markTagsPrinted(
    @AuthUser() user: CurrentUser,
    @Args('tags', { type: () => [String] }) tags: string[],
  ) {
    return this.assetsService.markPrinted(user, tags);
  }

  // ── adjustments ──
  @Query(() => [StockAdjustmentEntity])
  stockAdjustments(
    @AuthUser() user: CurrentUser,
    @Args('storeUniqueId', { nullable: true }) storeUniqueId?: string,
    @Args('status', { type: () => AdjustmentStatus, nullable: true })
    status?: AdjustmentStatus,
  ) {
    return this.adjustmentsService.list(user, storeUniqueId, status);
  }

  @Query(() => StockAdjustmentEntity)
  stockAdjustment(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.adjustmentsService.get(user, uniqueId);
  }

  @RequirePermission('stock.adjust')
  @Mutation(() => StockAdjustmentEntity)
  createStockAdjustment(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateAdjustmentInput,
  ) {
    return this.adjustmentsService.create(user, input);
  }

  @RequirePermission('stock.adjust')
  @Mutation(() => StockAdjustmentEntity)
  resubmitStockAdjustment(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.adjustmentsService.resubmit(user, uniqueId);
  }

  @RequirePermission('stock.adjust')
  @Mutation(() => StockAdjustmentEntity)
  cancelStockAdjustment(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('reason') reason: string,
  ) {
    return this.adjustmentsService.cancel(user, uniqueId, reason);
  }

  @RequirePermission('stock.adjust')
  @Mutation(() => StockAdjustmentEntity)
  retryPostStockAdjustment(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.adjustmentsService.retryPost(user, uniqueId);
  }
}
