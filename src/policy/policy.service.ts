import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import type { Prisma } from '@db';
import { PrismaService } from '@prisma';
import { RequestContext } from '@common';
import { AuditService } from '../audit/audit.service';
import { POLICY_CATALOGUE, PolicyCode, SodCode } from './policy.catalogue';
import { syncPolicyCatalogue } from './policy-sync';

const CACHE_TTL_MS = 60_000;

export interface PasswordPolicy {
  minLength: number;
  historyCount: number;
  expiryDays: number | null;
}
export interface LockoutPolicy {
  maxAttempts: number;
  lockMinutes: number;
}
export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
}

@Injectable()
export class PolicyService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await syncPolicyCatalogue(this.prisma.dbRaw);
  }

  list() {
    return this.prisma.dbRaw.policySetting.findMany({
      orderBy: [{ category: 'asc' }, { code: 'asc' }],
    });
  }

  private async get(code: PolicyCode) {
    const key = `policy:${code}`;
    const cached = await this.cache.get<{
      enabled: boolean;
      parameters: Record<string, unknown> | null;
    }>(key);
    if (cached) return cached;
    const row = await this.prisma.dbRaw.policySetting.findUnique({
      where: { code },
    });
    const def = POLICY_CATALOGUE[code];
    const value = {
      enabled: row?.enabled ?? def.enabled,
      parameters: {
        ...('parameters' in def ? def.parameters : {}),
        ...((row?.parameters as Record<string, unknown> | null) ?? {}),
      },
    };
    await this.cache.set(key, value, CACHE_TTL_MS);
    return value;
  }

  async isEnabled(code: PolicyCode): Promise<boolean> {
    return (await this.get(code)).enabled;
  }

  async params<T>(code: PolicyCode): Promise<T> {
    return (await this.get(code)).parameters as T;
  }

  /**
   * Enforce a separation-of-duties rule: when the rule is switched on and
   * `violated` is true, the action is denied.
   */
  async enforceSod(code: SodCode, violated: boolean): Promise<void> {
    if (!violated) return;
    if (!(await this.isEnabled(code))) return;
    this.logger.warn(
      `SoD ${code} denied action for user #${RequestContext.getUserId()}`,
    );
    throw new ForbiddenException({
      message: 'errors.sod_violation',
      args: { rule: code },
    });
  }

  passwordPolicy() {
    return this.params<PasswordPolicy>('SECURITY_PASSWORD_POLICY');
  }
  lockoutPolicy() {
    return this.params<LockoutPolicy>('SECURITY_LOCKOUT');
  }
  sessionPolicy() {
    return this.params<SessionPolicy>('SECURITY_SESSIONS');
  }
  async activationHours(): Promise<number> {
    return (
      await this.params<{ validHours: number }>('SECURITY_ACTIVATION_LINK')
    ).validHours;
  }
  async resetMinutes(): Promise<number> {
    return (await this.params<{ validMinutes: number }>('SECURITY_RESET_LINK'))
      .validMinutes;
  }
  async allowedEmailDomains(): Promise<string[]> {
    const p = await this.params<{ domains: string[] }>(
      'SECURITY_EMAIL_DOMAINS',
    );
    return (p.domains ?? []).map((d) => d.toLowerCase());
  }

  async isAllowedEmail(email: string): Promise<boolean> {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return false;
    return (await this.allowedEmailDomains()).includes(domain);
  }

  /** Edit a setting (audited, versioned). */
  async update(
    code: string,
    input: { enabled?: boolean; parameters?: Record<string, unknown> },
  ) {
    if (!(code in POLICY_CATALOGUE)) {
      throw new NotFoundException('errors.record_not_found');
    }
    const before = await this.prisma.dbRaw.policySetting.findUnique({
      where: { code },
    });
    if (!before) throw new NotFoundException('errors.record_not_found');
    if (
      input.parameters &&
      (typeof input.parameters !== 'object' || Array.isArray(input.parameters))
    ) {
      throw new BadRequestException('errors.invalid_parameters');
    }
    const after = await this.prisma.dbRaw.policySetting.update({
      where: { code },
      data: {
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.parameters && {
          parameters: input.parameters as Prisma.InputJsonValue,
        }),
        version: { increment: 1 },
        updatedById: RequestContext.getUserId(),
      },
    });
    await this.cache.del(`policy:${code}`);
    await this.audit.log({
      action: 'policy.update',
      entityType: 'PolicySetting',
      entityId: code,
      before,
      after,
    });
    return after;
  }
}
