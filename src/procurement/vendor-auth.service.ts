import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import type { VendorUser } from '@db';
import { PrismaService } from '@prisma';
import { AppConfigService } from '@config';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { PasswordPolicyService } from '../auth/password-policy.service';
import {
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  otpauthUri,
  verifyTotp,
} from '../auth/totp';

export interface VendorPrincipal {
  vendorUserId: number;
  vendorUserUniqueId: string;
  vendorId: number;
  isAdmin: boolean;
  email: string;
  fullName: string;
  sessionId: string;
}

const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const IDLE_MINUTES = 30;
const ABSOLUTE_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const ACTIVATION_HOURS = 72;

/**
 * Vendor portal sign-in (tender spec §8): email + password + mandatory
 * authenticator-app 2FA, set up at first login. Vendor users are their own
 * population; their tokens (typ "vendor") are rejected by staff routes.
 */
@Injectable()
export class VendorAuthService {
  private readonly logger = new Logger(VendorAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly passwords: PasswordPolicyService,
  ) {}

  // ── activation (first password) ──────────────────────────────────────────

  /** New activation link (72 h). Returns the link in development (no mail server). */
  async issueActivation(user: VendorUser, vendorName: string) {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.db.vendorUser.update({
      where: { id: user.id },
      data: {
        activationTokenHash: hash(token),
        activationExpiresAt: new Date(Date.now() + ACTIVATION_HOURS * 3.6e6),
      },
    });
    const url = `${this.config.frontendUrl}/portal/activate/${token}`;
    await this.mail.queueGeneric({
      email: user.email,
      subject: 'AzamTV vendor portal — set your password',
      greeting: `Hello ${user.fullName},`,
      body: `An AzamTV vendor portal account was created for you (${vendorName}). Set your password within ${ACTIVATION_HOURS} hours. At first sign-in you will set up an authenticator app (mandatory).`,
      url,
      cta: 'Set password',
    });
    return this.config.isProduction ? null : url;
  }

  async activate(token: string, password: string) {
    const user = await this.prisma.db.vendorUser.findUnique({
      where: { activationTokenHash: hash(token) },
    });
    if (
      !user ||
      !user.activationExpiresAt ||
      user.activationExpiresAt < new Date() ||
      user.status === 'DEACTIVATED'
    ) {
      throw new BadRequestException('errors.activation_link_invalid');
    }
    const [first, ...rest] = user.fullName.split(' ');
    await this.passwords.validate(password, {
      email: user.email,
      firstName: first ?? '',
      lastName: rest.join(' '),
    });
    await this.prisma.db.vendorUser.update({
      where: { id: user.id },
      data: {
        password: await bcrypt.hash(password, 12),
        status: 'ACTIVE',
        activationTokenHash: null,
        activationExpiresAt: null,
      },
    });
    await this.audit.log({
      action: 'VENDOR_USER_ACTIVATED',
      entityType: 'VendorUser',
      entityId: user.uniqueId,
    });
  }

  // ── login ────────────────────────────────────────────────────────────────

