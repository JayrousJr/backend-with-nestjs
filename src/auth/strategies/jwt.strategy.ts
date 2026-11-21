import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfigService } from '@config';
import { PrismaService } from '@prisma';
import { CurrentUser } from '@common';
import { JwtPayload } from '../auth.types';

/**
 * Step 1 of can(): the user and their employee must be active and the
 * session valid. Checked on every request so deactivation, suspension,
 * exit and session revocation take effect immediately.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: AppConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.jwtAccess.secret,
    });
  }

  async validate(payload: JwtPayload): Promise<CurrentUser> {
    // Vendor-portal and challenge tokens are never staff credentials.
    if ((payload as { typ?: string }).typ) throw new UnauthorizedException();
    const now = new Date();
    const [user, session] = await Promise.all([
      this.prisma.db.user.findFirst({
        where: { uniqueId: payload.sub },
        include: { employee: true },
      }),
      this.prisma.db.session.findFirst({
        where: {
          uniqueId: payload.sid,
          absoluteExpiresAt: { gt: now },
        },
        select: { userId: true },
      }),
    ]);
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      user.employee.status === 'SUSPENDED' ||
      user.employee.status === 'EXITED' ||
      !session ||
      session.userId !== user.id
    ) {
      throw new UnauthorizedException();
    }

    return {
      id: user.id,
      uniqueId: user.uniqueId,
      email: user.email,
      employeeId: user.employeeId,
      departmentId: user.employee.departmentId,
      preferredLocale: user.preferredLocale,
      sessionId: payload.sid,
    };
  }
}
