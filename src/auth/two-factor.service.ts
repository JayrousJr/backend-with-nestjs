import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import bcrypt from 'bcrypt';
import { PrismaService } from '@prisma';
import { AppConfigService } from '@config';
import type { CurrentUser } from '@common';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { MailService } from '../mail/mail.service';
import { AuthTokensService } from '../users/auth-tokens.service';
import {
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  otpauthUri,
  verifyTotp,
} from './totp';

const EMAIL_CODE_MINUTES = 10;
const ISSUER = 'AzamTV';

/**
 * Staff two-factor authentication (A1 §7): TOTP authenticator app, with an
 * emailed one-time code as the staff fallback. Mandatory for the roles
 * listed in SECURITY_TWO_FACTOR.requiredRoles (a setting), optional for
 * everyone else.
 */
@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly policy: PolicyService,
    private readonly tokens: AuthTokensService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  /** Whether the user holds (directly or via a group) a role requiring 2FA. */
  async isRequired(userId: number): Promise<boolean> {
    if (!(await this.policy.isEnabled('SECURITY_TWO_FACTOR'))) return false;
    const { requiredRoles = [] } = await this.policy.params<{
      requiredRoles?: string[];
    }>('SECURITY_TWO_FACTOR');
    if (!requiredRoles.length) return false;
    const names = requiredRoles.map((r) => r.toLowerCase());
    const roles = await this.prisma.db.role.findMany({
      where: {
        isActive: true,
        OR: [
          { users: { some: { userId } } },
          {
            groupRoles: {
              some: {
                group: { isActive: true, members: { some: { userId } } },
              },
            },
          },
        ],
      },
      select: { name: true },
    });
    return roles.some((r) => names.includes(r.name.toLowerCase()));
  }

  private async user(userId: number) {
    const u = await this.prisma.db.user.findFirst({
      where: { id: userId },
      include: { employee: true },
    });
    if (!u) throw new NotFoundException('errors.user_not_found');
    return u;
  }

  /** Start enrolment: a fresh secret, stored encrypted, not yet enabled. */
  async beginSetup(userId: number) {
    const u = await this.user(userId);
    if (u.twoFactorEnabled) {
      throw new BadRequestException('errors.two_factor_already_enabled');
    }
    const secret = generateTotpSecret();
    await this.prisma.db.user.update({
      where: { id: u.id },
      data: {
        twoFactorSecret: encryptSecret(secret, this.config.twoFactorKey),
      },
    });
    return { secret, otpauthUri: otpauthUri(secret, u.email, ISSUER) };
  }

  /** Finish enrolment by proving the app produces valid codes. */
  async confirmSetup(userId: number, code: string) {
    const u = await this.user(userId);
    if (u.twoFactorEnabled) return;
    if (!u.twoFactorSecret) {
      throw new BadRequestException('errors.two_factor_not_started');
    }
    const secret = decryptSecret(u.twoFactorSecret, this.config.twoFactorKey);
    if (!verifyTotp(secret, code)) {
      throw new BadRequestException('errors.two_factor_invalid_code');
    }
    await this.prisma.db.user.update({
      where: { id: u.id },
      data: { twoFactorEnabled: true },
    });
    await this.audit.log({
      action: 'user.two_factor_enable',
      entityType: 'User',
      entityId: u.uniqueId,
    });
  }

  /** Verify a login code: authenticator code, or an emailed one-time code. */
  async verify(userId: number, code: string): Promise<boolean> {
    const u = await this.user(userId);
    const clean = code.replace(/\s+/g, '');
    if (u.twoFactorEnabled && u.twoFactorSecret) {
      const secret = decryptSecret(u.twoFactorSecret, this.config.twoFactorKey);
      if (verifyTotp(secret, clean)) return true;
    }
    const rows = await this.prisma.dbRaw.authToken.findMany({
      where: {
        userId,
        type: 'TWO_FACTOR_EMAIL',
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    for (const row of rows) {
      if (await bcrypt.compare(clean, row.tokenHash)) {
        await this.tokens.consume(row.id);
        return true;
      }
    }
    return false;
  }

  /** Email a 6-digit code to the company email (staff fallback). */
  async sendEmailCode(userId: number) {
    const u = await this.user(userId);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const now = new Date();
    await this.prisma.dbRaw.authToken.updateMany({
      where: { userId, type: 'TWO_FACTOR_EMAIL', usedAt: null },
      data: { usedAt: now },
    });
    // bcrypt, not sha256: a 6-digit space is trivially brute-forced from a
    // fast hash if the table ever leaks. The unique column gets the salted hash.
    await this.prisma.dbRaw.authToken.create({
      data: {
        userId,
        type: 'TWO_FACTOR_EMAIL',
        tokenHash: await bcrypt.hash(code, 10),
        expiresAt: new Date(now.getTime() + EMAIL_CODE_MINUTES * 60_000),
      },
    });
    await this.mail.queueTwoFactorCode({
      email: u.email,
      firstName: u.employee.firstName,
      code,
      locale: u.preferredLocale,
      validFor: EMAIL_CODE_MINUTES,
    });
  }

  /** Users may switch 2FA off only when no role of theirs requires it. */
  async disable(user: CurrentUser, password: string, code: string) {
    const u = await this.user(user.id);
    if (await this.isRequired(u.id)) {
      throw new BadRequestException('errors.two_factor_required');
    }
    if (!u.password || !(await bcrypt.compare(password, u.password))) {
      throw new UnauthorizedException('errors.current_password_incorrect');
    }
    if (!(await this.verify(u.id, code))) {
      throw new BadRequestException('errors.two_factor_invalid_code');
    }
    await this.prisma.db.user.update({
      where: { id: u.id },
      data: { twoFactorEnabled: false, twoFactorSecret: null },
    });
    await this.audit.log({
      action: 'user.two_factor_disable',
      entityType: 'User',
      entityId: u.uniqueId,
    });
  }

  /** Lost device: an administrator resets 2FA (audited); sessions end. */
  async reset(actor: CurrentUser, userUniqueId: string) {
    const u = await this.prisma.db.user.findFirst({
      where: { uniqueId: userUniqueId },
    });
    if (!u) throw new NotFoundException('errors.user_not_found');
    if (u.id === actor.id) {
      throw new BadRequestException('errors.two_factor_reset_self');
    }
    await this.prisma.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: u.id },
        data: { twoFactorEnabled: false, twoFactorSecret: null },
      });
      await tx.session.updateMany({
        where: { userId: u.id, isDeleted: false },
        data: { isDeleted: true, deletedAt: new Date() },
      });
    });
    await this.audit.log({
      action: 'user.two_factor_reset',
      entityType: 'User',
      entityId: u.uniqueId,
    });
  }

  async status(userId: number) {
    const u = await this.user(userId);
    return {
      enabled: u.twoFactorEnabled,
      required: await this.isRequired(userId),
    };
  }
}
