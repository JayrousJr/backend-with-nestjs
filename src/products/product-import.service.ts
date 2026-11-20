import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, SpecRule } from '@db';
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
  parseNumber,
  readSheet,
  type SheetColumn,
} from '../imports/excel';
import { ProductsService } from './products.service';

const TYPE = 'PRODUCT';
const RULES: SpecRule[] = ['EXACT', 'MIN', 'MAX', 'RANGE', 'ONE_OF', 'TEXT'];

const PRODUCT_COLS: SheetColumn<
  'key' | 'name' | 'description' | 'category' | 'unit' | 'price'
>[] = [
  { key: 'key', header: 'Product key', required: true, width: 14, text: true },
  { key: 'name', header: 'Name', required: true, width: 34 },
  { key: 'description', header: 'Description', required: true, width: 50 },
  { key: 'category', header: 'Category', required: true, width: 28 },
  { key: 'unit', header: 'Unit of measure', required: true, width: 14 },
  { key: 'price', header: 'Reference unit price (TZS)', width: 22 },
];
const SPEC_COLS: SheetColumn<
  'key' | 'attribute' | 'rule' | 'value' | 'max' | 'unit'
>[] = [
  { key: 'key', header: 'Product key', required: true, width: 14, text: true },
  { key: 'attribute', header: 'Attribute', required: true, width: 26 },
  { key: 'rule', header: 'Rule', required: true, width: 12 },
  {
    key: 'value',
    header: 'Value (or minimum)',
    required: true,
    width: 24,
    text: true,
  },
  { key: 'max', header: 'Maximum (range only)', width: 18, text: true },
  { key: 'unit', header: 'Unit', width: 10 },
];
const CRIT_COLS: SheetColumn<'key' | 'criterion'>[] = [
  { key: 'key', header: 'Product key', required: true, width: 14, text: true },
  {
    key: 'criterion',
    header: 'Receiving criterion',
    required: true,
    width: 80,
  },
];

interface ImportedProduct {
  row: number;
  key: string;
  name: string;
  description: string;
  categoryId: number;
  categoryName: string;
  unit: string;
  referencePrice: number | null;
  specs: {
    attribute: string;
    rule: SpecRule;
    value: string;
    valueMax: string | null;
    unit: string | null;
  }[];
  criteria: { text: string; libraryId: number | null }[];
}

interface Stored {
  departmentId: number;
  products: ImportedProduct[];
}

type RowError = { row: number; column: string | null; message: string };

/**
 * Departments import their own products (tender spec §5.6, scope
 * own_department). Imported products start as **submitted**: they go
 * straight into `product.activation`.
 */
