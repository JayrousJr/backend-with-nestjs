import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@db';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from './ledger.service';
import { locationPath, StoresService } from './stores.service';
import type {
  AssetFilterInput,
  MovementFilterInput,
  StockLevelFilterInput,
  UpdateAssetInput,
  VehicleInput,
} from './store.types';

const ASSET_INCLUDE = {
  product: { include: { currentVersion: { include: { category: true } } } },
  version: { include: { category: true } },
  owningDepartment: true,
  store: true,
  location: true,
  custodian: true,
  parent: { include: { version: true } },
  components: { include: { version: true }, orderBy: { tag: 'asc' } },
  vehicle: true,
} as const satisfies Prisma.AssetInclude;

type AssetRow = Prisma.AssetGetPayload<{ include: typeof ASSET_INCLUDE }>;

const OUT_STATUSES = [
  'CHECKED_OUT_TO_PRODUCTION',
  'ASSIGNED_TO_EMPLOYEE',
  'UNDER_MAINTENANCE',
  'AT_VENDOR_FOR_REPAIR',
] as const;

const day = (s?: string | null) =>
  s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null;

/** Asset register, stock levels, movements and tags (B2 §2.3, §3, §11). */
@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly stores: StoresService,
    private readonly ledger: LedgerService,
  ) {}

  // ── asset register ───────────────────────────────────────────────────────

  private async filterWhere(user: CurrentUser, f: AssetFilterInput = {}) {
    const and: Prisma.AssetWhereInput[] = [await this.stores.assetWhere(user)];
    if (f.search?.trim()) {
      const q = f.search.trim();
      and.push({
        OR: [
          { tag: { contains: q, mode: 'insensitive' } },
          { serialNumber: { contains: q, mode: 'insensitive' } },
          { brand: { contains: q, mode: 'insensitive' } },
          { model: { contains: q, mode: 'insensitive' } },
          { product: { code: { contains: q, mode: 'insensitive' } } },
          { version: { name: { contains: q, mode: 'insensitive' } } },
          {
            vehicle: {
              registrationNumber: { contains: q, mode: 'insensitive' },
            },
          },
        ],
      });
    }
    if (f.storeUniqueId) and.push({ store: { uniqueId: f.storeUniqueId } });
    if (f.statuses?.length) and.push({ status: { in: f.statuses } });
    if (f.categoryUniqueId)
      and.push({ version: { category: { uniqueId: f.categoryUniqueId } } });
    if (f.departmentUniqueId)
      and.push({ owningDepartment: { uniqueId: f.departmentUniqueId } });
    if (f.productUniqueId)
      and.push({ product: { uniqueId: f.productUniqueId } });
    if (f.vehiclesOnly) and.push({ product: { isVehicle: true } });
    return { AND: and } satisfies Prisma.AssetWhereInput;
  }

  async list(
    user: CurrentUser,
    f: AssetFilterInput = {},
    page = 1,
    limit = 20,
  ) {
    const where = await this.filterWhere(user, f);
    limit = Math.min(Math.max(limit, 1), 100);
    page = Math.max(page, 1);
    const [rows, total] = await Promise.all([
      this.prisma.db.asset.findMany({
        where,
        include: ASSET_INCLUDE,
        orderBy: { tag: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.db.asset.count({ where }),
    ]);
    return {
      data: await this.presentMany(user, rows),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** Rows for exports (no paging, same scope). */
  async exportRows(user: CurrentUser, f: AssetFilterInput = {}) {
    const where = await this.filterWhere(user, f);
    return this.prisma.db.asset.findMany({
      where,
      include: ASSET_INCLUDE,
      orderBy: { tag: 'asc' },
    });
  }

  private async load(where: Prisma.AssetWhereUniqueInput) {
    const a = await this.prisma.db.asset.findUnique({
      where,
      include: ASSET_INCLUDE,
    });
    if (!a || a.isDeleted)
      throw new NotFoundException('errors.record_not_found');
    return a;
  }

  private async assertVisible(user: CurrentUser, a: AssetRow) {
    const where = await this.stores.assetWhere(user);
    const n = await this.prisma.db.asset.count({
      where: { AND: [{ id: a.id }, where] },
    });
    if (!n) throw new ForbiddenException('errors.forbidden');
  }

  async get(user: CurrentUser, uniqueId: string) {
    const a = await this.load({ uniqueId });
    await this.assertVisible(user, a);
    return (await this.presentMany(user, [a]))[0];
  }

  /** Scan lookup: tag (QR content), case-insensitive. */
  async byTag(user: CurrentUser, tag: string) {
    const a = await this.prisma.db.asset.findFirst({
      where: { tag: { equals: tag.trim(), mode: 'insensitive' } },
      include: ASSET_INCLUDE,
    });
    if (!a) return null;
    await this.assertVisible(user, a);
    return (await this.presentMany(user, [a]))[0];
  }

  private vehicleData(v: VehicleInput) {
    return {
      registrationNumber: v.registrationNumber.trim().toUpperCase(),
      chassisNumber: v.chassisNumber?.trim() || null,
      engineNumber: v.engineNumber?.trim() || null,
      fuelType: v.fuelType?.trim() || null,
      seatingCapacity: v.seatingCapacity ?? null,
      insuranceExpiry: day(v.insuranceExpiry),
      roadLicenceExpiry: day(v.roadLicenceExpiry),
      serviceIntervalKm: v.serviceIntervalKm ?? null,
      serviceIntervalMonths: v.serviceIntervalMonths ?? null,
    };
  }

  /** Correct descriptive data (never status, location or custody). */
  async update(actor: CurrentUser, input: UpdateAssetInput) {
    const a = await this.load({ uniqueId: input.uniqueId });
    await this.access.assert(actor, 'asset.edit', { storeId: a.storeId });
    if (input.vehicle && !a.product.isVehicle) {
      throw new BadRequestException('errors.asset_not_vehicle');
    }
    const data = {
      serialNumber: input.serialNumber?.trim() || null,
      brand: input.brand?.trim() || null,
      model: input.model?.trim() || null,
      warrantyExpiry: day(input.warrantyExpiry),
      notes: input.notes?.trim() || null,
    };
    if (data.serialNumber && data.serialNumber !== a.serialNumber) {
      const dup = await this.prisma.db.asset.findFirst({
        where: {
          productId: a.productId,
          serialNumber: data.serialNumber,
          NOT: { id: a.id },
        },
      });
      if (dup)
        throw new BadRequestException({
          message: 'errors.asset_serial_in_use',
          args: { tag: dup.tag },
        });
    }
    const vehicle = input.vehicle ? this.vehicleData(input.vehicle) : null;
    if (vehicle) {
      const dup = await this.prisma.db.vehicleDetails.findFirst({
        where: {
          registrationNumber: vehicle.registrationNumber,
          NOT: { assetId: a.id },
        },
      });
      if (dup)
        throw new BadRequestException('errors.vehicle_registration_in_use');
    }
    await this.prisma.db.$transaction(async (tx) => {
      await tx.asset.update({ where: { id: a.id }, data });
      if (vehicle) {
        await tx.vehicleDetails.upsert({
          where: { assetId: a.id },
          update: vehicle,
          create: { ...vehicle, assetId: a.id },
        });
      }
      await this.audit.log(
        {
          action: 'asset.edit',
          entityType: 'Asset',
          entityId: a.tag,
          before: {
            serialNumber: a.serialNumber,
            brand: a.brand,
            model: a.model,
            warrantyExpiry: a.warrantyExpiry,
            notes: a.notes,
            vehicle: a.vehicle,
          },
          after: { ...data, vehicle, reason: input.reason },
        },
        tx,
      );
    });
    return this.get(actor, a.uniqueId);
  }

  /** Move an in-store asset to another location of the same store. */
  async moveLocation(
    actor: CurrentUser,
    uniqueId: string,
    locationUniqueId: string,
  ) {
    const a = await this.load({ uniqueId });
    if (!a.storeId) throw new BadRequestException('errors.asset_not_in_store');
    const canMove =
      (await this.access.can(actor, 'stock.issue', { storeId: a.storeId })) ||
      (await this.access.can(actor, 'stock.adjust', { storeId: a.storeId }));
    if (!canMove) throw new ForbiddenException('errors.forbidden');
    if (a.status !== 'IN_STORE' && a.status !== 'RESERVED') {
      throw new BadRequestException('errors.asset_not_in_store');
    }
    const loc = await this.prisma.db.storeLocation.findUnique({
      where: { uniqueId: locationUniqueId },
    });
    if (
      !loc ||
      loc.storeId !== a.storeId ||
      loc.kind !== 'GENERAL' ||
      !loc.isActive
    ) {
      throw new BadRequestException('errors.location_not_found');
    }
    if (loc.id === a.locationId) return this.get(actor, uniqueId);
    await this.prisma.db.$transaction(async (tx) => {
      const moved = await this.ledger.moveAsset(
        tx,
        a,
        { locationId: loc.id },
        {
          type: 'LOCATION_MOVE',
          userId: actor.id,
        },
      );
      // Kit components move with the kit.
      for (const c of a.components) {
        const comp = await tx.asset.findUniqueOrThrow({ where: { id: c.id } });
        if (
          comp.storeId === moved.storeId &&
          (comp.status === 'IN_STORE' || comp.status === 'RESERVED')
        ) {
          await this.ledger.moveAsset(
            tx,
            comp,
            { locationId: loc.id },
            {
              type: 'LOCATION_MOVE',
              userId: actor.id,
              reason: `With kit ${a.tag}`,
            },
          );
        }
      }
    });
    return this.get(actor, uniqueId);
  }

  // ── stock levels ─────────────────────────────────────────────────────────

  async levels(user: CurrentUser, f: StockLevelFilterInput = {}) {
    const scope = await this.stores.stockScope(user);
    if (!scope.all && !scope.storeIds.length && !scope.departmentIds.length) {
      throw new ForbiddenException('errors.forbidden');
    }
    const scoped = (byDept: (ids: number[]) => Record<string, unknown>) => {
      if (scope.all) return {};
      const or: Record<string, unknown>[] = [];
      if (scope.storeIds.length) or.push({ storeId: { in: scope.storeIds } });
      if (scope.departmentIds.length) or.push(byDept(scope.departmentIds));
      return { OR: or };
    };
    const store = f.storeUniqueId
      ? await this.stores.byUniqueId(f.storeUniqueId)
      : null;
    const productWhere: Prisma.ProductWhereInput = {
      ...(f.categoryUniqueId
        ? { currentVersion: { category: { uniqueId: f.categoryUniqueId } } }
        : {}),
      ...(f.search?.trim()
        ? {
            OR: [
              { code: { contains: f.search.trim(), mode: 'insensitive' } },
              {
                currentVersion: {
                  name: { contains: f.search.trim(), mode: 'insensitive' },
                },
              },
            ],
          }
        : {}),
    };

    const [balances, assets] = await Promise.all([
      this.prisma.db.stockBalance.groupBy({
        by: ['storeId', 'productId'],
        where: {
          AND: [
            scoped((ids) => ({
              product: { owningDepartmentId: { in: ids } },
            })) as Prisma.StockBalanceWhereInput,
            store ? { storeId: store.id } : {},
            { product: productWhere },
          ],
        },
        _sum: { onHand: true, quarantine: true, reserved: true },
      }),
      this.prisma.db.asset.groupBy({
        by: ['storeId', 'productId', 'status'],
        where: {
          AND: [
            scoped((ids) => ({
              owningDepartmentId: { in: ids },
            })) as Prisma.AssetWhereInput,
            store ? { storeId: store.id } : {},
            { product: productWhere },
            { status: { notIn: ['DISPOSED', 'LOST'] } },
          ],
        },
        _count: { _all: true },
      }),
    ]);

    type Acc = {
      onHand: number;
      quarantine: number;
      reserved: number;
      out: number;
      inTransit: number;
      serialised: boolean;
    };
    const acc = new Map<string, Acc & { storeId: number; productId: number }>();
    const get = (storeId: number, productId: number, serialised: boolean) => {
      const k = `${storeId}:${productId}`;
      let e = acc.get(k);
      if (!e) {
        e = {
          storeId,
          productId,
          onHand: 0,
          quarantine: 0,
          reserved: 0,
          out: 0,
          inTransit: 0,
          serialised,
        };
        acc.set(k, e);
      }
      return e;
    };
    for (const b of balances) {
      const e = get(b.storeId, b.productId, false);
      e.onHand += b._sum.onHand ?? 0;
      e.quarantine += b._sum.quarantine ?? 0;
      e.reserved += b._sum.reserved ?? 0;
    }
    for (const a of assets) {
      if (a.storeId == null) continue;
      const e = get(a.storeId, a.productId, true);
      const n = a._count._all;
      if (a.status === 'IN_STORE') e.onHand += n;
      else if (a.status === 'RESERVED') {
        e.onHand += n;
        e.reserved += n;
      } else if (a.status === 'IN_QUARANTINE') e.quarantine += n;
      else if (a.status === 'IN_TRANSIT') e.inTransit += n;
      else if ((OUT_STATUSES as readonly string[]).includes(a.status))
        e.out += n;
    }
    const entries = [...acc.values()];
    const [stores, products, settings] = await Promise.all([
      this.prisma.db.store.findMany({
        where: { id: { in: [...new Set(entries.map((e) => e.storeId))] } },
      }),
      this.prisma.db.product.findMany({
        where: { id: { in: [...new Set(entries.map((e) => e.productId))] } },
        include: {
          owningDepartment: true,
          currentVersion: { include: { category: true } },
        },
      }),
      this.prisma.db.stockSetting.findMany({
        where: {
          productId: { in: [...new Set(entries.map((e) => e.productId))] },
        },
      }),
    ]);
    const storeBy = new Map(stores.map((s) => [s.id, s]));
    const productBy = new Map(products.map((p) => [p.id, p]));
    const settingBy = new Map(
      settings.map((s) => [`${s.storeId}:${s.productId}`, s]),
    );
    const rows = entries.map((e) => {
      const s = storeBy.get(e.storeId)!;
      const p = productBy.get(e.productId)!;
      const setting = settingBy.get(`${e.storeId}:${e.productId}`);
      const available = e.onHand - e.reserved;
      return {
        store: { uniqueId: s.uniqueId, code: s.code, name: s.name },
        productUniqueId: p.uniqueId,
        productCode: p.code,
        productName: p.currentVersion?.name ?? '—',
        categoryName: p.currentVersion?.category.name ?? '—',
        departmentName: p.owningDepartment.name,
        unit: p.currentVersion?.unit ?? '',
        serialised: e.serialised,
        onHand: e.onHand,
        quarantine: e.quarantine,
        reserved: e.reserved,
        available,
        out: e.out,
        inTransit: e.inTransit,
        reorderLevel: setting?.reorderLevel ?? null,
        belowReorder:
          !!setting &&
          setting.reorderLevel > 0 &&
          available <= setting.reorderLevel,
      };
    });
    return rows
      .filter((r) => !f.belowReorderOnly || r.belowReorder)
      .sort(
        (a, b) =>
          a.store.name.localeCompare(b.store.name) ||
          a.productName.localeCompare(b.productName),
      );
  }

  // ── movements ────────────────────────────────────────────────────────────

  async movements(
    user: CurrentUser,
    f: MovementFilterInput = {},
    page = 1,
    limit = 50,
  ) {
    const scope = await this.stores.stockScope(user);
    const and: Prisma.StockTransactionWhereInput[] = [];
    if (f.assetUniqueId) {
      // Asset history: visible to whoever may see the asset.
      const a = await this.load({ uniqueId: f.assetUniqueId });
      await this.assertVisible(user, a);
      and.push({ assetId: a.id });
    } else {
      if (!scope.all) {
        const productIds = scope.departmentIds.length
          ? (
              await this.prisma.db.product.findMany({
                where: { owningDepartmentId: { in: scope.departmentIds } },
                select: { id: true },
              })
            ).map((p) => p.id)
          : [];
        const or: Prisma.StockTransactionWhereInput[] = [];
        if (scope.storeIds.length) or.push({ storeId: { in: scope.storeIds } });
        if (productIds.length) or.push({ productId: { in: productIds } });
        if (!or.length) throw new ForbiddenException('errors.forbidden');
        and.push({ OR: or });
      }
      if (f.storeUniqueId)
        and.push({
          storeId: (await this.stores.byUniqueId(f.storeUniqueId)).id,
        });
      if (f.productUniqueId) {
        const p = await this.prisma.db.product.findUnique({
          where: { uniqueId: f.productUniqueId },
        });
        and.push({ productId: p?.id ?? -1 });
      }
    }
    if (f.from) and.push({ at: { gte: new Date(f.from) } });
    if (f.to) and.push({ at: { lte: new Date(f.to) } });
    const where = { AND: and };
    limit = Math.min(Math.max(limit, 1), 200);
    const rows = await this.prisma.db.stockTransaction.findMany({
      where,
      orderBy: { at: 'desc' },
      skip: (Math.max(page, 1) - 1) * limit,
      take: limit,
    });
    return this.presentMovements(rows);
  }

  private async presentMovements(
    rows: Prisma.StockTransactionGetPayload<object>[],
  ) {
    const ids = (
      sel: (r: (typeof rows)[number]) => number | null | undefined,
    ) => [...new Set(rows.map(sel).filter((x): x is number => x != null))];
    const [stores, locations, products, assets, users] = await Promise.all([
      this.prisma.db.store.findMany({
        where: { id: { in: ids((r) => r.storeId) } },
      }),
      this.prisma.db.storeLocation.findMany({
        where: {
          id: {
            in: [...ids((r) => r.locationId), ...ids((r) => r.toLocationId)],
          },
        },
      }),
      this.prisma.db.product.findMany({
        where: { id: { in: ids((r) => r.productId) } },
        include: {
          currentVersion: true,
          versions: { take: 1, orderBy: { version: 'desc' } },
        },
      }),
      this.prisma.db.asset.findMany({
        where: { id: { in: ids((r) => r.assetId) } },
      }),
      this.prisma.dbRaw.user.findMany({
        where: { id: { in: ids((r) => r.userId) } },
        include: { employee: true },
      }),
    ]);
    const m = <T extends { id: number }>(list: T[]) =>
      new Map(list.map((x) => [x.id, x]));
    const [sB, lB, pB, aB, uB] = [
      m(stores),
      m(locations),
      m(products),
      m(assets),
      m(users),
    ];
    return rows.map((r) => {
      const s = sB.get(r.storeId)!;
      const p = pB.get(r.productId);
      const u = r.userId ? uB.get(r.userId) : undefined;
      const a = r.assetId ? aB.get(r.assetId) : undefined;
      return {
        uniqueId: r.uniqueId,
        type: r.type,
        at: r.at,
        user: u ? `${u.employee.firstName} ${u.employee.lastName}` : null,
        store: { uniqueId: s.uniqueId, code: s.code, name: s.name },
        location: r.locationId ? (lB.get(r.locationId)?.name ?? null) : null,
        toLocation: r.toLocationId
          ? (lB.get(r.toLocationId)?.name ?? null)
          : null,
        productName: p?.currentVersion?.name ?? p?.versions[0]?.name ?? '—',
        productCode: p?.code ?? null,
        assetTag: a?.tag ?? null,
        assetUniqueId: a?.uniqueId ?? null,
        batchNumber: r.batchNumber,
        quantity: r.quantity,
        fromStatus: r.fromStatus,
        toStatus: r.toStatus,
        condition: r.condition,
        referenceType: r.referenceType,
        referenceId: r.referenceId,
        reason: r.reason,
      };
    });
  }

  // ── tags ─────────────────────────────────────────────────────────────────

  /** Issue a batch of tags to print before the tagging campaign (§12 step 2). */
  async issueTags(actor: CurrentUser, categoryUniqueId: string, count: number) {
    await this.access.assert(actor, 'asset.tag_print');
    if (count < 1 || count > 500)
      throw new BadRequestException('errors.tag_count');
    const cat = await this.prisma.db.productCategory.findUnique({
      where: { uniqueId: categoryUniqueId },
    });
    if (!cat) throw new NotFoundException('errors.category_not_found');
    const tags = await this.prisma.db.$transaction(async (tx) => {
      const t = await this.ledger.issueTags(cat.tagPrefix, count, actor.id, tx);
      await this.audit.log(
        {
          action: 'asset.tag_issue',
          entityType: 'AssetTag',
          entityId: `${t[0].tag}…${t[t.length - 1].tag}`,
          after: { prefix: cat.tagPrefix, count },
        },
        tx,
      );
      return t;
    });
    return tags.map((t) => ({
      ...t,
      assetUniqueId: null,
      productName: null,
      serialNumber: null,
    }));
  }

  /** Tags issued but not yet on an asset (to print or re-print). */
  async unusedTags(actor: CurrentUser, prefix?: string) {
    await this.access.assert(actor, 'asset.tag_print');
    const rows = await this.prisma.db.assetTag.findMany({
      where: { asset: null, ...(prefix ? { prefix } : {}) },
      orderBy: [{ prefix: 'asc' }, { number: 'asc' }],
      take: 2000,
    });
    return rows.map((t) => ({
      ...t,
      assetUniqueId: null,
      productName: null,
      serialNumber: null,
    }));
  }

  async markPrinted(actor: CurrentUser, tags: string[]) {
    await this.access.assert(actor, 'asset.tag_print');
    const res = await this.prisma.db.assetTag.updateMany({
      where: { tag: { in: tags } },
      data: { printedAt: new Date() },
    });
    await this.audit.log({
      action: 'asset.tag_print',
      entityType: 'AssetTag',
      entityId: tags.length === 1 ? tags[0] : `${tags.length} tags`,
      after: { tags: tags.slice(0, 500) },
    });
    return res.count;
  }

  // ── presentation ─────────────────────────────────────────────────────────

  async presentMany(user: CurrentUser, rows: AssetRow[]) {
    const storeIds = [
      ...new Set(
        rows.map((r) => r.storeId).filter((x): x is number => x != null),
      ),
    ];
    const locations = storeIds.length
      ? await this.prisma.db.storeLocation.findMany({
          where: { storeId: { in: storeIds } },
        })
      : [];
    const editAll = await this.access.can(user, 'asset.edit', { storeId: -1 });
    const editStores = (await this.access.resolveScope(user, 'asset.edit'))
      .storeIds;
    return rows.map((a) => ({
      uniqueId: a.uniqueId,
      tag: a.tag,
      serialNumber: a.serialNumber,
      brand: a.brand,
      model: a.model,
      product: {
        uniqueId: a.product.uniqueId,
        code: a.product.code,
        name: a.version.name,
        categoryName: a.version.category.name,
        version: a.version.version,
        isVehicle: a.product.isVehicle,
      },
      owningDepartment: {
        uniqueId: a.owningDepartment.uniqueId,
        code: a.owningDepartment.code,
        name: a.owningDepartment.name,
      },
      source: a.source,
      lpoRef: a.lpoRef,
      grnRef: a.grnRef,
      inspectionRef: a.inspectionRef,
      vendorRef: a.vendorRef,
      purchasePrice: a.purchasePrice != null ? Number(a.purchasePrice) : null,
      priceEstimated: a.priceEstimated,
      purchaseDate: a.purchaseDate,
      warrantyExpiry: a.warrantyExpiry,
      store: a.store
        ? { uniqueId: a.store.uniqueId, code: a.store.code, name: a.store.name }
        : null,
      location: a.location
        ? {
            uniqueId: a.location.uniqueId,
            code: a.location.code,
            name: a.location.name,
            kind: a.location.kind,
            isActive: a.location.isActive,
            parentUniqueId: null,
            path: locationPath(a.location, locations),
          }
        : null,
      custodian: a.custodian
        ? {
            uniqueId: a.custodian.uniqueId,
            employeeNumber: a.custodian.employeeNumber,
            fullName: `${a.custodian.firstName} ${a.custodian.lastName}`,
          }
        : null,
      condition: a.condition,
      status: a.status,
      isKit: a.isKit,
      parent: a.parent
        ? {
            uniqueId: a.parent.uniqueId,
            tag: a.parent.tag,
            productName: a.parent.version.name,
            status: a.parent.status,
            condition: a.parent.condition,
          }
        : null,
      components: a.components.map((c) => ({
        uniqueId: c.uniqueId,
        tag: c.tag,
        productName: c.version.name,
        status: c.status,
        condition: c.condition,
      })),
      vehicle: a.vehicle,
      notes: a.notes,
      createdAt: a.createdAt,
      canEdit: editAll || (a.storeId != null && editStores.includes(a.storeId)),
    }));
  }
}
