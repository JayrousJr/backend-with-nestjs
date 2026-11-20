import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CurrentUser, getRequest } from '@common';
import { AccessService } from '../access.service';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import type { PermissionCode } from '../catalogue';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<
      PermissionCode | undefined
    >(PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    if (!permission) return true;

    const request = getRequest(context);
    const user = request.user as CurrentUser | undefined;
    if (!user) throw new UnauthorizedException();

    if (!(await this.access.hasAny(user, permission))) {
      throw new ForbiddenException('errors.forbidden');
    }
    // Guards run before interceptors: hand "on behalf of" to the
    // RequestContextInterceptor through the request.
    const delegator = await this.access.delegatorFor(user, permission);
    if (delegator) {
      (request as { onBehalfOfUserId?: number }).onBehalfOfUserId = delegator;
    }
    return true;
  }
}
