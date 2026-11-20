import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthUser } from '@common';
import type { CurrentUser } from '@common';
import { RequirePermission } from '@access';
import { WorkflowService } from './workflow.service';
import { ChainsService } from './chains.service';
import { ASSIGNEE_RULES } from './point-catalogue';
import {
  AssigneeRuleEntity,
  DecideApprovalInput,
  PointEntity,
  PointSummaryEntity,
  RequestEntity,
  SaveChainInput,
} from './workflow.types';

@Resolver()
export class WorkflowResolver {
  constructor(
    private readonly workflow: WorkflowService,
    private readonly chains: ChainsService,
  ) {}

  // ── my approvals (any signed-in user; assignment decides) ────────────────

  @Query(() => [RequestEntity], {
    description: 'Requests waiting for my decision',
  })
  myApprovalTasks(@AuthUser() user: CurrentUser) {
    return this.workflow.inbox(user);
  }

  @Query(() => [RequestEntity], {
    description: 'Requests I raised or acted on',
  })
  myApprovalRequests(@AuthUser() user: CurrentUser) {
    return this.workflow.mine(user);
  }

  @Query(() => RequestEntity)
  approvalRequest(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ) {
    return this.workflow.detail(user, uniqueId);
  }

  @Mutation(() => RequestEntity)
  decideApproval(
    @AuthUser() user: CurrentUser,
    @Args('input') input: DecideApprovalInput,
  ) {
    return this.workflow.decide(
      user,
      input.uniqueId,
      input.decision,
      input.comment,
    );
  }

  // ── configuration ────────────────────────────────────────────────────────

  @RequirePermission('workflow.view')
  @Query(() => [RequestEntity])
  approvalRequests(
    @AuthUser() user: CurrentUser,
    @Args('status', { nullable: true }) status?: string,
  ) {
    return this.workflow.all(user, status);
  }

  @RequirePermission('workflow.view')
  @Query(() => [PointSummaryEntity])
  approvalPoints() {
    return this.chains.points();
  }

  @RequirePermission('workflow.view')
  @Query(() => PointEntity)
  approvalPoint(@Args('code') code: string) {
    return this.chains.point(code);
  }

  @RequirePermission('workflow.view')
  @Query(() => [AssigneeRuleEntity])
  assigneeRules() {
    return Object.entries(ASSIGNEE_RULES).map(([code, description]) => ({
      code,
      description,
    }));
  }

  @RequirePermission('workflow.manage')
  @Mutation(() => PointEntity)
  saveApprovalChainDraft(
    @AuthUser() user: CurrentUser,
    @Args('input') input: SaveChainInput,
  ) {
    return this.chains.saveDraft(user, input.pointCode, input.steps);
  }

  @RequirePermission('workflow.manage')
  @Mutation(() => PointEntity)
  discardApprovalChainDraft(
    @AuthUser() user: CurrentUser,
    @Args('pointCode') code: string,
  ) {
    return this.chains.discardDraft(user, code);
  }

  @RequirePermission('workflow.activate')
  @Mutation(() => PointEntity)
  activateApprovalChain(
    @AuthUser() user: CurrentUser,
    @Args('pointCode') code: string,
    @Args('versionUniqueId') versionUniqueId: string,
  ) {
    return this.chains.activate(user, code, versionUniqueId);
  }
}
