import { BadRequestException, Injectable } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { PrismaService } from '@prisma';
import { PolicyService } from '../policy/policy.service';

/**
 * A short list of the most common passwords that still pass the length and
 * letter+number rules. Extend from a full list (e.g. SecLists) if needed.
 */
const COMMON = new Set(
  [
    'password1',
    'password12',
    'password123',
    'password1234',
    'passw0rd123',
    'qwerty1234',
    'qwerty12345',
    'qwertyuiop1',
    'abc1234567',
    'abcd123456',
    'welcome123',
    'welcome1234',
    'letmein123',
    'admin12345',
    'administrator1',
    'iloveyou12',
    'sunshine12',
    'football12',
    'monkey1234',
    'dragon1234',
    'azamtv1234',
    'azamtv12345',
    'azam123456',
    'tanzania123',
    'tanzania2024',
    'tanzania2025',
    'tanzania2026',
    'changeme123',
    'trustno1234',
    '1q2w3e4r5t',
    '1qaz2wsx3edc',
    'zaq12wsxcde',
    'p@ssw0rd123',
    'summer2026',
    'winter2026',
  ].map((p) => p.toLowerCase()),
);

export interface PasswordOwner {
  userId?: number;
  email: string;
  firstName: string;
  lastName: string;
  currentHash?: string | null;
}

@Injectable()
export class PasswordPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
  ) {}

  /** Throws BadRequest listing every rule the password breaks. */
  async validate(password: string, owner: PasswordOwner): Promise<void> {
    const rules = await this.policy.passwordPolicy();
    const errors: string[] = [];
    const lower = password.toLowerCase();

    if (password.length < rules.minLength) errors.push('min_length');
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      errors.push('letter_and_number');
    }
    if (COMMON.has(lower)) errors.push('common');
    const localPart = owner.email.split('@')[0].toLowerCase();
    const names = [owner.firstName, owner.lastName, localPart]
      .map((n) => n.toLowerCase())
      .filter((n) => n.length >= 3);
    if (names.some((n) => lower.includes(n))) errors.push('contains_name');

    if (!errors.length && owner.userId && rules.historyCount > 0) {
      const history = await this.prisma.dbRaw.passwordHistory.findMany({
        where: { userId: owner.userId },
        orderBy: { createdAt: 'desc' },
        take: rules.historyCount,
      });
      const hashes = [
        ...(owner.currentHash ? [owner.currentHash] : []),
        ...history.map((h) => h.hash),
      ].slice(0, rules.historyCount);
      for (const h of hashes) {
        if (await bcrypt.compare(password, h)) {
          errors.push('reused');
          break;
        }
      }
    }

    if (errors.length) {
      throw new BadRequestException({
        message: 'errors.password_policy',
        args: {
          rules: errors.join(','),
          minLength: rules.minLength,
          history: rules.historyCount,
        },
      });
    }
  }
}
