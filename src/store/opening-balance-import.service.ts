import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AssetCondition, Prisma } from '@db';
import { PrismaService, type DbTx } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import {
  addDataSheet,
  addInstructions,
  errorWorkbook,
  listsSheet,
  loadWorkbook,
  lookupCode,
  lookupLabel,
  newWorkbook,
  parseDate,
  parseNumber,
  readSheet,
  type SheetColumn,
} from '../imports/excel';
import { AdjustmentsService, type NewLine } from './adjustments.service';
import { locationPath, StoresService } from './stores.service';

const TYPE = 'OPENING_BALANCE';
const CONDITIONS: Record<string, AssetCondition> = {
  good: 'GOOD',
  fair: 'FAIR',
  'needs repair': 'NEEDS_REPAIR',
  'under repair': 'UNDER_REPAIR',
  'beyond repair': 'BEYOND_REPAIR',
};

type AssetKey =
  | 'tag'
  | 'product'
  | 'serial'
  | 'brand'
  | 'model'
  | 'location'
  | 'condition'
  | 'holder'
  | 'department'
  | 'kitTag'
  | 'purchaseDate'
  | 'price'
  | 'estimated'
  | 'warranty'
  | 'notes'
  | 'reg'
  | 'chassis'
  | 'engine'
  | 'fuel'
  | 'seats'
  | 'insurance'
  | 'licence'
  | 'km'
  | 'months';

const ASSET_COLS: SheetColumn<AssetKey>[] = [
  { key: 'tag', header: 'Asset tag (pre-printed)', width: 20, text: true },
  { key: 'product', header: 'Product', required: true, width: 40 },
  { key: 'serial', header: 'Serial number', width: 20, text: true },
  { key: 'brand', header: 'Brand', width: 14 },
  { key: 'model', header: 'Model', width: 16 },
  { key: 'location', header: 'Location', required: true, width: 22 },
  { key: 'condition', header: 'Condition', required: true, width: 14 },
  { key: 'holder', header: 'Held by (employee number)', width: 18, text: true },
  {
    key: 'department',
    header: 'Owning department (if not the product owner)',
    width: 26,
  },
  {
    key: 'kitTag',
    header: 'Part of kit (kit asset tag)',
    width: 20,
    text: true,
  },
  { key: 'purchaseDate', header: 'Purchase date', width: 14, date: true },
  { key: 'price', header: 'Purchase price (TZS excl. VAT)', width: 18 },
  { key: 'estimated', header: 'Price estimated', width: 12 },
  { key: 'warranty', header: 'Warranty expiry', width: 14, date: true },
  { key: 'notes', header: 'Notes', width: 30 },
  { key: 'reg', header: 'Vehicle: registration number', width: 18, text: true },
  { key: 'chassis', header: 'Vehicle: chassis number', width: 20, text: true },
  { key: 'engine', header: 'Vehicle: engine number', width: 18, text: true },
  { key: 'fuel', header: 'Vehicle: fuel type', width: 12 },
  { key: 'seats', header: 'Vehicle: seats', width: 10, integer: true },
  {
    key: 'insurance',
    header: 'Vehicle: insurance expiry',
    width: 14,
    date: true,
  },
  {
    key: 'licence',
    header: 'Vehicle: road licence expiry',
    width: 14,
    date: true,
  },
  {
    key: 'km',
    header: 'Vehicle: service every (km)',
    width: 14,
    integer: true,
  },
  {
    key: 'months',
    header: 'Vehicle: service every (months)',
    width: 14,
    integer: true,
  },
];

type QtyKey = 'product' | 'location' | 'quantity' | 'batch' | 'expiry';
const QTY_COLS: SheetColumn<QtyKey>[] = [
  { key: 'product', header: 'Product', required: true, width: 40 },
  { key: 'location', header: 'Location', required: true, width: 22 },
  {
    key: 'quantity',
    header: 'Quantity counted',
    required: true,
    width: 16,
    integer: true,
  },
  { key: 'batch', header: 'Batch number (batch items)', width: 18, text: true },
  { key: 'expiry', header: 'Expiry date (batch items)', width: 16, date: true },
];

interface Stored {
  storeId: number;
  reason: string;
  lines: (NewLine & { row: number; sheet: string })[];
}
type RowError = { row: number; column: string | null; message: string };

