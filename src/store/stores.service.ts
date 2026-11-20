import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, StoreLocation } from '@db';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import type {
  SaveLocationInput,
  SaveStoreInput,
  StockSettingInput,
} from './store.types';

/** Locations every store gets (B2 §2.1). */
const SYSTEM_LOCATIONS = {
  MAIN: [
    { code: 'RECEIVING', name: 'Receiving / Quarantine', kind: 'RECEIVING' },
    { code: 'REJECTED', name: 'Rejected', kind: 'REJECTED' },
    { code: 'TRANSIT', name: 'In transit', kind: 'IN_TRANSIT' },
  ],
  SUB: [{ code: 'TRANSIT', name: 'In transit', kind: 'IN_TRANSIT' }],
} as const;

export interface StockScope {
  all: boolean;
  storeIds: number[];
  departmentIds: number[];
}

export function locationPath(
  loc: Pick<StoreLocation, 'id' | 'name' | 'parentId'>,
  all: Pick<StoreLocation, 'id' | 'name' | 'parentId'>[],
) {
  const byId = new Map(all.map((l) => [l.id, l]));
  const parts: string[] = [];
  let cur: typeof loc | undefined = loc;
  for (let i = 0; cur && i < 6; i++) {
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(' / ');
}

/**
 * Stores and locations (B2 §2.1), stock levels per product per store, and
 * the scope helpers the store screens share. Storekeepers are users with
 * a role assigned in the store's context (A1 role context).
 */
@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  // ── scope helpers ────────────────────────────────────────────────────────

  /** stock.view: all · assigned stores · products owned by own department. */
  async stockScope(user: CurrentUser): Promise<StockScope> {
    const s = await this.access.resolveScope(user, 'stock.view');
    return { all: s.all, storeIds: s.storeIds, departmentIds: s.departmentIds };
  }

  /** Assets the user may see: asset.view (all / owning dept) or stock.view. */
  async assetWhere(user: CurrentUser): Promise<Prisma.AssetWhereInput> {
    const [a, s] = await Promise.all([
      this.access.resolveScope(user, 'asset.view'),
      this.stockScope(user),
    ]);
    if (a.all || s.all) return {};
    const or: Prisma.AssetWhereInput[] = [];
    const depts = [...new Set([...a.departmentIds, ...s.departmentIds])];
    if (depts.length) or.push({ owningDepartmentId: { in: depts } });
    if (s.storeIds.length) or.push({ storeId: { in: s.storeIds } });
    if (!or.length) throw new ForbiddenException('errors.forbidden');
    return { OR: or };
  }

  /** Stores whose stock the user sees in full (all or assigned). */
  async canSeeStore(user: CurrentUser, storeId: number) {
    const s = await this.stockScope(user);
    return s.all || s.storeIds.includes(storeId);
  }

  // ── stores ───────────────────────────────────────────────────────────────

  private async storekeepers(storeIds: number[]) {
    const roles = await this.prisma.db.userRole.findMany({
      where: { contextType: 'STORE', contextId: { in: storeIds } },
      include: { user: { include: { employee: true } } },
    });
    const by = new Map<
      number,
      { uniqueId: string; fullName: string; email: string }[]
    >();
    for (const r of roles) {
      if (r.user.status !== 'ACTIVE' || r.contextId == null) continue;
      const list = by.get(r.contextId) ?? [];
      if (!list.some((p) => p.uniqueId === r.user.uniqueId)) {
        list.push({
          uniqueId: r.user.uniqueId,
          fullName: `${r.user.employee.firstName} ${r.user.employee.lastName}`,
          email: r.user.email,
        });
      }
      by.set(r.contextId, list);
    }
    return by;
  }

  async list(user: CurrentUser, includeInactive = false) {
    const canSee =
      (await this.access.can(user, 'store.manage')) ||
      (await this.access.can(user, 'stock.view')) ||
      (await this.access.can(user, 'asset.view')) ||
      // Administrators pick a store when assigning store roles.
      (await this.access.can(user, 'user.assign_role'));
    if (!canSee) throw new ForbiddenException('errors.forbidden');
    const stores = await this.prisma.db.store.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      include: {
        managingDepartment: true,
        locations: { orderBy: [{ kind: 'asc' }, { code: 'asc' }] },
        _count: { select: { assets: true } },
      },
    });
    const keepers = await this.storekeepers(stores.map((s) => s.id));
    return stores.map((s) => ({
      uniqueId: s.uniqueId,
      code: s.code,
      name: s.name,
      type: s.type,
      address: s.address,
      isActive: s.isActive,
      managingDepartment: {
        uniqueId: s.managingDepartment.uniqueId,
        code: s.managingDepartment.code,
        name: s.managingDepartment.name,
      },
      locations: s.locations.map((l) => ({
        uniqueId: l.uniqueId,
        code: l.code,
        name: l.name,
        kind: l.kind,
        isActive: l.isActive,
        parentUniqueId:
          s.locations.find((p) => p.id === l.parentId)?.uniqueId ?? null,
        path: locationPath(l, s.locations),
      })),
      storekeepers: keepers.get(s.id) ?? [],
      assetCount: s._count.assets,
    }));
  }

  async get(user: CurrentUser, uniqueId: string) {
    const all = await this.list(user, true);
    const s = all.find((x) => x.uniqueId === uniqueId);
    if (!s) throw new NotFoundException('errors.record_not_found');
    return s;
  }

  async byUniqueId(uniqueId: string) {
    const s = await this.prisma.db.store.findUnique({ where: { uniqueId } });
    if (!s) throw new NotFoundException('errors.record_not_found');
    return s;
  }

  async save(actor: CurrentUser, input: SaveStoreInput) {
    await this.access.assert(actor, 'store.manage');
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9-]+$/.test(code))
      throw new BadRequestException('errors.code_format');
    const dept = await this.prisma.db.department.findUnique({
      where: { uniqueId: input.managingDepartmentUniqueId },
    });
    if (!dept) throw new BadRequestException('errors.department_not_found');
    const clash = await this.prisma.db.store.findFirst({
      where: {
        code,
        ...(input.uniqueId ? { NOT: { uniqueId: input.uniqueId } } : {}),
      },
    });
    if (clash) throw new BadRequestException('errors.store_code_in_use');
    if (input.type === 'MAIN') {
      const main = await this.prisma.db.store.findFirst({
        where: {
          type: 'MAIN',
          ...(input.uniqueId ? { NOT: { uniqueId: input.uniqueId } } : {}),
        },
      });
      if (main) throw new BadRequestException('errors.store_one_main');
    }
    const data = {
      code,
      name: input.name.trim(),
      type: input.type,
      managingDepartmentId: dept.id,
      address: input.address?.trim() || null,
      isActive: input.isActive,
    };
    const saved = await this.prisma.db.$transaction(async (tx) => {
      if (input.uniqueId) {
        const before = await tx.store.findUnique({
          where: { uniqueId: input.uniqueId },
        });
        if (!before) throw new NotFoundException('errors.record_not_found');
        if (before.type !== input.type) {
          throw new BadRequestException('errors.store_type_locked');
        }
        if (before.isActive && !input.isActive) {
          const [assets, stock] = await Promise.all([
            tx.asset.count({
              where: {
                storeId: before.id,
                status: { notIn: ['DISPOSED', 'LOST'] },
              },
            }),
            tx.stockBalance.count({
              where: {
                storeId: before.id,
                OR: [{ onHand: { gt: 0 } }, { quarantine: { gt: 0 } }],
              },
            }),
          ]);
          if (assets || stock)
            throw new BadRequestException('errors.store_not_empty');
        }
        const s = await tx.store.update({ where: { id: before.id }, data });
        await this.audit.log(
          {
            action: 'store.update',
            entityType: 'Store',
            entityId: s.uniqueId,
            before,
            after: s,
          },
          tx,
        );
        return s;
      }
      const s = await tx.store.create({
        data: {
          ...data,
          locations: {
            create: SYSTEM_LOCATIONS[input.type].map((l) => ({ ...l })),
          },
        },
      });
      await this.audit.log(
        {
          action: 'store.create',
          entityType: 'Store',
          entityId: s.uniqueId,
          after: s,
        },
        tx,
      );
      return s;
    });
    return this.get(actor, saved.uniqueId);
  }

  async saveLocation(actor: CurrentUser, input: SaveLocationInput) {
    await this.access.assert(actor, 'store.manage');
    const store = await this.byUniqueId(input.storeUniqueId);
    const code = input.code.trim().toUpperCase();
    const locations = await this.prisma.db.storeLocation.findMany({
      where: { storeId: store.id },
    });
    const existing = input.uniqueId
      ? locations.find((l) => l.uniqueId === input.uniqueId)
      : undefined;
    if (input.uniqueId && !existing)
      throw new NotFoundException('errors.record_not_found');
    if (existing && existing.kind !== 'GENERAL') {
      throw new BadRequestException('errors.location_system');
    }
    if (locations.some((l) => l.code === code && l.id !== existing?.id)) {
      throw new BadRequestException('errors.location_code_in_use');
    }
    const parent = input.parentUniqueId
      ? locations.find((l) => l.uniqueId === input.parentUniqueId)
      : undefined;
    if (input.parentUniqueId && (!parent || parent.kind !== 'GENERAL')) {
      throw new BadRequestException('errors.location_parent_invalid');
    }
    // No cycles: the parent may not be the location itself or below it.
    for (let p = parent; p; p = locations.find((l) => l.id === p.parentId)) {
      if (existing && p.id === existing.id) {
        throw new BadRequestException('errors.location_parent_invalid');
      }
    }
    if (existing && existing.isActive && !input.isActive) {
      const [assets, stock] = await Promise.all([
        this.prisma.db.asset.count({ where: { locationId: existing.id } }),
        this.prisma.db.stockBalance.count({
          where: {
            locationId: existing.id,
            OR: [{ onHand: { gt: 0 } }, { quarantine: { gt: 0 } }],
          },
        }),
      ]);
      if (assets || stock)
        throw new BadRequestException('errors.location_not_empty');
    }
    const data = {
      code,
      name: input.name.trim(),
      parentId: parent?.id ?? null,
      isActive: input.isActive,
    };
    await this.prisma.db.$transaction(async (tx) => {
      const loc = existing
        ? await tx.storeLocation.update({ where: { id: existing.id }, data })
        : await tx.storeLocation.create({
            data: { ...data, storeId: store.id, kind: 'GENERAL' },
          });
      await this.audit.log(
        {
          action: existing ? 'store.location_update' : 'store.location_create',
          entityType: 'StoreLocation',
          entityId: loc.uniqueId,
          before: existing,
          after: { ...loc, store: store.code },
        },
        tx,
      );
    });
    return this.get(actor, store.uniqueId);
  }

  // ── stock settings ───────────────────────────────────────────────────────

  async settings(user: CurrentUser, storeUniqueId: string) {
    const store = await this.byUniqueId(storeUniqueId);
    if (
      !(await this.access.can(user, 'store.manage')) &&
      !(await this.canSeeStore(user, store.id))
    ) {
      throw new ForbiddenException('errors.forbidden');
    }
    const rows = await this.prisma.db.stockSetting.findMany({
      where: { storeId: store.id },
      include: {
        product: { include: { currentVersion: true } },
      },
    });
    const locations = await this.prisma.db.storeLocation.findMany({
      where: { storeId: store.id },
    });
    return rows
      .map((r) => ({
        productUniqueId: r.product.uniqueId,
        productCode: r.product.code,
        productName: r.product.currentVersion?.name ?? '—',
        unit: r.product.currentVersion?.unit ?? '',
        minLevel: r.minLevel,
        reorderLevel: r.reorderLevel,
        maxLevel: r.maxLevel,
        defaultLocationUniqueId:
          locations.find((l) => l.id === r.defaultLocationId)?.uniqueId ?? null,
      }))
      .sort((a, b) => a.productName.localeCompare(b.productName));
  }

  async saveSetting(actor: CurrentUser, input: StockSettingInput) {
    await this.access.assert(actor, 'store.manage');
    const store = await this.byUniqueId(input.storeUniqueId);
    const product = await this.prisma.db.product.findUnique({
      where: { uniqueId: input.productUniqueId },
    });
    if (!product || !product.currentVersionId) {
      throw new BadRequestException('errors.product_not_active');
    }
    if (input.reorderLevel < input.minLevel) {
      throw new BadRequestException('errors.stock_levels_order');
    }
    if (input.maxLevel != null && input.maxLevel < input.reorderLevel) {
      throw new BadRequestException('errors.stock_levels_order');
    }
    let defaultLocationId: number | null = null;
    if (input.defaultLocationUniqueId) {
      const loc = await this.prisma.db.storeLocation.findUnique({
        where: { uniqueId: input.defaultLocationUniqueId },
      });
      if (!loc || loc.storeId !== store.id || loc.kind !== 'GENERAL') {
        throw new BadRequestException('errors.location_not_found');
      }
      defaultLocationId = loc.id;
    }
    const data = {
      minLevel: input.minLevel,
      reorderLevel: input.reorderLevel,
      maxLevel: input.maxLevel ?? null,
      defaultLocationId,
    };
    await this.prisma.db.$transaction(async (tx) => {
      const before = await tx.stockSetting.findUnique({
        where: {
          storeId_productId: { storeId: store.id, productId: product.id },
        },
      });
      await tx.stockSetting.upsert({
        where: {
          storeId_productId: { storeId: store.id, productId: product.id },
        },
        update: data,
        create: { ...data, storeId: store.id, productId: product.id },
      });
      await this.audit.log(
        {
          action: 'store.stock_setting',
          entityType: 'StockSetting',
          entityId: `${store.code}/${product.code}`,
          before,
          after: data,
        },
        tx,
      );
    });
    return this.settings(actor, store.uniqueId);
  }
}
