import { BadRequestException } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { PasswordPolicyService } from './password-policy.service';

const owner = {
  userId: 1,
  email: 'rehema.said@azamtv.co.tz',
  firstName: 'Rehema',
  lastName: 'Said',
};

function build(historyHashes: string[] = []) {
  const prisma = {
    dbRaw: {
      passwordHistory: {
        findMany: jest
          .fn()
          .mockResolvedValue(historyHashes.map((hash) => ({ hash }))),
      },
    },
  };
  const policy = {
    passwordPolicy: jest
      .fn()
      .mockResolvedValue({ minLength: 10, historyCount: 5, expiryDays: null }),
  };
  return new PasswordPolicyService(prisma as never, policy as never);
}

async function rulesBroken(
  service: PasswordPolicyService,
  password: string,
  o = owner,
): Promise<string[]> {
  try {
    await service.validate(password, o);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    const body = (e as BadRequestException).getResponse() as {
      args: { rules: string };
    };
    return body.args.rules.split(',');
  }
}

describe('PasswordPolicyService', () => {
  it('accepts a strong password', async () => {
    expect(await rulesBroken(build(), 'Kilimanjaro-77x')).toEqual([]);
  });

  it('enforces length and letter + number', async () => {
    expect(await rulesBroken(build(), 'abc1')).toContain('min_length');
    expect(await rulesBroken(build(), 'onlyletterspassword')).toContain(
      'letter_and_number',
    );
  });

  it('rejects common passwords and names/email', async () => {
    expect(await rulesBroken(build(), 'Password123')).toContain('common');
    expect(await rulesBroken(build(), 'rehema2026xyz')).toContain(
      'contains_name',
    );
  });

  it('rejects the current password and the last N passwords', async () => {
    const old = await bcrypt.hash('Serengeti-2025a', 4);
    expect(await rulesBroken(build([old]), 'Serengeti-2025a')).toContain(
      'reused',
    );
    const current = await bcrypt.hash('Ngorongoro-99b', 4);
    expect(
      await rulesBroken(build(), 'Ngorongoro-99b', {
        ...owner,
        currentHash: current,
      } as never),
    ).toContain('reused');
  });
});
