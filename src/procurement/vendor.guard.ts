import {
  CanActivate,
  ExecutionContext,
  Injectable,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import { VendorAuthService, type VendorPrincipal } from './vendor-auth.service';

/** Vendor portal routes: a vendor bearer token (typ "vendor"), never a staff token. */
@Injectable()
export class VendorGuard implements CanActivate {
  constructor(private readonly auth: VendorAuthService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { vendor?: VendorPrincipal }>();
    const h = req.headers.authorization;
    req.vendor = await this.auth.principal(
      h?.startsWith('Bearer ') ? h.slice(7) : undefined,
    );
    return true;
  }
}

export const Vendor = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<{ vendor: VendorPrincipal }>().vendor,
);