/**
 * Tagging campaign import (B2 §12): store by store, assets and consumables
 * counted at go-live. Committing creates an OPENING_BALANCE adjustment that
 * goes through `stock_adjustment.approval`; nothing is in stock until then.
 */
@Injectable()
export class OpeningBalanceImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly stores: StoresService,
    private readonly adjustments: AdjustmentsService,
  ) {}

  private async store(actor: CurrentUser, uniqueId: string) {
    const store = await this.stores.byUniqueId(uniqueId);
    await this.access.assert(actor, 'stock.adjust', { storeId: store.id });
    return store;
  }

  private async masterData(
    storeId: number,
    db: DbTx | PrismaService['db'] = this.prisma.db,
  ) {
    const [products, locations, departments] = await Promise.all([
      db.product.findMany({
        where: { status: 'ACTIVE', trackingType: { not: null } },
        include: { currentVersion: true },
        orderBy: { code: 'asc' },
      }),
      db.storeLocation.findMany({
        where: { storeId, kind: 'GENERAL', isActive: true },
        orderBy: { code: 'asc' },
      }),
      db.department.findMany({
        where: { isActive: true },
        orderBy: { code: 'asc' },
      }),
    ]);
    return { products, locations, departments };
  }

  async template(actor: CurrentUser, storeUniqueId: string) {
    const store = await this.store(actor, storeUniqueId);
    const { products, locations, departments } = await this.masterData(
      store.id,
    );
    const label = (p: (typeof products)[number]) =>
      lookupLabel(p.code ?? '', p.currentVersion?.name ?? '');
    const wb = newWorkbook();
    const put = listsSheet(wb);
    const assetProducts = put(
      'Asset products',
      products.filter((p) => p.trackingType === 'SERIALISED').map(label),
    );
    const qtyProducts = put(
      'Quantity products',
      products.filter((p) => p.trackingType !== 'SERIALISED').map(label),
    );
    const locs = put(
      'Locations',
      locations.map((l) => lookupLabel(l.code, locationPath(l, locations))),
    );
    const conds = put('Conditions', [
      'Good',
      'Fair',
      'Needs repair',
      'Under repair',
      'Beyond repair',
    ]);
    const depts = put(
      'Departments',
      departments.map((d) => lookupLabel(d.code, d.name)),
    );
    const yesNo = put('Yes/No', ['Yes', 'No']);
    const lists: Partial<Record<string, string>> = {
      product: assetProducts,
      location: locs,
      condition: conds,
      department: depts,
      estimated: yesNo,
    };
    await addDataSheet(
      wb,
      'Assets',
      ASSET_COLS.map((c) => ({ ...c, list: lists[c.key] })),
      3000,
    );
    await addDataSheet(
      wb,
      'Consumables',
      QTY_COLS.map((c) => ({
        ...c,
        list:
          c.key === 'product'
            ? qtyProducts
            : c.key === 'location'
              ? locs
              : undefined,
      })),
      1500,
    );
    addInstructions(wb, [
      `AzamTV — opening balance (tagging campaign) for ${store.name}`,
      '',
      '• "Assets": one row per physical unit (equipment and vehicles). Write the pre-printed tag you stuck on it; leave blank to get a new tag after approval.',
      '• Product, Location and Condition come from the drop-downs (Active products only; locations of this store).',
      '• Held by: the employee number of the person who has the item at go-live. Vehicles are never held by individuals.',
      '• Kits: put the kit\'s own tag on each component row ("Part of kit"). The kit itself is its own row.',
      '• Purchase price is information only (TZS excl. VAT); mark "Price estimated" = Yes when it is a guess.',
      '• Vehicle columns are required for vehicle products (registration number at least).',
      '• "Consumables": one row per product, location and batch with the quantity counted.',
      '• If any row has an error, nothing is saved. Download the error file, fix the rows and upload again.',
      '• After upload, the opening balance goes to Store Managers for approval; stock appears once approved.',
    ]);
    return { file: Buffer.from(await wb.xlsx.writeBuffer()), store };
  }

  async validate(file: Buffer, storeId: number, tx?: DbTx) {
    const db = tx ?? this.prisma.db;
    const wb = await loadWorkbook(file);
    const assetRows = readSheet(wb, 'Assets', ASSET_COLS, { optional: true });
    const qtyRows = readSheet(wb, 'Consumables', QTY_COLS, { optional: true });
    if (!assetRows.length && !qtyRows.length)
      throw new BadRequestException('errors.import_empty');

    const { products, locations, departments } = await this.masterData(
      storeId,
      db,
    );
    const productBy = new Map(
      products.filter((p) => p.code).map((p) => [p.code!, p]),
    );
    const locBy = new Map(locations.map((l) => [l.code, l]));
    const deptBy = new Map(departments.map((d) => [d.code, d]));
    const errors: RowError[] = [];
    const err = (sheet: string, row: number, col: string, message: string) =>
      errors.push({ row, column: `${sheet} › ${col}`, message });
    const lines: Stored['lines'] = [];

    // Existing tags, serials, registrations, employees referenced.
    const tagsInFile = assetRows
      .map((r) => (r.values.tag ?? '').trim().toUpperCase())
      .filter(Boolean);
    const kitTags = assetRows
      .map((r) => (r.values.kitTag ?? '').trim().toUpperCase())
      .filter(Boolean);
    const [issued, existingKits, employees, regs] = await Promise.all([
      db.assetTag.findMany({
        where: { tag: { in: tagsInFile } },
        include: { asset: true },
      }),
      db.asset.findMany({ where: { tag: { in: kitTags } } }),
      db.employee.findMany({
        where: {
          employeeNumber: {
            in: assetRows
              .map((r) => (r.values.holder ?? '').trim().toUpperCase())
              .filter(Boolean),
          },
        },
      }),
      db.vehicleDetails.findMany({
        where: {
          registrationNumber: {
            in: assetRows
              .map((r) => (r.values.reg ?? '').trim().toUpperCase())
              .filter(Boolean),
          },
        },
      }),
    ]);
    const tagBy = new Map(issued.map((t) => [t.tag, t]));
    const existingKitTags = new Set(existingKits.map((a) => a.tag));
    const employeeBy = new Map(employees.map((e) => [e.employeeNumber, e]));
    const regTaken = new Set(regs.map((r) => r.registrationNumber));
    const serials = assetRows
      .map((r) => (r.values.serial ?? '').trim())
      .filter(Boolean);
    const serialTaken = new Set(
      (
        await db.asset.findMany({
          where: { serialNumber: { in: serials } },
          select: { productId: true, serialNumber: true },
        })
      ).map((a) => `${a.productId}:${a.serialNumber}`),
    );

    const seenTag = new Set<string>();
    const seenSerial = new Set<string>();
    const seenReg = new Set<string>();
    const ownTags = new Set<string>();
    const componentTags = new Set<string>();
    const date = (sheet: string, row: number, col: string, raw?: string) => {
      if (!raw) return null;
      const d = parseDate(raw);
      if (!d) err(sheet, row, col, 'Not a valid date (DD/MM/YYYY)');
      return d;
    };
    const int = (sheet: string, row: number, col: string, raw?: string) => {
      if (!raw) return null;
      const n = parseNumber(raw);
      if (n == null || n < 0 || !Number.isInteger(n)) {
        err(sheet, row, col, 'Whole number expected');
        return null;
      }
      return n;
    };

    for (const { row, values: v } of assetRows) {
      const S = 'Assets';
      const p = productBy.get(lookupCode(v.product ?? ''));
      if (!p) err(S, row, 'Product', 'Unknown or inactive product');
      else if (p.trackingType !== 'SERIALISED')
        err(S, row, 'Product', 'Not an asset product: use "Consumables"');
      const loc = locBy.get(lookupCode(v.location ?? ''));
      if (!loc) err(S, row, 'Location', 'Not a location of this store');
      const condition = CONDITIONS[(v.condition ?? '').trim().toLowerCase()];
      if (!condition)
        err(
          S,
          row,
          'Condition',
          'Good, Fair, Needs repair, Under repair or Beyond repair',
        );

      const tag = (v.tag ?? '').trim().toUpperCase() || null;
      if (tag) {
        const t = tagBy.get(tag);
        if (seenTag.has(tag))
          err(S, row, 'Asset tag (pre-printed)', 'Same tag twice in this file');
        else if (!t)
          err(
            S,
            row,
            'Asset tag (pre-printed)',
            'Tag was never issued by the system',
          );
        else if (t.asset)
          err(
            S,
            row,
            'Asset tag (pre-printed)',
            `Already on asset ${t.asset.tag}`,
          );
        seenTag.add(tag);
        ownTags.add(tag);
      }
      const serial = (v.serial ?? '').trim() || null;
      if (serial && p) {
        const k = `${p.id}:${serial}`;
        if (seenSerial.has(k))
          err(
            S,
            row,
            'Serial number',
            'Same product and serial twice in this file',
          );
        else if (serialTaken.has(k))
          err(S, row, 'Serial number', 'Already in the asset register');
        seenSerial.add(k);
      }
      let holder: (typeof employees)[number] | undefined;
      if (v.holder?.trim()) {
        holder = employeeBy.get(v.holder.trim().toUpperCase());
        if (!holder)
          err(S, row, 'Held by (employee number)', 'Unknown employee number');
        else if (holder.status === 'EXITED')
          err(S, row, 'Held by (employee number)', 'Employee has exited');
        if (p?.isVehicle)
          err(
            S,
            row,
            'Held by (employee number)',
            'Vehicles are never held by individuals',
          );
      }
      let deptId: number | null = null;
      if (v.department?.trim()) {
        const d = deptBy.get(lookupCode(v.department));
        if (!d)
          err(
            S,
            row,
            'Owning department (if not the product owner)',
            'Unknown department',
          );
        else deptId = d.id;
      }
      const kitTag = (v.kitTag ?? '').trim().toUpperCase() || null;
      if (kitTag) {
        if (tag && kitTag === tag)
          err(
            S,
            row,
            'Part of kit (kit asset tag)',
            'An asset cannot be its own kit',
          );
        if (!tag)
          err(
            S,
            row,
            'Asset tag (pre-printed)',
            'Kit components need their tag to be written',
          );
        if (tag) componentTags.add(tag);
      }
      let price: number | null = null;
      if (v.price) {
        price = parseNumber(v.price);
        if (price == null || price < 0)
          err(S, row, 'Purchase price (TZS excl. VAT)', 'Not a valid amount');
      }
      const purchaseDate = date(S, row, 'Purchase date', v.purchaseDate);
      const warranty = date(S, row, 'Warranty expiry', v.warranty);

      let vehicle: NonNullable<NewLine['asset']>['vehicle'] = null;
      if (p?.isVehicle) {
        const reg = (v.reg ?? '').trim().toUpperCase();
        if (!reg)
          err(S, row, 'Vehicle: registration number', 'Required for vehicles');
        else if (seenReg.has(reg))
          err(
            S,
            row,
            'Vehicle: registration number',
            'Same registration twice in this file',
          );
        else if (regTaken.has(reg))
          err(S, row, 'Vehicle: registration number', 'Already registered');
        seenReg.add(reg);
        vehicle = {
          registrationNumber: reg,
          chassisNumber: v.chassis?.trim() || null,
          engineNumber: v.engine?.trim() || null,
          fuelType: v.fuel?.trim() || null,
          seatingCapacity: int(S, row, 'Vehicle: seats', v.seats),
          insuranceExpiry: date(
            S,
            row,
            'Vehicle: insurance expiry',
            v.insurance,
          ),
          roadLicenceExpiry: date(
            S,
            row,
            'Vehicle: road licence expiry',
            v.licence,
          ),
          serviceIntervalKm: int(S, row, 'Vehicle: service every (km)', v.km),
          serviceIntervalMonths: int(
            S,
            row,
            'Vehicle: service every (months)',
            v.months,
          ),
        };
      } else if (v.reg?.trim()) {
        err(S, row, 'Vehicle: registration number', 'Product is not a vehicle');
      }
      if (p && loc && condition) {
        lines.push({
          row,
          sheet: S,
          productId: p.id,
          locationId: loc.id,
          quantity: 1,
          batchNumber: null,
          expiryDate: null,
          asset: {
            tag,
            serialNumber: serial,
            brand: v.brand?.trim() || null,
            model: v.model?.trim() || null,
            condition,
            purchaseDate,
            purchasePrice: price,
            priceEstimated: /^y/i.test(v.estimated ?? ''),
            warrantyExpiry: warranty,
            notes: v.notes?.trim() || null,
            holderEmployeeId: holder?.id ?? null,
            holderLabel: holder
              ? `${holder.employeeNumber} ${holder.firstName} ${holder.lastName}`
              : null,
            owningDepartmentId: deptId,
            kitTag,
            isKit: false,
            vehicle,
          },
        });
      }
    }
    // Kits: the kit tag must be a row of this file (not itself a component) or an existing asset.
    for (const l of lines) {
      const k = l.asset?.kitTag;
      if (!k) continue;
      if (ownTags.has(k)) {
        if (componentTags.has(k))
          err(
            'Assets',
            l.row,
            'Part of kit (kit asset tag)',
            'That tag is itself a kit component',
          );
        const kit = lines.find((x) => x.asset?.tag === k);
        if (kit?.asset) kit.asset.isKit = true;
      } else if (!existingKitTags.has(k)) {
        err(
          'Assets',
          l.row,
          'Part of kit (kit asset tag)',
          'No asset with this tag in this file or the register',
        );
      }
    }

    const seenQty = new Set<string>();
    for (const { row, values: v } of qtyRows) {
      const S = 'Consumables';
      const p = productBy.get(lookupCode(v.product ?? ''));
      if (!p) err(S, row, 'Product', 'Unknown or inactive product');
      else if (p.trackingType === 'SERIALISED')
        err(
          S,
          row,
          'Product',
          'Asset product: use "Assets" (one row per unit)',
        );
      const loc = locBy.get(lookupCode(v.location ?? ''));
      if (!loc) err(S, row, 'Location', 'Not a location of this store');
      const qty = int(S, row, 'Quantity counted', v.quantity);
      if (qty === 0) err(S, row, 'Quantity counted', 'Must be more than 0');
      const batch = (v.batch ?? '').trim() || null;
      if (p?.trackingType === 'BATCH' && !batch)
        err(
          S,
          row,
          'Batch number (batch items)',
          'Required for batch products',
        );
      const expiry = date(S, row, 'Expiry date (batch items)', v.expiry);
      const key = `${p?.id}:${loc?.id}:${batch ?? ''}`;
      if (p && loc && seenQty.has(key))
        err(S, row, 'Product', 'Same product, location and batch twice');
      seenQty.add(key);
      if (p && loc && qty) {
        lines.push({
          row,
          sheet: S,
          productId: p.id,
          locationId: loc.id,
          quantity: qty,
          batchNumber: p.trackingType === 'BATCH' ? batch : null,
          expiryDate: p.trackingType === 'BATCH' ? expiry : null,
          asset: null,
        });
      }
    }
    return { lines, errors, totalRows: assetRows.length + qtyRows.length };
  }

  async upload(
    actor: CurrentUser,
    storeUniqueId: string,
    fileName: string,
    file: Buffer,
    reason?: string,
  ) {
    const store = await this.store(actor, storeUniqueId);
    const { lines, errors, totalRows } = await this.validate(file, store.id);
    const stored: Stored = {
      storeId: store.id,
      reason:
        reason?.trim() || `Opening balance (tagging campaign) — ${store.name}`,
      lines,
    };
    const batch = await this.prisma.dbRaw.importBatch.create({
      data: {
        type: TYPE,
        status: errors.length ? 'FAILED' : 'VALIDATED',
        fileName: fileName.slice(0, 200),
        file: new Uint8Array(file),
        totalRows,
        createCount: errors.length ? 0 : lines.length,
        errorCount: errors.length,
        rows: stored as unknown as Prisma.InputJsonValue,
        uploadedById: actor.id,
        errors: { create: errors },
      },
      include: { errors: { orderBy: [{ row: 'asc' }, { id: 'asc' }] } },
    });
    await this.audit.log({
      action: 'stock.opening_balance_upload',
      entityType: 'ImportBatch',
      entityId: batch.uniqueId,
      after: {
        fileName: batch.fileName,
        store: store.code,
        status: batch.status,
        errors: errors.length,
      },
    });
    return batch;
  }

  /** Creates the OPENING_BALANCE adjustment (for approval). */
  async commit(actor: CurrentUser, uniqueId: string) {
    const batch = await this.prisma.dbRaw.importBatch.findUnique({
      where: { uniqueId },
    });
    if (!batch || batch.type !== TYPE)
      throw new NotFoundException('errors.record_not_found');
    if (batch.status !== 'VALIDATED')
      throw new BadRequestException('errors.import_not_committable');
    const stored = batch.rows as unknown as Stored;
    await this.access.assert(actor, 'stock.adjust', {
      storeId: stored.storeId,
    });
    const adj = await this.prisma.db.$transaction(
      async (tx) => {
        const { lines, errors } = await this.validate(
          Buffer.from(batch.file),
          stored.storeId,
          tx,
        );
        if (errors.length)
          throw new BadRequestException('errors.import_changed');
        const adjustment = await this.adjustments.createDocument(
          tx,
          actor,
          stored.storeId,
          'OPENING_BALANCE',
          stored.reason,
          lines.map((l) => ({
            productId: l.productId,
            locationId: l.locationId,
            quantity: l.quantity,
            batchNumber: l.batchNumber,
            expiryDate: l.expiryDate,
            asset: l.asset,
          })),
          batch.id,
        );
        await tx.importBatch.update({
          where: { id: batch.id },
          data: {
            status: 'COMMITTED',
            committedById: actor.id,
            committedAt: new Date(),
          },
        });
        return adjustment;
      },
      { timeout: 300_000 },
    );
    return {
      batch: await this.get(uniqueId),
      adjustmentUniqueId: adj.uniqueId,
    };
  }

  async get(uniqueId: string, actor?: CurrentUser) {
    const b = await this.prisma.dbRaw.importBatch.findUnique({
      where: { uniqueId },
      omit: { file: true },
      include: { errors: { orderBy: [{ row: 'asc' }, { id: 'asc' }] } },
    });
    if (!b || b.type !== TYPE)
      throw new NotFoundException('errors.record_not_found');
    if (actor) {
      await this.access.assert(actor, 'stock.adjust', {
        storeId: (b.rows as unknown as Stored).storeId,
      });
    }
    return b;
  }

  async history(actor: CurrentUser, storeUniqueId?: string) {
    const scope = await this.access.resolveScope(actor, 'stock.adjust');
    const store = storeUniqueId
      ? await this.stores.byUniqueId(storeUniqueId)
      : null;
    const rows = await this.prisma.dbRaw.importBatch.findMany({
      where: { type: TYPE },
      orderBy: { createdAt: 'desc' },
      take: 200,
      omit: { file: true },
    });
    const stores = await this.prisma.db.store.findMany();
    const storeBy = new Map(stores.map((s) => [s.id, s]));
    return rows
      .map((r) => ({ r, storeId: (r.rows as unknown as Stored).storeId }))
      .filter(
        ({ storeId }) =>
          (scope.all || scope.storeIds.includes(storeId)) &&
          (!store || store.id === storeId),
      )
      .slice(0, 50)
      .map(({ r, storeId }) => ({
        uniqueId: r.uniqueId,
        status: r.status,
        fileName: r.fileName,
        totalRows: r.totalRows,
        createCount: r.createCount,
        errorCount: r.errorCount,
        createdAt: r.createdAt,
        committedAt: r.committedAt,
        storeName: storeBy.get(storeId)?.name ?? '—',
      }));
  }

  async errorReport(actor: CurrentUser, uniqueId: string) {
    await this.get(uniqueId, actor);
    const batch = await this.prisma.dbRaw.importBatch.findUniqueOrThrow({
      where: { uniqueId },
      include: { errors: true },
    });
    return errorWorkbook(Buffer.from(batch.file), batch.errors, 'Assets');
  }

  async preview(rows: unknown) {
    const stored = rows as Stored | undefined;
    const lines = (stored?.lines ?? []).slice(0, 300);
    const products = await this.prisma.db.product.findMany({
      where: { id: { in: [...new Set(lines.map((l) => l.productId))] } },
      include: { currentVersion: true },
    });
    const locations = stored
      ? await this.prisma.db.storeLocation.findMany({
          where: { storeId: stored.storeId },
        })
      : [];
    const pBy = new Map(products.map((p) => [p.id, p]));
    const lBy = new Map(locations.map((l) => [l.id, l]));
    return lines.map((l) => ({
      row: l.row,
      sheet: l.sheet,
      product:
        `${pBy.get(l.productId)?.code ?? ''} ${pBy.get(l.productId)?.currentVersion?.name ?? ''}`.trim(),
      location: lBy.get(l.locationId)?.name ?? '',
      quantity: l.quantity,
      tag: l.asset?.tag ?? null,
      serialNumber: l.asset?.serialNumber ?? null,
      condition: l.asset?.condition ?? null,
      holder: l.asset?.holderLabel ?? null,
      kitTag: l.asset?.kitTag ?? null,
    }));
  }
}
