import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import type { LoginEventType, Prisma } from '@db';
import { PrismaService, type DbTx } from '@prisma';
import { AppConfigService } from '@config';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { MailService } from '../mail/mail.service';
import { AuthTokensService } from '../users/auth-tokens.service';
import { SessionsRepository } from './session.repository';
import { PasswordPolicyService } from './password-policy.service';
import { TwoFactorService } from './two-factor.service';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './auth.types';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** When the refresh cookie should expire. */
  refreshExpiresAt: Date;
}

/**
 * Second step of a login: the password was right, a TOTP / emailed code is
 * still needed. `setupRequired` = a role requires 2FA but the user has not
 * enrolled yet, so enrolment happens now.
 */
export interface TwoFactorChallenge {
  challengeToken: string;
  setupRequired: boolean;
}

export type LoginResult =
  | { tokens: AuthTokens; challenge?: undefined }
  | { challenge: TwoFactorChallenge; tokens?: undefined };

const CHALLENGE_TTL = '5m';

export interface SessionMetadata {
  userAgent?: string;
  ipAddress?: string;
}

const USER_WITH_EMPLOYEE = {
  employee: true,
} as const satisfies Prisma.UserInclude;

type UserWithEmployee = Prisma.UserGetPayload<{
  include: typeof USER_WITH_EMPLOYEE;
}>;

