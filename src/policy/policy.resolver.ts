import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { RequirePermission } from '@access';
import { PolicyService } from './policy.service';
import { PolicySettingEntity } from './entities/policy-setting.entity';
import { UpdatePolicySettingInput } from './dto/update-policy.input';

type Row = Awaited<ReturnType<PolicyService['list']>>[number];

function toEntity(row: Row): PolicySettingEntity {
  return {
    ...row,
    parameters: row.parameters == null ? null : JSON.stringify(row.parameters),
  };
}

@Resolver(() => PolicySettingEntity)
export class PolicyResolver {
  constructor(private readonly policy: PolicyService) {}

  @RequirePermission('policy.view')
  @Query(() => [PolicySettingEntity], { name: 'policySettings' })
  async policySettings(): Promise<PolicySettingEntity[]> {
    return (await this.policy.list()).map(toEntity);
  }

  @RequirePermission('policy.manage')
  @Mutation(() => PolicySettingEntity)
  async updatePolicySetting(
    @Args('input') input: UpdatePolicySettingInput,
  ): Promise<PolicySettingEntity> {
    const row = await this.policy.update(input.code, {
      enabled: input.enabled,
      parameters: input.parameters
        ? (JSON.parse(input.parameters) as Record<string, unknown>)
        : undefined,
    });
    return toEntity(row);
  }
}
