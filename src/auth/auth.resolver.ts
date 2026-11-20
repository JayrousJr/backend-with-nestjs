import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthUser } from '@common';
import type { CurrentUser } from '@common';
import { SessionEntity } from './entities/session.entity';
import { AuthService } from './auth.service';
import { TwoFactorService } from './two-factor.service';
import { RequirePermission } from '@access';

@Resolver(() => SessionEntity)
export class AuthResolver {
  constructor(
    private readonly auth: AuthService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  /** Lost authenticator: reset the user's 2FA (audited; sessions end). */
  @RequirePermission('user.manage')
  @Mutation(() => Boolean)
  async resetTwoFactor(
    @AuthUser() user: CurrentUser,
    @Args('userUniqueId') userUniqueId: string,
  ): Promise<boolean> {
    await this.twoFactor.reset(user, userUniqueId);
    return true;
  }

  @Query(() => [SessionEntity])
  mySessions(@AuthUser() user: CurrentUser) {
    return this.auth.getSessions(user.id);
  }

  @Mutation(() => Boolean)
  async revokeSession(
    @AuthUser() user: CurrentUser,
    @Args('uniqueId') uniqueId: string,
  ): Promise<boolean> {
    await this.auth.revokeSession(user.id, uniqueId);
    return true;
  }
}