/** Employee statuses that block login (spec §3.2). On Leave may log in. */
const BLOCKED_EMPLOYEE = new Set(['SUSPENDED', 'EXITED']);

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsRepository,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly policy: PolicyService,
    private readonly passwords: PasswordPolicyService,
    private readonly tokens: AuthTokensService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  private findByEmail(email: string) {
    return this.prisma.db.user.findFirst({
      where: { email: { equals: email.trim(), mode: 'insensitive' } },
      include: USER_WITH_EMPLOYEE,
    });
  }

  private async event(
    type: LoginEventType,
    success: boolean,
    email: string,
    userId?: number,
    meta?: SessionMetadata,
    reason?: string,
  ) {
    await this.prisma.dbRaw.loginEvent.create({
      data: {
        type,
        success,
        email: email.toLowerCase(),
        userId,
        reason,
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent?.slice(0, 500),
      },
    });
  }

  // ── login ────────────────────────────────────────────────────────────────

  async login(dto: LoginDto, meta?: SessionMetadata): Promise<LoginResult> {
    const user = await this.findByEmail(dto.email);
    const fail = async (
      reason: string,
      message: string,
      args?: object,
    ): Promise<never> => {
      await this.event(
        'LOGIN_FAILED',
        false,
        dto.email,
        user?.id,
        meta,
        reason,
      );
      this.logger.warn(`Login failed (${reason}): ${dto.email}`);
      throw new UnauthorizedException(args ? { message, args } : message);
    };

    if (!user) return fail('unknown_email', 'errors.invalid_credentials');

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60_000,
      );
      return fail('locked', 'errors.account_locked', { minutes });
    }

    const passwordOk =
      !!user.password && (await bcrypt.compare(dto.password, user.password));
    if (!passwordOk) {
      if (user.password) await this.registerFailure(user, meta);
      return fail('bad_password', 'errors.invalid_credentials');
    }

    // Status checks only after the password is proven, so they don't leak
    // which accounts exist.
    if (user.status === 'PENDING_ACTIVATION') {
      return fail('not_activated', 'errors.account_not_activated');
    }
    if (user.status === 'DEACTIVATED') {
      return fail('deactivated', 'errors.account_deactivated');
    }
    if (BLOCKED_EMPLOYEE.has(user.employee.status)) {
      return fail(
        `employee_${user.employee.status.toLowerCase()}`,
        'errors.account_deactivated',
      );
    }

    const required = await this.twoFactor.isRequired(user.id);
    if ((user.twoFactorEnabled || required) && !this.config.devDisable2fa) {
      const challengeToken = await this.jwt.signAsync(
        { sub: user.uniqueId, typ: '2fa' },
        { secret: this.config.jwtAccess.secret, expiresIn: CHALLENGE_TTL },
      );
      return {
        challenge: { challengeToken, setupRequired: !user.twoFactorEnabled },
      };
    }
    return { tokens: await this.completeLogin(user, meta) };
  }

  private async completeLogin(
    user: UserWithEmployee,
    meta?: SessionMetadata,
  ): Promise<AuthTokens> {
    await this.prisma.db.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        status: 'ACTIVE',
        lastLoginAt: new Date(),
        lastLoginIp: meta?.ipAddress,
      },
    });
    await this.event('LOGIN', true, user.email, user.id, meta);
    this.logger.log(`Login: ${user.email}`);
    return this.startSession(user, meta);
  }

  // ── two-factor second step ───────────────────────────────────────────────

  /** Resolve a challenge token to a user who may still log in. */
  private async challengeUser(token: string): Promise<UserWithEmployee> {
    let payload: { sub: string; typ: string };
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: this.config.jwtAccess.secret,
      });
    } catch {
      throw new UnauthorizedException('errors.two_factor_challenge_expired');
    }
    if (payload.typ !== '2fa') {
      throw new UnauthorizedException('errors.two_factor_challenge_expired');
    }
    const user = await this.prisma.db.user.findFirst({
      where: { uniqueId: payload.sub },
      include: USER_WITH_EMPLOYEE,
    });
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      BLOCKED_EMPLOYEE.has(user.employee.status) ||
      (user.lockedUntil && user.lockedUntil > new Date())
    ) {
      throw new UnauthorizedException('errors.two_factor_challenge_expired');
    }
    return user;
  }

  /** Second step: a valid authenticator or emailed code finishes the login. */
  async verifyTwoFactor(
    challengeToken: string,
    code: string,
    meta?: SessionMetadata,
  ): Promise<AuthTokens> {
    const user = await this.challengeUser(challengeToken);
    if (!(await this.twoFactor.verify(user.id, code))) {
      await this.event(
        'TWO_FACTOR',
        false,
        user.email,
        user.id,
        meta,
        'bad_code',
      );
      // Wrong codes count towards the same lockout as wrong passwords.
      await this.registerFailure(user, meta);
      throw new UnauthorizedException('errors.two_factor_invalid_code');
    }
    await this.event('TWO_FACTOR', true, user.email, user.id, meta);
    return this.completeLogin(user, meta);
  }

  async sendTwoFactorEmail(challengeToken: string, meta?: SessionMetadata) {
    const user = await this.challengeUser(challengeToken);
    await this.twoFactor.sendEmailCode(user.id);
    await this.event(
      'TWO_FACTOR',
      true,
      user.email,
      user.id,
      meta,
      'email_code_sent',
    );
  }

  /** Enrolment during login, when a role requires 2FA. */
  async challengeSetup(challengeToken: string) {
    const user = await this.challengeUser(challengeToken);
    return this.twoFactor.beginSetup(user.id);
  }

  async challengeEnable(
    challengeToken: string,
    code: string,
    meta?: SessionMetadata,
  ): Promise<AuthTokens> {
    const user = await this.challengeUser(challengeToken);
    await this.twoFactor.confirmSetup(user.id, code);
    await this.event('TWO_FACTOR', true, user.email, user.id, meta, 'enrolled');
    return this.completeLogin(user, meta);
  }

  private async registerFailure(
    user: UserWithEmployee,
    meta?: SessionMetadata,
  ) {
    const lockout = await this.policy.lockoutPolicy();
    const updated = await this.prisma.db.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: { increment: 1 } },
    });
    if (updated.failedLoginAttempts >= lockout.maxAttempts) {
      const lockedUntil = new Date(Date.now() + lockout.lockMinutes * 60_000);
      await this.prisma.db.user.update({
        where: { id: user.id },
        data: { lockedUntil, failedLoginAttempts: 0 },
      });
      await this.event('LOCKED', true, user.email, user.id, meta);
      this.logger.warn(`Account locked: ${user.email}`);
      throw new UnauthorizedException({
        message: 'errors.account_locked',
        args: { minutes: lockout.lockMinutes },
      });
    }
  }

  // ── sessions ─────────────────────────────────────────────────────────────

  /** New session: idle window + absolute lifetime from security settings. */
  private async startSession(
    user: { id: number; uniqueId: string; email: string },
    meta?: SessionMetadata,
    absoluteExpiresAt?: Date,
  ): Promise<AuthTokens> {
    const { idleMinutes, absoluteHours } = await this.policy.sessionPolicy();
    const now = Date.now();
    const absolute =
      absoluteExpiresAt ?? new Date(now + absoluteHours * 3_600_000);
    const expiresAt = new Date(
      Math.min(now + idleMinutes * 60_000, absolute.getTime()),
    );
    const session = await this.sessions.create({
      userId: user.id,
      expiresAt,
      absoluteExpiresAt: absolute,
      userAgent: meta?.userAgent?.slice(0, 500),
      ipAddress: meta?.ipAddress,
    });

    const payload: JwtPayload = {
      sub: user.uniqueId,
      email: user.email,
      sid: session.uniqueId,
    };
    const refreshSeconds = Math.max(
      1,
      Math.floor((expiresAt.getTime() - now) / 1000),
    );
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.jwtAccess.secret,
        expiresIn: this.config.jwtAccess
          .expiresIn as JwtSignOptions['expiresIn'],
      }),
      this.jwt.signAsync(payload, {
        secret: this.config.jwtRefresh.secret,
        expiresIn: refreshSeconds,
      }),
    ]);
    return { accessToken, refreshToken, refreshExpiresAt: expiresAt };
  }

  async refresh(refreshToken: string, meta?: SessionMetadata) {
    const payload = await this.verifyRefresh(refreshToken);
    const session = await this.sessions.findActiveByUniqueId(payload.sid);
    if (!session) throw new UnauthorizedException('errors.session_expired');

    const user = await this.prisma.db.user.findFirst({
      where: { uniqueId: payload.sub },
      include: USER_WITH_EMPLOYEE,
    });
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      BLOCKED_EMPLOYEE.has(user.employee.status)
    ) {
      throw new UnauthorizedException('errors.session_expired');
    }

    // Rotate: the old refresh token dies; the absolute cap carries over.
    await this.sessions.revoke(session.uniqueId);
    return this.startSession(user, meta, session.absoluteExpiresAt);
  }

  async logout(refreshToken: string): Promise<void> {
    try {
      const payload = await this.verifyRefresh(refreshToken);
      await this.sessions.revoke(payload.sid);
      await this.event('LOGOUT', true, payload.email);
    } catch {
      // Already invalid — logout is idempotent.
    }
  }

  async logoutAll(userId: number): Promise<void> {
    await this.sessions.revokeAllForUser(userId);
  }

  private async verifyRefresh(token: string): Promise<JwtPayload> {
    try {
      return await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.config.jwtRefresh.secret,
      });
    } catch {
      throw new UnauthorizedException('errors.invalid_refresh_token');
    }
  }

  getSessions(userId: number) {
    return this.sessions.findAllActiveForUser(userId);
  }

  async revokeSession(userId: number, sessionUniqueId: string) {
    const s = await this.sessions.findActiveByUniqueIdAndUser(
      sessionUniqueId,
      userId,
    );
    if (!s) throw new BadRequestException('errors.session_not_found');
    await this.sessions.revoke(s.uniqueId);
  }

  // ── passwords ────────────────────────────────────────────────────────────

  /** Shared by activation, reset and change: history + hash. */
  private async setPassword(
    user: UserWithEmployee,
    password: string,
    tx: DbTx,
  ) {
    const hash = await bcrypt.hash(password, 12);
    if (user.password) {
      await tx.passwordHistory.create({
        data: { userId: user.id, hash: user.password },
      });
    }
    await tx.user.update({
      where: { id: user.id },
      data: {
        password: hash,
        passwordChangedAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
  }

  private owner(user: UserWithEmployee) {
    return {
      userId: user.id,
      email: user.email,
      firstName: user.employee.firstName,
      lastName: user.employee.lastName,
      currentHash: user.password,
    };
  }

  /** Activation link: the user sets their own first password. */
  async activate(token: string, password: string, meta?: SessionMetadata) {
    const row = await this.tokens.find(token, 'ACTIVATION');
    if (!row) throw new BadRequestException('errors.invalid_token');
    const user = await this.prisma.db.user.findFirst({
      where: { id: row.userId },
      include: USER_WITH_EMPLOYEE,
    });
    if (
      !user ||
      user.status !== 'PENDING_ACTIVATION' ||
      BLOCKED_EMPLOYEE.has(user.employee.status)
    ) {
      throw new BadRequestException('errors.invalid_token');
    }
    await this.passwords.validate(password, this.owner(user));

    await this.prisma.db.$transaction(async (tx) => {
      await this.setPassword(user, password, tx);
      await tx.user.update({
        where: { id: user.id },
        data: { status: 'ACTIVE' },
      });
      await this.tokens.consume(row.id, tx);
    });
    await this.event('ACTIVATED', true, user.email, user.id, meta);
    this.logger.log(`Activated: ${user.email}`);
  }

  /**
   * Self-service reset link. Always answers the same way so the endpoint
   * cannot be used to discover accounts. Not for locked/deactivated users.
   */
  async forgotPassword(email: string, meta?: SessionMetadata): Promise<void> {
    const user = await this.findByEmail(email);
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      (user.lockedUntil && user.lockedUntil > new Date()) ||
      BLOCKED_EMPLOYEE.has(user.employee.status)
    ) {
      return;
    }
    const minutes = await this.policy.resetMinutes();
    const token = await this.tokens.issue(
      user.id,
      'PASSWORD_RESET',
      minutes * 60_000,
    );
    await this.mail.queuePasswordResetEmail({
      email: user.email,
      firstName: user.employee.firstName,
      token,
      locale: user.preferredLocale,
      validFor: minutes,
    });
    await this.event(
      'PASSWORD_RESET_REQUESTED',
      true,
      user.email,
      user.id,
      meta,
    );
  }

  async resetPassword(token: string, password: string, meta?: SessionMetadata) {
    const row = await this.tokens.find(token, 'PASSWORD_RESET');
    if (!row) throw new BadRequestException('errors.invalid_token');
    const user = await this.prisma.db.user.findFirst({
      where: { id: row.userId },
      include: USER_WITH_EMPLOYEE,
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new BadRequestException('errors.invalid_token');
    }
    await this.passwords.validate(password, this.owner(user));
    await this.prisma.db.$transaction(async (tx) => {
      await this.setPassword(user, password, tx);
      await this.tokens.consume(row.id, tx);
    });
    // Sessions end on password change.
    await this.sessions.revokeAllForUser(user.id);
    await this.event('PASSWORD_RESET', true, user.email, user.id, meta);
  }

  async changePassword(
    userUniqueId: string,
    currentPassword: string,
    newPassword: string,
    currentSessionId?: string,
    meta?: SessionMetadata,
  ) {
    const user = await this.prisma.db.user.findFirst({
      where: { uniqueId: userUniqueId },
      include: USER_WITH_EMPLOYEE,
    });
    if (!user?.password) {
      throw new UnauthorizedException('errors.user_not_found');
    }
    if (!(await bcrypt.compare(currentPassword, user.password))) {
      throw new UnauthorizedException('errors.current_password_incorrect');
    }
    await this.passwords.validate(newPassword, this.owner(user));
    await this.prisma.db.$transaction((tx) =>
      this.setPassword(user, newPassword, tx),
    );
    // Other sessions end; the current one stays so the user isn't kicked out.
    await this.sessions.revokeAllForUser(user.id, currentSessionId);
    await this.event('PASSWORD_CHANGED', true, user.email, user.id, meta);
    await this.audit.log({
      action: 'user.change_password',
      entityType: 'User',
      entityId: user.uniqueId,
    });
  }
}