  async login(email: string, password: string, ip?: string) {
    const user = await this.prisma.db.vendorUser.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { vendor: true },
    });
    const invalid = () =>
      new UnauthorizedException('errors.invalid_credentials');
    if (!user || !user.password) throw invalid();
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException({
        message: 'errors.account_locked',
        args: {
          minutes: Math.ceil((user.lockedUntil.getTime() - Date.now()) / 6e4),
        },
      });
    }
    if (!(await bcrypt.compare(password, user.password))) {
      await this.registerFailure(user);
      throw invalid();
    }
    if (user.status !== 'ACTIVE' || user.vendor.status === 'BLACKLISTED') {
      throw new UnauthorizedException('errors.account_deactivated');
    }
    if (this.config.devDisable2fa) {
      return { tokens: await this.startSession(user, ip) };
    }
    const challengeToken = await this.jwt.signAsync(
      { sub: user.uniqueId, typ: 'vendor-2fa' },
      { secret: this.config.jwtAccess.secret, expiresIn: '10m' },
    );
    return {
      challenge: { challengeToken, setupRequired: !user.twoFactorEnabled },
    };
  }

  private async registerFailure(user: VendorUser) {
    const fails = user.failedLoginAttempts + 1;
    await this.prisma.db.vendorUser.update({
      where: { id: user.id },
      data:
        fails >= MAX_FAILS
          ? {
              failedLoginAttempts: 0,
              lockedUntil: new Date(Date.now() + LOCK_MINUTES * 6e4),
            }
          : { failedLoginAttempts: fails },
    });
  }

  private async challengeUser(token: string) {
    let p: { sub: string; typ: string };
    try {
      p = await this.jwt.verifyAsync(token, {
        secret: this.config.jwtAccess.secret,
      });
    } catch {
      throw new UnauthorizedException('errors.two_factor_challenge_expired');
    }
    if (p.typ !== 'vendor-2fa')
      throw new UnauthorizedException('errors.two_factor_challenge_expired');
    const user = await this.prisma.db.vendorUser.findUnique({
      where: { uniqueId: p.sub },
    });
    if (!user || user.status !== 'ACTIVE')
      throw new UnauthorizedException('errors.two_factor_challenge_expired');
    return user;
  }

  /** First login: generate the authenticator secret (shown once as QR). */
  async beginSetup(challengeToken: string) {
    const user = await this.challengeUser(challengeToken);
    if (user.twoFactorEnabled)
      throw new BadRequestException('errors.two_factor_already_enabled');
    const secret = generateTotpSecret();
    await this.prisma.db.vendorUser.update({
      where: { id: user.id },
      data: { totpSecret: encryptSecret(secret, this.config.twoFactorKey) },
    });
    return {
      secret,
      otpauthUrl: otpauthUri(secret, user.email, 'AzamTV Vendor Portal'),
    };
  }

  async verify(challengeToken: string, code: string, ip?: string) {
    const user = await this.challengeUser(challengeToken);
    if (!user.totpSecret)
      throw new BadRequestException('errors.two_factor_not_set_up');
    const secret = decryptSecret(user.totpSecret, this.config.twoFactorKey);
    if (!verifyTotp(secret, code)) {
      await this.registerFailure(user);
      throw new UnauthorizedException('errors.two_factor_invalid_code');
    }
    if (!user.twoFactorEnabled) {
      await this.prisma.db.vendorUser.update({
        where: { id: user.id },
        data: { twoFactorEnabled: true },
      });
      await this.audit.log({
        action: 'VENDOR_2FA_ENROLLED',
        entityType: 'VendorUser',
        entityId: user.uniqueId,
      });
    }
    return this.startSession(user, ip);
  }

  // ── sessions ─────────────────────────────────────────────────────────────

  private async startSession(user: VendorUser, ip?: string) {
    const now = Date.now();
    const absolute = new Date(now + ABSOLUTE_HOURS * 3.6e6);
    const s = await this.prisma.db.vendorSession.create({
      data: {
        vendorUserId: user.id,
        expiresAt: new Date(now + IDLE_MINUTES * 6e4),
        absoluteExpiresAt: absolute,
        ipAddress: ip,
      },
    });
    await this.prisma.db.vendorUser.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });
    return this.sign(user.uniqueId, s.uniqueId);
  }

  private async sign(sub: string, sid: string) {
    const accessToken = await this.jwt.signAsync(
      { sub, sid, typ: 'vendor' },
      { secret: this.config.jwtAccess.secret, expiresIn: `${IDLE_MINUTES}m` },
    );
    return { accessToken, expiresInSeconds: IDLE_MINUTES * 60 };
  }

  /** Resolve a bearer token to a vendor principal (every portal request). */
  async principal(token: string | undefined): Promise<VendorPrincipal> {
    if (!token) throw new UnauthorizedException();
    let p: { sub: string; sid: string; typ: string };
    try {
      p = await this.jwt.verifyAsync(token, {
        secret: this.config.jwtAccess.secret,
      });
    } catch {
      throw new UnauthorizedException();
    }
    if (p.typ !== 'vendor') throw new UnauthorizedException();
    const now = new Date();
    const s = await this.prisma.db.vendorSession.findUnique({
      where: { uniqueId: p.sid },
      include: { user: { include: { vendor: true } } },
    });
    if (
      !s ||
      s.revokedAt ||
      s.expiresAt < now ||
      s.absoluteExpiresAt < now ||
      s.user.uniqueId !== p.sub ||
      s.user.status !== 'ACTIVE' ||
      s.user.vendor.status === 'BLACKLISTED'
    ) {
      throw new UnauthorizedException();
    }
    return {
      vendorUserId: s.user.id,
      vendorUserUniqueId: s.user.uniqueId,
      vendorId: s.user.vendorId,
      isAdmin: s.user.isAdmin,
      email: s.user.email,
      fullName: s.user.fullName,
      sessionId: s.uniqueId,
    };
  }

  /** Sliding idle window, capped by the absolute lifetime. */
  async refresh(v: VendorPrincipal) {
    const s = await this.prisma.db.vendorSession.findUniqueOrThrow({
      where: { uniqueId: v.sessionId },
    });
    const expiresAt = new Date(
      Math.min(Date.now() + IDLE_MINUTES * 6e4, s.absoluteExpiresAt.getTime()),
    );
    await this.prisma.db.vendorSession.update({
      where: { id: s.id },
      data: { expiresAt },
    });
    return this.sign(v.vendorUserUniqueId, v.sessionId);
  }

  async logout(v: VendorPrincipal) {
    await this.prisma.db.vendorSession.update({
      where: { uniqueId: v.sessionId },
      data: { revokedAt: new Date() },
    });
  }

  /** Lost device: vendor admin or Procurement resets (audited). */
  async resetTwoFactor(vendorUserId: number, by: string) {
    const u = await this.prisma.db.vendorUser.update({
      where: { id: vendorUserId },
      data: { totpSecret: null, twoFactorEnabled: false },
    });
    await this.prisma.db.vendorSession.updateMany({
      where: { vendorUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({
      action: 'VENDOR_2FA_RESET',
      entityType: 'VendorUser',
      entityId: u.uniqueId,
      after: { by },
    });
    this.logger.log(`Vendor 2FA reset: ${u.email} by ${by}`);
  }

  assertAdmin(v: VendorPrincipal) {
    if (!v.isAdmin) throw new ForbiddenException('errors.forbidden');
  }
}
