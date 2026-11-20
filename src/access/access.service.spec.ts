import { ForbiddenException } from '@nestjs/common';
import type { CurrentUser } from '@common';
import { AccessService, EffectiveGrant } from './access.service';

function grant(
  permission: string,
  scope: EffectiveGrant['scope'],
  extra: Partial<EffectiveGrant> = {},
): EffectiveGrant {
  return {
    permission,
    scope,
    contextType: null,
    contextId: null,
    valueLimit: null,
    roleId: 1,
    onBehalfOfUserId: null,
    ...extra,
  };
}

const user: CurrentUser = {
  id: 7,
  uniqueId: 'u-7',
  email: 'hod@azamtv.co.tz',
  employeeId: 70,
  departmentId: 10,
  preferredLocale: 'en',
};

/** In-memory cache stub matching the cache-manager surface we use. */
function memoryCache() {
  const store = new Map<string, unknown>();
  return {
    get: jest.fn((k: string) => Promise.resolve(store.get(k))),
    set: jest.fn((k: string, v: unknown) => {
      store.set(k, v);
      return Promise.resolve();
    }),
    del: jest.fn((k: string) => {
      store.delete(k);
      return Promise.resolve();
    }),
  };
}

function build(grants: EffectiveGrant[], sectionIds: number[] = [11]) {
  const prisma = {
    db: {
      department: {
        findMany: jest.fn().mockResolvedValue(sectionIds.map((id) => ({ id }))),
      },
    },
  };
  const service = new AccessService(prisma as never, memoryCache() as never);
  jest.spyOn(service, 'getGrants').mockResolvedValue(grants);
  return service;
}

describe('AccessService', () => {
  it('denies when the user holds no grant for the permission', async () => {
    const access = build([grant('employee.view', 'ALL')]);
    expect(await access.can(user, 'employee.manage')).toBe(false);
  });

  it('own_department matches the department and its sections only', async () => {
    const access = build([grant('employee.view', 'OWN_DEPARTMENT')]);
    expect(await access.can(user, 'employee.view', { departmentId: 10 })).toBe(
      true,
    );
    expect(await access.can(user, 'employee.view', { departmentId: 11 })).toBe(
      true,
    );
    expect(await access.can(user, 'employee.view', { departmentId: 99 })).toBe(
      false,
    );
  });

  it('own_records matches created records and the own employee record', async () => {
    const access = build([grant('employee.view', 'OWN_RECORDS')]);
    expect(
      await access.can(user, 'employee.view', { subjectEmployeeId: 70 }),
    ).toBe(true);
    expect(
      await access.can(user, 'employee.view', { ownerUserIds: [7, 8] }),
    ).toBe(true);
    expect(
      await access.can(user, 'employee.view', { subjectEmployeeId: 71 }),
    ).toBe(false);
  });

  it('assigned_store only matches the store given as role context', async () => {
    const access = build([
      grant('employee.view', 'ASSIGNED_STORE', {
        contextType: 'STORE',
        contextId: 3,
      }),
    ]);
    expect(await access.can(user, 'employee.view', { storeId: 3 })).toBe(true);
    expect(await access.can(user, 'employee.view', { storeId: 4 })).toBe(false);
  });

  it('assert throws Forbidden on denial', async () => {
    const access = build([grant('employee.view', 'OWN_DEPARTMENT')]);
    await expect(
      access.assert(user, 'employee.view', { departmentId: 99 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('scopeWhere', () => {
    const builders = {
      department: (ids: number[]) => ({ departmentId: { in: ids } }),
      ownRecords: (u: CurrentUser) => ({ id: u.employeeId }),
    };

    it('returns an empty filter for scope ALL', async () => {
      const access = build([
        grant('employee.view', 'OWN_RECORDS'),
        grant('employee.view', 'ALL'),
      ]);
      expect(
        await access.scopeWhere<Record<string, unknown>>(
          user,
          'employee.view',
          builders,
        ),
      ).toEqual({});
    });

    it('ORs together every scope the user holds', async () => {
      const access = build([
        grant('employee.view', 'OWN_DEPARTMENT'),
        grant('employee.view', 'OWN_RECORDS'),
      ]);
      expect(
        await access.scopeWhere<Record<string, unknown>>(
          user,
          'employee.view',
          builders,
        ),
      ).toEqual({
        OR: [{ departmentId: { in: [10, 11] } }, { id: 70 }],
      });
    });

    it('throws when no held scope applies to the model', async () => {
      const access = build([grant('employee.view', 'ASSIGNED')]);
      await expect(
        access.scopeWhere<Record<string, unknown>>(
          user,
          'employee.view',
          builders,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