@Injectable()
export class ProductImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly products: ProductsService,
  ) {}

  private async department(actor: CurrentUser, uniqueId?: string) {
    const dept = uniqueId
      ? await this.prisma.db.department.findUnique({ where: { uniqueId } })
      : await this.prisma.db.department.findUnique({
          where: { id: actor.departmentId },
        });
    if (!dept) throw new NotFoundException('errors.department_not_found');
    await this.access.assert(actor, 'item.import', { departmentId: dept.id });
    return dept;
  }

  async template(actor: CurrentUser, departmentUniqueId?: string) {
    const dept = await this.department(actor, departmentUniqueId);
    const categories = await this.prisma.db.productCategory.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      include: {
        criteria: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
    const wb = newWorkbook();
    const put = listsSheet(wb);
    const catRange = put(
      'Categories',
      categories.map((c) => lookupLabel(c.code, c.name)),
    );
    const ruleRange = put('Rules', RULES);
    await addDataSheet(
      wb,
      'Products',
      PRODUCT_COLS.map((c) =>
        c.key === 'category' ? { ...c, list: catRange } : c,
      ),
      500,
    );
    await addDataSheet(
      wb,
      'Specifications',
      SPEC_COLS.map((c) => (c.key === 'rule' ? { ...c, list: ruleRange } : c)),
      3000,
    );
    await addDataSheet(wb, 'Receiving criteria', CRIT_COLS, 3000);

    const lib = wb.addWorksheet('Criteria library');
    lib.columns = [
      { header: 'Category', key: 'c', width: 28 },
      {
        header: 'Criterion (copy into "Receiving criteria")',
        key: 't',
        width: 90,
      },
    ];
    lib.getRow(1).font = { bold: true };
    for (const c of categories) {
      for (const cr of c.criteria) lib.addRow({ c: c.name, t: cr.text });
    }
    addInstructions(wb, [
      `AzamTV — product import for ${dept.name}`,
      '',
      '• One product per row on "Products". The Product key is any short reference you choose (P1, P2…) to link its specifications and criteria.',
      '• "Specifications": one row per attribute. Rule = EXACT, MIN, MAX, RANGE (value = minimum, plus maximum), ONE_OF (values separated by |) or TEXT.',
      '• "Receiving criteria": one row per pass/fail criterion. Copy standard ones from "Criteria library" or write your own.',
      '• Every product needs at least one specification and one receiving criterion.',
      `• Imported products belong to ${dept.name} and are submitted for activation straight away (HOD, then Procurement).`,
      '• Search the Product Repository first: products another department already owns cannot be imported again.',
      '• If any row has an error, nothing is saved. Download the error file, fix the rows and upload again.',
    ]);
    return { file: Buffer.from(await wb.xlsx.writeBuffer()), department: dept };
  }

  async validate(file: Buffer, departmentId: number, tx?: DbTx) {
    const db = tx ?? this.prisma.db;
    const wb = await loadWorkbook(file);
    const productRows = readSheet(wb, 'Products', PRODUCT_COLS);
    const specRows = readSheet(wb, 'Specifications', SPEC_COLS);
    const critRows = readSheet(wb, 'Receiving criteria', CRIT_COLS);
    if (!productRows.length)
      throw new BadRequestException('errors.import_empty');

    const errors: RowError[] = [];
    const err = (
      sheet: string,
      row: number,
      column: string | null,
      message: string,
    ) =>
      errors.push({
        row,
        column: column ? `${sheet} › ${column}` : `${sheet} › Row`,
        message,
      });

    const categories = await db.productCategory.findMany({
      where: { isActive: true },
      include: { criteria: { where: { isActive: true } } },
    });
    const catByCode = new Map(categories.map((c) => [c.code, c]));
    const catByName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));

    // Names already in the repository (not rejected / retired).
    const existing = await db.productVersion.findMany({
      where: {
        product: {
          status: { notIn: ['REJECTED', 'RETIRED'] },
          isDeleted: false,
        },
      },
      select: { name: true, product: { select: { code: true } } },
    });
    const taken = new Map(
      existing.map((v) => [v.name.trim().toLowerCase(), v.product.code]),
    );

    const byKey = new Map<string, ImportedProduct>();
    const names = new Set<string>();
    for (const { row, values: v } of productRows) {
      const key = (v.key ?? '').trim().toUpperCase();
      const name = (v.name ?? '').trim();
      const description = (v.description ?? '').trim();
      const unit = (v.unit ?? '').trim();
      if (!key) err('Products', row, 'Product key', 'Required');
      else if (byKey.has(key))
        err('Products', row, 'Product key', 'Used twice in this file');
      if (name.length < 3)
        err('Products', row, 'Name', 'At least 3 characters');
      else if (names.has(name.toLowerCase()))
        err('Products', row, 'Name', 'Same name twice in this file');
      else if (taken.has(name.toLowerCase())) {
        const code = taken.get(name.toLowerCase());
        err(
          'Products',
          row,
          'Name',
          `Already in the repository${code ? ` (${code})` : ''}`,
        );
      }
      if (description.length < 3)
        err('Products', row, 'Description', 'Required');
      if (!unit) err('Products', row, 'Unit of measure', 'Required');
      const raw = (v.category ?? '').trim();
      const cat =
        catByCode.get(lookupCode(raw)) ?? catByName.get(raw.toLowerCase());
      if (!cat)
        err('Products', row, 'Category', 'Unknown or inactive category');
      let price: number | null = null;
      if (v.price) {
        price = parseNumber(v.price);
        if (price == null || price < 0)
          err(
            'Products',
            row,
            'Reference unit price (TZS)',
            'Not a valid amount',
          );
      }
      names.add(name.toLowerCase());
      if (key && cat) {
        byKey.set(key, {
          row,
          key,
          name,
          description,
          categoryId: cat.id,
          categoryName: cat.name,
          unit,
          referencePrice: price,
          specs: [],
          criteria: [],
        });
      }
    }

    for (const { row, values: v } of specRows) {
      const p = byKey.get((v.key ?? '').trim().toUpperCase());
      if (!p) {
        err(
          'Specifications',
          row,
          'Product key',
          'No product with this key on "Products"',
        );
        continue;
      }
      const rule = (v.rule ?? '')
        .trim()
        .toUpperCase()
        .replace(/[\s-]/g, '_') as SpecRule;
      const attribute = (v.attribute ?? '').trim();
      const value = (v.value ?? '').trim();
      const max = (v.max ?? '').trim();
      if (!attribute) err('Specifications', row, 'Attribute', 'Required');
      if (!RULES.includes(rule))
        err('Specifications', row, 'Rule', `Use one of ${RULES.join(', ')}`);
      if (!value) err('Specifications', row, 'Value (or minimum)', 'Required');
      if (rule === 'RANGE' && !max)
        err(
          'Specifications',
          row,
          'Maximum (range only)',
          'Required for RANGE',
        );
      p.specs.push({
        attribute,
        rule,
        value,
        valueMax: rule === 'RANGE' ? max : null,
        unit: (v.unit ?? '').trim() || null,
      });
    }
    for (const { row, values: v } of critRows) {
      const p = byKey.get((v.key ?? '').trim().toUpperCase());
      if (!p) {
        err(
          'Receiving criteria',
          row,
          'Product key',
          'No product with this key on "Products"',
        );
        continue;
      }
      const text = (v.criterion ?? '').trim();
      if (text.length < 3) {
        err(
          'Receiving criteria',
          row,
          'Receiving criterion',
          'At least 3 characters',
        );
        continue;
      }
      const lib = catByCode
        .get(categories.find((c) => c.id === p.categoryId)!.code)!
        .criteria.find((c) => c.text.toLowerCase() === text.toLowerCase());
      p.criteria.push({ text, libraryId: lib?.id ?? null });
    }
    for (const p of byKey.values()) {
      if (!p.specs.length)
        err('Products', p.row, null, 'Needs at least one specification');
      if (!p.criteria.length)
        err('Products', p.row, null, 'Needs at least one receiving criterion');
    }
    return {
      products: [...byKey.values()],
      errors,
      totalRows: productRows.length,
    };
  }

  async upload(
    actor: CurrentUser,
    fileName: string,
    file: Buffer,
    departmentUniqueId?: string,
  ) {
    const dept = await this.department(actor, departmentUniqueId);
    const { products, errors, totalRows } = await this.validate(file, dept.id);
    const stored: Stored = { departmentId: dept.id, products };
    const batch = await this.prisma.dbRaw.importBatch.create({
      data: {
        type: TYPE,
        status: errors.length ? 'FAILED' : 'VALIDATED',
        fileName: fileName.slice(0, 200),
        file: new Uint8Array(file),
        totalRows,
        createCount: errors.length ? 0 : products.length,
        errorCount: errors.length,
        rows: stored as unknown as Prisma.InputJsonValue,
        uploadedById: actor.id,
        errors: { create: errors },
      },
      include: { errors: { orderBy: [{ row: 'asc' }, { id: 'asc' }] } },
    });
    await this.audit.log({
      action: 'item.import_upload',
      entityType: 'ImportBatch',
      entityId: batch.uniqueId,
      after: {
        fileName: batch.fileName,
        department: dept.code,
        status: batch.status,
        errors: errors.length,
      },
    });
    return batch;
  }

  /** All-or-nothing: create every product and submit it for activation. */
  async commit(actor: CurrentUser, uniqueId: string) {
    const batch = await this.prisma.dbRaw.importBatch.findUnique({
      where: { uniqueId },
    });
    if (!batch || batch.type !== TYPE)
      throw new NotFoundException('errors.record_not_found');
    if (batch.status !== 'VALIDATED')
      throw new BadRequestException('errors.import_not_committable');
    const stored = batch.rows as unknown as Stored;
    await this.access.assert(actor, 'item.import', {
      departmentId: stored.departmentId,
    });
    await this.access.assert(actor, 'item.submit', {
      departmentId: stored.departmentId,
    });

    await this.prisma.db.$transaction(
      async (tx) => {
        const { products, errors } = await this.validate(
          Buffer.from(batch.file),
          stored.departmentId,
          tx,
        );
        if (errors.length)
          throw new BadRequestException('errors.import_changed');
        const created: string[] = [];
        for (const p of products) {
          const product = await tx.product.create({
            data: { owningDepartmentId: stored.departmentId, status: 'DRAFT' },
          });
          await tx.productVersion.create({
            data: {
              productId: product.id,
              version: 1,
              authorUserId: actor.id,
              name: p.name,
              description: p.description,
              categoryId: p.categoryId,
              unit: p.unit,
              referencePrice: p.referencePrice,
              specs: {
                create: p.specs.map((s, i) => ({ ...s, sortOrder: i })),
              },
              criteria: {
                create: p.criteria.map((c, i) => ({ ...c, sortOrder: i })),
              },
            },
          });
          await this.products.submit(actor, product.uniqueId, tx);
          created.push(product.uniqueId);
        }
        await tx.importBatch.update({
          where: { id: batch.id },
          data: {
            status: 'COMMITTED',
            committedById: actor.id,
            committedAt: new Date(),
          },
        });
        await this.audit.log(
          {
            action: 'item.import_commit',
            entityType: 'ImportBatch',
            entityId: batch.uniqueId,
            after: { created: created.length },
          },
          tx,
        );
      },
      { timeout: 120_000 },
    );
    return this.get(uniqueId);
  }

  async errorReport(actor: CurrentUser, uniqueId: string) {
    await this.get(uniqueId, actor);
    const batch = await this.prisma.dbRaw.importBatch.findUnique({
      where: { uniqueId },
      include: { errors: true },
    });
    if (!batch || batch.type !== TYPE)
      throw new NotFoundException('errors.record_not_found');
    return errorWorkbook(Buffer.from(batch.file), batch.errors, 'Products');
  }

  async history(actor: CurrentUser) {
    const scope = await this.access.resolveScope(actor, 'item.import');
    const rows = await this.prisma.dbRaw.importBatch.findMany({
      where: { type: TYPE },
      orderBy: { createdAt: 'desc' },
      take: 100,
      omit: { file: true },
    });
    return rows
      .filter((r) => {
        const d = (r.rows as unknown as Stored).departmentId;
        return scope.all || scope.departmentIds.includes(d);
      })
      .slice(0, 50)
      .map((r) => ({ ...r, rows: undefined }));
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
      await this.access.assert(actor, 'item.import', {
        departmentId: (b.rows as unknown as Stored).departmentId,
      });
    }
    return b;
  }

  preview(rows: unknown) {
    const stored = rows as Stored | undefined;
    return (stored?.products ?? []).slice(0, 200).map((p) => ({
      row: p.row,
      key: p.key,
      name: p.name,
      category: p.categoryName,
      unit: p.unit,
      specs: p.specs.length,
      criteria: p.criteria.length,
    }));
  }
}
