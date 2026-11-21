import { BadRequestException } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { HandoverStatus, ResponsibilityDecision } from '@db';
import { AuthUser } from '@common';
import type { CurrentUser } from '@common';
import { RequirePermission } from '@access';
import type { Request } from 'express';
import { HandoverService } from './handover.service';
import { CustodyService } from './custody.service';
import {
  AckDeliveryEntity,
  AssetReportEntity,
  CreateAssetReportInput,
  CustodyItemEntity,
  CustodyTransferEntity,
  HandoverEntity,
  InspectionInput,
  PrepareHandoverInput,
  ReceiveReturnInput,
  RequestCustodyTransferInput,
  RequestReturnInput,
  ReturnEntity,
} from './custody.types';

const ipOf = (ctx: { req?: Request }) => ctx.req?.ip ?? null;

@Resolver()
export class CustodyResolver {
  constructor(
    private readonly handoverService: HandoverService,
    private readonly custodyService: CustodyService,
  ) {}

  // ── handovers ──
  @Query(() => [HandoverEntity])
  handovers(
    @AuthUser() user: CurrentUser,
    @Args('statuses', { type: () => [HandoverStatus], nullable: true })
    statuses?: HandoverStatus[],
    @Args('employeeUniqueId', { nullable: true }) employeeUniqueId?: string,
  ) {
    return this.handoverService.list(user, { statuses, employeeUniqueId });
  }

  @Query(() => HandoverEntity)
  handover(@AuthUser() user: CurrentUser, @Args('uniqueId') uniqueId: string) {
    return this.handoverService.get(user, uniqueId);
  }

  @RequirePermission('handover.prepare')
  @Mutation(() => HandoverEntity)
  prepareHandover(
    @AuthUser() user: CurrentUser,
    @Args('input') input: PrepareHandoverInput,
  ) {
    return this.handoverService.prepare(user, input);
  }

  @RequirePermission('handover.acknowledge')
  @Mutation(() => HandoverEntity)
  acknowledgeHandover(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Context() ctx: { req?: Request },
  ) {
    return this.handoverService.acknowledge(user, uniqueId, ipOf(ctx));
  }

  @RequirePermission('handover.acknowledge')
  @Mutation(() => HandoverEntity, {
    description: 'Custodian reports a difference',
  })
  disputeHandover(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('note') note: string,
  ) {
    return this.handoverService.dispute(user, uniqueId, note);
  }

  @RequirePermission('handover.prepare')
  @Mutation(() => HandoverEntity, { description: 'action: RESEND | CANCEL' })
  resolveHandoverDispute(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('action') action: string,
    @Args('note') note: string,
  ) {
    if (action !== 'RESEND' && action !== 'CANCEL')
      throw new BadRequestException('errors.invalid_status');
    return this.handoverService.resolveDispute(user, uniqueId, action, note);
  }

  @RequirePermission('handover.prepare')
  @Mutation(() => AckDeliveryEntity)
  sendHandoverLink(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.handoverService.sendEmailLink(user, uniqueId);
  }

  @RequirePermission('handover.prepare')
  @Mutation(() => AckDeliveryEntity)
  sendHandoverCode(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.handoverService.sendCounterCode(user, uniqueId);
  }

  @RequirePermission('handover.prepare')
  @Mutation(() => HandoverEntity)
  acknowledgeHandoverWithCode(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('code') code: string,
    @Context() ctx: { req?: Request },
  ) {
    return this.handoverService.acknowledgeWithCode(
      user,
      uniqueId,
      code,
      ipOf(ctx),
    );
  }

  @RequirePermission('handover.cancel')
  @Mutation(() => HandoverEntity)
  cancelHandover(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('reason') reason: string,
  ) {
    return this.handoverService.cancel(user, uniqueId, reason);
  }

  // ── custody views ──
  @Query(() => [CustodyItemEntity], {
    description: 'Items currently held (my items, department, employee)',
  })
  custodyItems(
    @AuthUser() user: CurrentUser,
    @Args('mine', { nullable: true }) mine?: boolean,
    @Args('employeeUniqueId', { nullable: true }) employeeUniqueId?: string,
    @Args('departmentUniqueId', { nullable: true }) departmentUniqueId?: string,
  ) {
    return this.custodyService.custodyItems(user, {
      mine,
      employeeUniqueId,
      departmentUniqueId,
    });
  }

  @Query(() => [CustodyItemEntity])
  custodyHistory(
    @AuthUser() user: CurrentUser,
    @Args('assetUniqueId', { nullable: true }) assetUniqueId?: string,
    @Args('employeeUniqueId', { nullable: true }) employeeUniqueId?: string,
  ) {
    return this.custodyService.custodyHistory(user, {
      assetUniqueId,
      employeeUniqueId,
    });
  }

  @Query(() => [CustodyItemEntity])
  inspectionsDue(@AuthUser() user: CurrentUser) {
    return this.custodyService.inspectionsDue(user);
  }

  // ── returns ──
  @Query(() => [ReturnEntity])
  assetReturns(
    @AuthUser() user: CurrentUser,
    @Args('open', { nullable: true }) open?: boolean,
  ) {
    return this.custodyService.listReturns(user, open ?? false);
  }

  @Mutation(() => ReturnEntity)
  requestAssetReturn(
    @AuthUser() user: CurrentUser,
    @Args('input') input: RequestReturnInput,
  ) {
    return this.custodyService.requestReturn(user, input);
  }

  @RequirePermission('return.receive')
  @Mutation(() => ReturnEntity)
  receiveAssetReturn(
    @AuthUser() user: CurrentUser,
    @Args('input') input: ReceiveReturnInput,
  ) {
    return this.custodyService.receiveReturn(user, input);
  }

  @Mutation(() => ReturnEntity)
  cancelAssetReturn(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.custodyService.cancelReturn(user, uniqueId);
  }

  // ── reports & inspections ──
  @Query(() => [AssetReportEntity])
  assetReports(
    @AuthUser() user: CurrentUser,
    @Args('assetUniqueId', { nullable: true }) assetUniqueId?: string,
  ) {
    return this.custodyService.listReports(user, assetUniqueId);
  }

  @RequirePermission('asset_report.create')
  @Mutation(() => AssetReportEntity)
  async createAssetReport(
    @AuthUser() user: CurrentUser,
    @Args('input') input: CreateAssetReportInput,
  ) {
    return (await this.custodyService.createReport(user, input))!;
  }

  @RequirePermission('asset_report.create')
  @Mutation(() => AssetReportEntity)
  proposeResponsibility(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
    @Args('decision', { type: () => ResponsibilityDecision })
    decision: ResponsibilityDecision,
    @Args('reason') reason: string,
  ) {
    return this.custodyService.proposeResponsibility(
      user,
      uniqueId,
      decision,
      reason,
    );
  }

  @RequirePermission('asset_inspection.perform')
  @Mutation(() => Boolean)
  async recordInspection(
    @AuthUser() user: CurrentUser,
    @Args('input') input: InspectionInput,
  ) {
    await this.custodyService.inspect(user, input);
    return true;
  }

  // ── custody transfers ──
  @Query(() => [CustodyTransferEntity])
  custodyTransfers(@AuthUser() user: CurrentUser) {
    return this.custodyService.listTransfers(user);
  }

  @RequirePermission('custody_transfer.request')
  @Mutation(() => CustodyTransferEntity)
  requestCustodyTransfer(
    @AuthUser() user: CurrentUser,
    @Args('input') input: RequestCustodyTransferInput,
  ) {
    return this.custodyService.requestTransfer(user, input);
  }
}
