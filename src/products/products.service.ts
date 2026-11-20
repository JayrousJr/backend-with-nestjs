import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma, ProductStatus } from '@db';
import { PrismaService, type DbTx } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { NumberingService } from '../numbering/numbering.service';
import {
  APPROVAL_COMPLETED,
  APPROVAL_STEP_OPENED,
  WorkflowService,
  type ApprovalCompletedEvent,
  type ApprovalStepOpenedEvent,
} from '../workflow/workflow.service';
import type {
  CreateProductInput,
  ProductActivationInput,
  ProductFilterInput,
  ProductVersionInput,
  SaveCategoryInput,
} from './products.types';

const POINT = 'product.activation';
const SUBJECT = 'ProductVersion';
const OPEN_VERSION = ['DRAFT', 'IN_APPROVAL', 'RETURNED'] as const;

const VERSION_INCLUDE = {
  category: true,
  specs: { orderBy: { sortOrder: 'asc' } },
  criteria: { orderBy: { sortOrder: 'asc' } },
  attachments: { include: { file: true } },
} as const satisfies Prisma.ProductVersionInclude;

const PRODUCT_INCLUDE = {
  owningDepartment: true,
  currentVersion: { include: VERSION_INCLUDE },
  versions: {
    where: { status: { in: [...OPEN_VERSION] } },
    orderBy: { version: 'desc' },
    take: 1,
    include: VERSION_INCLUDE,
  },
  mergedInto: { include: { currentVersion: true } },
  _count: { select: { assets: true } },
} as const satisfies Prisma.ProductInclude;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;
type VersionRow = Prisma.ProductVersionGetPayload<{
  include: typeof VERSION_INCLUDE;
}>;

/**
 * Product Repository (tender spec §5): one shared catalogue. Each
 * department creates its own products and owns them; Procurement sets the
 * activation fields; editing an Active product creates a new version that
 * goes through `product.activation` again.
 */
@Injectable()
export class ProductsService implements OnModuleInit {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly numbering: NumberingService,
  ) {}

  onModuleInit() {
    this.workflow.registerGuard(POINT, async (actor, request, decision) => {
      if (decision.decision !== 'APPROVE') return;
      const version = await this.prisma.db.productVersion.findUnique({
        where: { uniqueId: request.subjectId },
        include: { product: true },
      });
      if (!version) return;
      // SOD_PRODUCT_SELF_APPROVE: the author never approves activation.
      await this.policy.enforceSod(
        'SOD_PRODUCT_SELF_APPROVE',
        version.authorUserId === actor.id,
      );
      if (decision.lastStep && !this.activationComplete(version.product)) {
        throw new BadRequestException('errors.product_activation_incomplete');
      }
    });
  }

  private activationComplete(p: {
    itemType: unknown;
    trackingType: unknown;
    acquisitionMethod: unknown;
    vatRate: unknown;
  }) {
    return (
      p.itemType != null &&
      p.trackingType != null &&
      p.acquisitionMethod != null &&
      p.vatRate != null
    );
  }

  // ── categories ───────────────────────────────────────────────────────────

  async categories(includeInactive = false) {
    const rows = await this.prisma.db.productCategory.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      include: {
        criteria: {
          where: includeInactive ? {} : { isActive: true },
          orderBy: { sortOrder: 'asc' },
        },
        _count: { select: { versions: true } },
      },
    });
    return rows.map((c) => ({ ...c, productCount: c._count.versions }));
  }

  async saveCategory(actor: CurrentUser, input: SaveCategoryInput) {
    await this.access.assert(actor, 'item_category.manage');
    const code = input.code.trim().toUpperCase();
    const tagPrefix = input.tagPrefix.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(code) || !/^[A-Z0-9]+$/.test(tagPrefix)) {
      throw new BadRequestException('errors.code_format');
    }
    const clash = await this.prisma.db.productCategory.findFirst({
      where: {
        OR: [{ code }, { tagPrefix }],
        ...(input.uniqueId ? { NOT: { uniqueId: input.uniqueId } } : {}),
      },
    });
    if (clash) throw new BadRequestException('errors.category_code_in_use');

    const criteria = [...new Set(input.criteria.map((c) => c.trim()))].filter(
      Boolean,
    );
    const saved = await this.prisma.db.$transaction(async (tx) => {
      let before: unknown = null;
      let category;
      if (input.uniqueId) {
        const existing = await tx.productCategory.findUnique({
          where: { uniqueId: input.uniqueId },
          include: { criteria: true },
        });
        if (!existing) throw new NotFoundException('errors.record_not_found');
        if (existing.tagPrefix !== tagPrefix) {
          const used = await tx.assetTag.count({
            where: { prefix: existing.tagPrefix },
          });
          if (used) throw new BadRequestException('errors.tag_prefix_in_use');
        }
        before = existing;
        category = await tx.productCategory.update({
          where: { id: existing.id },
          data: {
            code,
            name: input.name.trim(),
            tagPrefix,
            isActive: input.isActive,
          },
        });
        // Library entries are never deleted: missing ones are deactivated.
        for (const c of existing.criteria) {
          const at = criteria.indexOf(c.text);
          await tx.categoryCriterion.update({
            where: { id: c.id },
            data:
              at >= 0 ? { isActive: true, sortOrder: at } : { isActive: false },
          });
        }
        const known = new Set(existing.criteria.map((c) => c.text));
        const fresh = criteria
          .map((text, sortOrder) => ({ text, sortOrder }))
          .filter((c) => !known.has(c.text));
        if (fresh.length) {
          await tx.categoryCriterion.createMany({
            data: fresh.map((c) => ({ ...c, categoryId: existing.id })),
          });
        }
      } else {
        category = await tx.productCategory.create({
          data: {
            code,
            name: input.name.trim(),
            tagPrefix,
            isActive: input.isActive,
            criteria: {
              create: criteria.map((text, sortOrder) => ({ text, sortOrder })),
            },
          },
        });
      }
      await this.audit.log(
        {
          action: input.uniqueId
            ? 'item_category.update'
            : 'item_category.create',
          entityType: 'ProductCategory',
          entityId: category.uniqueId,
          before,
          after: { ...category, criteria },
        },
        tx,
      );
      return category;
    });
    return (await this.categories(true)).find((c) => c.id === saved.id)!;
  }

  // ── visibility ───────────────────────────────────────────────────────────

  /** Departments where the user may author products. */
  private async authorDepartments(user: CurrentUser) {
    const [create, edit] = await Promise.all([
      this.access.resolveScope(user, 'item.create'),
      this.access.resolveScope(user, 'item.edit_draft'),
    ]);
    return [...new Set([...create.departmentIds, ...edit.departmentIds])];
  }

  private async visibleWhere(
    user: CurrentUser,
  ): Promise<Prisma.ProductWhereInput> {
    if (await this.access.can(user, 'item.manage')) return {};
    const or: Prisma.ProductWhereInput[] = [];
    if (await this.access.can(user, 'item.view')) {
      or.push({ currentVersionId: { not: null } });
    }
    const depts = await this.authorDepartments(user);
    if (depts.length) or.push({ owningDepartmentId: { in: depts } });
    if (!or.length) throw new ForbiddenException('errors.forbidden');
    return { OR: or };
  }

  /** Approvers of a pending version may open it from their inbox. */
  private async isApprover(user: CurrentUser, p: ProductRow) {
    const reqId = p.versions[0]?.approvalRequestId;
    if (!reqId) return false;
    const n = await this.prisma.db.approvalAssignment.count({
      where: { requestId: reqId, userId: user.id },
    });
    return n > 0;
  }

  /** By product uniqueId, or by one of its versions' (approval links). */
  private async load(uniqueId: string, tx?: DbTx) {
    const db = tx ?? this.prisma.db;
    let p = await db.product.findUnique({
      where: { uniqueId },
      include: PRODUCT_INCLUDE,
    });
    if (!p) {
      const v = await db.productVersion.findUnique({ where: { uniqueId } });
      if (v) {
        p = await db.product.findUnique({
          where: { id: v.productId },
          include: PRODUCT_INCLUDE,
        });
      }
    }
    if (!p || p.isDeleted)
      throw new NotFoundException('errors.record_not_found');
    return p;
  }

  private async assertVisible(user: CurrentUser, p: ProductRow) {
    const where = await this.visibleWhere(user).catch(() => null);
    if (where) {
      const n = await this.prisma.db.product.count({
        where: { AND: [{ id: p.id }, where] },
      });
      if (n) return;
    }
    if (await this.isApprover(user, p)) return;
    throw new ForbiddenException('errors.forbidden');
  }

  // ── queries ──────────────────────────────────────────────────────────────

  async list(
    user: CurrentUser,
    filter: ProductFilterInput = {},
    page = 1,
    limit = 20,
  ) {
    const and: Prisma.ProductWhereInput[] = [await this.visibleWhere(user)];
    if (filter.search?.trim()) {
      const q = filter.search.trim();
      and.push({
        OR: [
          { code: { contains: q, mode: 'insensitive' } },
          {
            versions: { some: { name: { contains: q, mode: 'insensitive' } } },
          },
        ],
      });
    }
    if (filter.statuses?.length) and.push({ status: { in: filter.statuses } });
    if (filter.itemType) and.push({ itemType: filter.itemType });
    if (filter.categoryUniqueId) {
      and.push({
        OR: [
          {
            currentVersion: { category: { uniqueId: filter.categoryUniqueId } },
          },
          {
            currentVersionId: null,
            versions: {
              some: { category: { uniqueId: filter.categoryUniqueId } },
            },
          },
        ],
      });
    }
    if (filter.departmentUniqueId) {
      and.push({ owningDepartment: { uniqueId: filter.departmentUniqueId } });
    }
    if (filter.pendingOnly) {
      and.push({ versions: { some: { status: 'IN_APPROVAL' } } });
    }
    const where: Prisma.ProductWhereInput = { AND: and };
    limit = Math.min(Math.max(limit, 1), 100);
    page = Math.max(page, 1);
    const [rows, total] = await Promise.all([
      this.prisma.db.product.findMany({
        where,
        include: {
          owningDepartment: true,
          currentVersion: { include: { category: true } },
          versions: {
            where: { status: { in: [...OPEN_VERSION] } },
            orderBy: { version: 'desc' },
            take: 1,
            include: { category: true },
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.db.product.count({ where }),
    ]);
    return {
      data: rows.map((p) => {
        const v = p.currentVersion ?? p.versions[0];
        return {
          uniqueId: p.uniqueId,
          code: p.code,
          status: p.status,
          name: v?.name ?? '—',
          categoryName: v?.category.name ?? '—',
          unit: v?.unit ?? '',
          departmentName: p.owningDepartment.name,
          itemType: p.itemType,
          trackingType: p.trackingType,
          hasPendingVersion: !!p.currentVersion && p.versions.length > 0,
          updatedAt: p.updatedAt,
        };
      }),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async get(user: CurrentUser, uniqueId: string) {
    const p = await this.load(uniqueId);
    await this.assertVisible(user, p);
    return this.present(user, p);
  }

  /** Version history (every version, newest first). */
  async versions(user: CurrentUser, uniqueId: string) {
    const p = await this.load(uniqueId);
    await this.assertVisible(user, p);
    const rows = await this.prisma.db.productVersion.findMany({
      where: { productId: p.id },
      orderBy: { version: 'desc' },
      include: VERSION_INCLUDE,
    });
    return this.presentVersions(rows);
  }

  /** "Search before create": Active and in-progress products with similar names. */
  async similar(user: CurrentUser, name: string, excludeUniqueId?: string) {
    await this.access.assert(user, 'item.view');
    const words = name
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((w) => w.length >= 3)
      .slice(0, 6);
    if (!words.length) return [];
    const rows = await this.prisma.db.product.findMany({
      where: {
        status: { notIn: ['REJECTED', 'RETIRED'] },
        ...(excludeUniqueId ? { NOT: { uniqueId: excludeUniqueId } } : {}),
        versions: {
          some: {
            OR: words.map((w) => ({
              name: { contains: w, mode: 'insensitive' as const },
            })),
          },
        },
      },
      include: {
        owningDepartment: true,
        currentVersion: { include: { category: true } },
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          include: { category: true },
        },
      },
      take: 40,
    });
    const score = (n: string) =>
      words.filter((w) => n.toLowerCase().includes(w)).length;
    return rows
      .map((p) => {
        const v = p.currentVersion ?? p.versions[0];
        return {
          uniqueId: p.uniqueId,
          code: p.code,
          status: p.status,
          name: v.name,
          categoryName: v.category.name,
          unit: v.unit,
          departmentName: p.owningDepartment.name,
          itemType: p.itemType,
          trackingType: p.trackingType,
          hasPendingVersion: false,
          updatedAt: p.updatedAt,
          score: score(v.name),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }

  // ── authoring ────────────────────────────────────────────────────────────

  private async versionData(input: ProductVersionInput, tx: DbTx) {
    const category = await tx.productCategory.findUnique({
      where: { uniqueId: input.categoryUniqueId },
      include: { criteria: true },
    });
    if (!category || !category.isActive) {
      throw new BadRequestException('errors.category_not_found');
    }
    const library = new Map(category.criteria.map((c) => [c.uniqueId, c.id]));
    const files = input.attachmentUniqueIds.length
      ? await tx.file.findMany({
          where: { uniqueId: { in: input.attachmentUniqueIds } },
        })
      : [];
    if (files.length !== new Set(input.attachmentUniqueIds).size) {
      throw new BadRequestException('errors.file_not_found');
    }
    for (const s of input.specs) {
      if (s.rule === 'RANGE' && !s.valueMax?.trim()) {
        throw new BadRequestException('errors.spec_range_needs_max');
      }
    }
    return {
      fields: {
        name: input.name.trim(),
        description: input.description.trim(),
        categoryId: category.id,
        unit: input.unit.trim(),
        referencePrice: input.referencePrice ?? null,
      },
      specs: input.specs.map((s, i) => ({
        sortOrder: i,
        attribute: s.attribute.trim(),
        rule: s.rule,
        value: s.value.trim(),
        valueMax: s.rule === 'RANGE' ? s.valueMax!.trim() : null,
        unit: s.unit?.trim() || null,
      })),
      criteria: input.criteria.map((c, i) => ({
        sortOrder: i,
        text: c.text.trim(),
        libraryId: c.libraryUniqueId
          ? (library.get(c.libraryUniqueId) ?? null)
          : null,
      })),
      fileIds: files.map((f) => f.id),
    };
  }

  async create(actor: CurrentUser, input: CreateProductInput) {
    const departmentId = input.departmentUniqueId
      ? (
          await this.prisma.db.department.findUnique({
            where: { uniqueId: input.departmentUniqueId },
          })
        )?.id
      : actor.departmentId;
    if (!departmentId)
      throw new BadRequestException('errors.department_not_found');
    await this.access.assert(actor, 'item.create', { departmentId });

    const product = await this.prisma.db.$transaction(async (tx) => {
      const d = await this.versionData(input, tx);
      const p = await tx.product.create({
        data: { owningDepartmentId: departmentId, status: 'DRAFT' },
      });
      await tx.productVersion.create({
        data: {
          productId: p.id,
          version: 1,
          authorUserId: actor.id,
          ...d.fields,
          specs: { create: d.specs },
          criteria: { create: d.criteria },
          attachments: { create: d.fileIds.map((fileId) => ({ fileId })) },
        },
      });
      await this.audit.log(
        {
          action: 'item.create',
          entityType: 'Product',
          entityId: p.uniqueId,
          after: { ...d.fields, specs: d.specs, criteria: d.criteria },
        },
        tx,
      );
      return p;
    });
    return this.get(actor, product.uniqueId);
  }

  /** Edit the open (draft / returned) version. */
  async updateDraft(
    actor: CurrentUser,
    productUniqueId: string,
    input: ProductVersionInput,
  ) {
    const p = await this.load(productUniqueId);
    const v = p.versions[0];
    if (!v || (v.status !== 'DRAFT' && v.status !== 'RETURNED')) {
      throw new BadRequestException('errors.product_not_editable');
    }
    await this.access.assert(actor, 'item.edit_draft', {
      departmentId: p.owningDepartmentId,
    });
    await this.prisma.db.$transaction(async (tx) => {
      const d = await this.versionData(input, tx);
      await tx.productSpec.deleteMany({ where: { versionId: v.id } });
      await tx.productCriterion.deleteMany({ where: { versionId: v.id } });
      await tx.productAttachment.deleteMany({ where: { versionId: v.id } });
      await tx.productVersion.update({
        where: { id: v.id },
        data: {
          ...d.fields,
          specs: { create: d.specs },
          criteria: { create: d.criteria },
          attachments: { create: d.fileIds.map((fileId) => ({ fileId })) },
        },
      });
      await tx.product.update({
        where: { id: p.id },
        data: { updatedAt: new Date() },
      });
      await this.audit.log(
        {
          action: 'item.edit_draft',
          entityType: 'Product',
          entityId: p.uniqueId,
          before: this.snapshot(v),
          after: { ...d.fields, specs: d.specs, criteria: d.criteria },
        },
        tx,
      );
    });
    return this.get(actor, productUniqueId);
  }

  /** Start a new version of an Active product (a copy of the version in force). */
  async revise(actor: CurrentUser, productUniqueId: string) {
    const p = await this.load(productUniqueId);
    if (!p.currentVersion || p.status === 'RETIRED') {
      throw new BadRequestException('errors.product_not_revisable');
    }
    if (p.versions.length) {
      throw new BadRequestException('errors.product_version_open');
    }
    await this.access.assert(actor, 'item.edit_draft', {
      departmentId: p.owningDepartmentId,
    });
    const cur = p.currentVersion;
    await this.prisma.db.$transaction(async (tx) => {
      const last = await tx.productVersion.aggregate({
        where: { productId: p.id },
        _max: { version: true },
      });
      const v = await tx.productVersion.create({
        data: {
          productId: p.id,
          version: (last._max.version ?? 0) + 1,
          authorUserId: actor.id,
          name: cur.name,
          description: cur.description,
          categoryId: cur.categoryId,
          unit: cur.unit,
          referencePrice: cur.referencePrice,
          specs: {
            create: cur.specs.map(
              ({ sortOrder, attribute, rule, value, valueMax, unit }) => ({
                sortOrder,
                attribute,
                rule,
                value,
                valueMax,
                unit,
              }),
            ),
          },
          criteria: {
            create: cur.criteria.map(({ sortOrder, text, libraryId }) => ({
              sortOrder,
              text,
              libraryId,
            })),
          },
          attachments: {
            create: cur.attachments.map((a) => ({ fileId: a.fileId })),
          },
        },
      });
      await this.audit.log(
        {
          action: 'item.revise',
          entityType: 'Product',
          entityId: p.uniqueId,
          after: { version: v.version },
        },
        tx,
      );
    });
    return this.get(actor, productUniqueId);
  }

  /** Submit the open version for activation (`product.activation`). */
  async submit(actor: CurrentUser, productUniqueId: string, tx?: DbTx) {
    const run = async (db: DbTx) => {
      const p = await this.load(productUniqueId, db);
      const v = p.versions[0];
      if (!v || (v.status !== 'DRAFT' && v.status !== 'RETURNED')) {
        throw new BadRequestException('errors.product_not_submittable');
      }
      await this.access.assert(actor, 'item.submit', {
        departmentId: p.owningDepartmentId,
      });
      if (!v.specs.length || !v.criteria.length) {
        throw new BadRequestException('errors.product_minimum_content');
      }
      if (!v.category.isActive) {
        throw new BadRequestException('errors.category_not_found');
      }
      // Status first: the approval may complete (no steps) right away.
      await db.productVersion.update({
        where: { id: v.id },
        data: { status: 'IN_APPROVAL', submittedAt: new Date() },
      });
      if (!p.currentVersion) {
        await db.product.update({
          where: { id: p.id },
          data: { status: 'SUBMITTED' },
        });
      }
      const request = await this.workflow.start(
        {
          pointCode: POINT,
          subjectType: SUBJECT,
          subjectId: v.uniqueId,
          subjectDepartmentId: p.owningDepartmentId,
          title: `Product: ${v.name}${v.version > 1 ? ` (version ${v.version})` : ''}`,
          requesterUserId: actor.id,
          context: {
            revision: !!p.currentVersion,
            department: p.owningDepartment.code,
            category: v.category.code,
          },
        },
        db,
      );
      await db.productVersion.update({
        where: { id: v.id },
        data: { approvalRequestId: request.id },
      });
      // Earlier steps skipped at start (e.g. the HOD submitted it): already in review.
      const first = Math.min(
        ...(request.version?.steps ?? []).map((st) => st.order),
      );
      if (
        !p.currentVersion &&
        request.status === 'PENDING' &&
        request.currentStepOrder != null &&
        request.currentStepOrder > first
      ) {
        await db.product.update({
          where: { id: p.id },
          data: { status: 'IN_REVIEW' },
        });
      }
      await this.audit.log(
        {
          action: 'item.submit',
          entityType: 'Product',
          entityId: p.uniqueId,
          after: { version: v.version, approval: request.uniqueId },
        },
        db,
      );
    };
    if (tx) await run(tx);
    else await this.prisma.db.$transaction((t) => run(t as DbTx));
    return tx ? null : this.get(actor, productUniqueId);
  }

  // ── Procurement ──────────────────────────────────────────────────────────

  /** Activation fields set by Procurement (§5.3). */
  async setActivation(actor: CurrentUser, input: ProductActivationInput) {
    await this.access.assert(actor, 'item.manage');
    const p = await this.load(input.productUniqueId);
    if (p.status === 'RETIRED' || p.status === 'REJECTED') {
      throw new BadRequestException('errors.product_not_editable');
    }
    if (
      input.itemType === 'FIXED_ASSET' &&
      input.trackingType !== 'SERIALISED'
    ) {
      throw new BadRequestException('errors.product_asset_must_be_serialised');
    }
    if (
      input.itemType !== 'FIXED_ASSET' &&
      input.trackingType === 'SERIALISED'
    ) {
      throw new BadRequestException('errors.product_serialised_only_assets');
    }
    if (input.isVehicle && input.itemType !== 'FIXED_ASSET') {
      throw new BadRequestException('errors.product_vehicle_is_asset');
    }
    if (
      input.acquisitionMethod === 'SINGLE_SOURCE' &&
      !input.singleSourceVendor?.trim()
    ) {
      throw new BadRequestException('errors.product_single_source_vendor');
    }
    const stocked =
      p._count.assets > 0 ||
      (await this.prisma.db.stockBalance.count({
        where: { productId: p.id },
      })) > 0;
    if (
      stocked &&
      (p.itemType !== input.itemType ||
        p.trackingType !== input.trackingType ||
        p.isVehicle !== input.isVehicle)
    ) {
      throw new BadRequestException('errors.product_type_locked');
    }
    const code = input.code?.trim().toUpperCase() || p.code || null;
    if (code && code !== p.code) {
      if (!/^[A-Z0-9][A-Z0-9-]*$/.test(code)) {
        throw new BadRequestException('errors.code_format');
      }
      const clash = await this.prisma.db.product.findUnique({
        where: { code },
      });
      if (clash) throw new BadRequestException('errors.product_code_in_use');
    }
    const data = {
      code,
      itemType: input.itemType,
      trackingType: input.trackingType,
      acquisitionMethod: input.acquisitionMethod,
      singleSourceVendor:
        input.acquisitionMethod === 'SINGLE_SOURCE'
          ? input.singleSourceVendor!.trim()
          : null,
      vatRate: input.vatRate,
      isVehicle: input.isVehicle,
    };
    await this.prisma.db.$transaction(async (tx) => {
      await tx.product.update({ where: { id: p.id }, data });
      await this.audit.log(
        {
          action: 'item.set_activation',
          entityType: 'Product',
          entityId: p.uniqueId,
          before: {
            code: p.code,
            itemType: p.itemType,
            trackingType: p.trackingType,
            acquisitionMethod: p.acquisitionMethod,
            singleSourceVendor: p.singleSourceVendor,
            vatRate: p.vatRate,
            isVehicle: p.isVehicle,
          },
          after: data,
        },
        tx,
      );
    });
    return this.get(actor, p.uniqueId);
  }

  async setStatus(
    actor: CurrentUser,
    uniqueId: string,
    status: Extract<ProductStatus, 'ACTIVE' | 'INACTIVE' | 'RETIRED'>,
    reason: string,
  ) {
    await this.access.assert(actor, 'item.manage');
    const p = await this.load(uniqueId);
    if (!p.currentVersion || p.status === 'RETIRED') {
      throw new BadRequestException('errors.product_status_change');
    }
    if (!reason?.trim())
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      await tx.product.update({ where: { id: p.id }, data: { status } });
      await this.audit.log(
        {
          action: 'item.set_status',
          entityType: 'Product',
          entityId: p.uniqueId,
          before: { status: p.status },
          after: { status, reason },
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  async transferOwnership(
    actor: CurrentUser,
    uniqueId: string,
    departmentUniqueId: string,
    reason: string,
  ) {
    await this.access.assert(actor, 'item.manage');
    const p = await this.load(uniqueId);
    const dept = await this.prisma.db.department.findUnique({
      where: { uniqueId: departmentUniqueId },
    });
    if (!dept || !dept.isActive) {
      throw new BadRequestException('errors.department_not_found');
    }
    if (!reason?.trim())
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: p.id },
        data: { owningDepartmentId: dept.id },
      });
      await this.audit.log(
        {
          action: 'item.transfer_ownership',
          entityType: 'Product',
          entityId: p.uniqueId,
          before: { owningDepartment: p.owningDepartment.code },
          after: { owningDepartment: dept.code, reason },
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  /**
   * Duplicate control: retire `from` and point it to `into`. Only products
   * that never reached the store can be merged (nothing references them).
   */
  async merge(
    actor: CurrentUser,
    fromUniqueId: string,
    intoUniqueId: string,
    reason: string,
  ) {
    await this.access.assert(actor, 'item.merge');
    if (fromUniqueId === intoUniqueId) {
      throw new BadRequestException('errors.product_merge_same');
    }
    const [from, into] = await Promise.all([
      this.load(fromUniqueId),
      this.load(intoUniqueId),
    ]);
    if (into.status !== 'ACTIVE') {
      throw new BadRequestException('errors.product_merge_target_active');
    }
    const balances = await this.prisma.db.stockBalance.count({
      where: { productId: from.id },
    });
    if (from._count.assets || balances) {
      throw new BadRequestException('errors.product_merge_in_use');
    }
    if (!reason?.trim())
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      const open = from.versions[0];
      if (open?.status === 'IN_APPROVAL' && open.approvalRequestId) {
        await this.workflow.cancel(
          open.approvalRequestId,
          `Merged into ${into.code}`,
          tx,
        );
      }
      if (open) {
        await tx.productVersion.update({
          where: { id: open.id },
          data: { status: 'REJECTED' },
        });
      }
      await tx.product.update({
        where: { id: from.id },
        data: { status: 'RETIRED', mergedIntoId: into.id },
      });
      await this.audit.log(
        {
          action: 'item.merge',
          entityType: 'Product',
          entityId: from.uniqueId,
          before: { status: from.status },
          after: { status: 'RETIRED', mergedInto: into.code, reason },
        },
        tx,
      );
    });
    return this.get(actor, fromUniqueId);
  }

  // ── workflow events ──────────────────────────────────────────────────────

  @OnEvent(APPROVAL_STEP_OPENED, { async: true })
  async onStepOpened(e: ApprovalStepOpenedEvent) {
    if (e.pointCode !== POINT || e.first) return;
    await this.prisma.db.product.updateMany({
      where: {
        status: 'SUBMITTED',
        versions: { some: { uniqueId: e.subjectId, status: 'IN_APPROVAL' } },
      },
      data: { status: 'IN_REVIEW' },
    });
  }

  @OnEvent(APPROVAL_COMPLETED, { async: true })
  async onCompleted(e: ApprovalCompletedEvent) {
    if (e.pointCode !== POINT || e.subjectType !== SUBJECT) return;
    try {
      await this.prisma.db.$transaction(async (tx) => {
        // Conditional update first: waits for the submitting transaction.
        const moved = await tx.productVersion.updateMany({
          where: { uniqueId: e.subjectId, status: 'IN_APPROVAL' },
          data:
            e.status === 'APPROVED'
              ? { status: 'ACTIVE', activatedAt: new Date() }
              : { status: e.status === 'CANCELLED' ? 'DRAFT' : e.status },
        });
        if (!moved.count) return;
        const v = await tx.productVersion.findUniqueOrThrow({
          where: { uniqueId: e.subjectId },
          include: { product: true, category: true },
        });
        const p = v.product;
        const firstVersion = p.currentVersionId == null;
        if (e.status === 'APPROVED') {
          if (p.currentVersionId) {
            await tx.productVersion.update({
              where: { id: p.currentVersionId },
              data: { status: 'SUPERSEDED' },
            });
          }
          const code =
            p.code ??
            `${v.category.code}-${String(
              await this.numbering.next(`PRODUCT-${v.category.code}`, tx),
            ).padStart(4, '0')}`;
          await tx.product.update({
            where: { id: p.id },
            data: {
              currentVersionId: v.id,
              code,
              ...(firstVersion ? { status: 'ACTIVE' } : {}),
            },
          });
        } else if (firstVersion) {
          const map: Record<string, ProductStatus> = {
            REJECTED: 'REJECTED',
            RETURNED: 'RETURNED',
            CANCELLED: 'DRAFT',
          };
          await tx.product.update({
            where: { id: p.id },
            data: { status: map[e.status] },
          });
        }
        await this.audit.log(
          {
            action: `item.activation_${e.status.toLowerCase()}`,
            entityType: 'Product',
            entityId: p.uniqueId,
            after: { version: v.version },
          },
          tx,
        );
      });
    } catch (error) {
      this.logger.error(`Product activation ${e.subjectId}: ${error}`);
    }
  }

  // ── presentation ─────────────────────────────────────────────────────────

  private snapshot(v: VersionRow) {
    return {
      name: v.name,
      description: v.description,
      category: v.category.code,
      unit: v.unit,
      referencePrice: v.referencePrice,
      specs: v.specs.map(({ attribute, rule, value, valueMax, unit }) => ({
        attribute,
        rule,
        value,
        valueMax,
        unit,
      })),
      criteria: v.criteria.map((c) => c.text),
    };
  }

  private async names(ids: number[]) {
    const users = await this.prisma.dbRaw.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      include: { employee: true },
    });
    return new Map(
      users.map((u) => [
        u.id,
        `${u.employee.firstName} ${u.employee.lastName}`,
      ]),
    );
  }

  private async presentVersions(rows: VersionRow[]) {
    const names = await this.names(rows.map((v) => v.authorUserId));
    const reqIds = rows
      .map((v) => v.approvalRequestId)
      .filter((x): x is number => !!x);
    const reqs = reqIds.length
      ? await this.prisma.db.approvalRequest.findMany({
          where: { id: { in: reqIds } },
          select: { id: true, uniqueId: true },
        })
      : [];
    const reqUid = new Map(reqs.map((r) => [r.id, r.uniqueId]));
    return rows.map((v) => ({
      uniqueId: v.uniqueId,
      version: v.version,
      status: v.status,
      name: v.name,
      description: v.description,
      category: {
        uniqueId: v.category.uniqueId,
        code: v.category.code,
        name: v.category.name,
      },
      unit: v.unit,
      referencePrice:
        v.referencePrice != null ? Number(v.referencePrice) : null,
      author: names.get(v.authorUserId) ?? '—',
      createdAt: v.createdAt,
      submittedAt: v.submittedAt,
      activatedAt: v.activatedAt,
      approvalRequestUniqueId: v.approvalRequestId
        ? (reqUid.get(v.approvalRequestId) ?? null)
        : null,
      specs: v.specs,
      criteria: v.criteria.map((c) => ({
        text: c.text,
        fromLibrary: c.libraryId != null,
      })),
      attachments: v.attachments.map((a) => ({
        uniqueId: a.file.uniqueId,
        filename: a.file.filename,
        mimeType: a.file.mimeType,
        size: a.file.size,
        uri: a.file.uri,
      })),
    }));
  }

  private async present(user: CurrentUser, p: ProductRow) {
    const [current, pending] = await this.presentVersions(
      [p.currentVersion, p.versions[0]].filter((v): v is VersionRow => !!v),
    ).then((list) => {
      const byId = new Map(list.map((v) => [v.uniqueId, v]));
      return [
        p.currentVersion ? byId.get(p.currentVersion.uniqueId)! : null,
        p.versions[0] ? byId.get(p.versions[0].uniqueId)! : null,
      ];
    });
    const dept = { departmentId: p.owningDepartmentId };
    const open = p.versions[0];
    const editable =
      !!open && (open.status === 'DRAFT' || open.status === 'RETURNED');
    const [edit, submit, manage, merge] = await Promise.all([
      this.access.can(user, 'item.edit_draft', dept),
      this.access.can(user, 'item.submit', dept),
      this.access.can(user, 'item.manage'),
      this.access.can(user, 'item.merge'),
    ]);
    const shown = current ?? pending;
    return {
      uniqueId: p.uniqueId,
      code: p.code,
      status: p.status,
      name: shown?.name ?? '—',
      categoryName: shown?.category.name ?? '—',
      unit: shown?.unit ?? '',
      owningDepartment: {
        uniqueId: p.owningDepartment.uniqueId,
        code: p.owningDepartment.code,
        name: p.owningDepartment.name,
      },
      itemType: p.itemType,
      trackingType: p.trackingType,
      acquisitionMethod: p.acquisitionMethod,
      singleSourceVendor: p.singleSourceVendor,
      vatRate: p.vatRate != null ? Number(p.vatRate) : null,
      isVehicle: p.isVehicle,
      mergedInto: p.mergedInto
        ? {
            uniqueId: p.mergedInto.uniqueId,
            code: p.mergedInto.code ?? '',
            name: p.mergedInto.currentVersion?.name ?? '',
          }
        : null,
      current,
      pending,
      assetCount: p._count.assets,
      createdAt: p.createdAt,
      can: {
        edit: editable && edit,
        submit: editable && submit,
        revise: !!p.currentVersion && !open && p.status !== 'RETIRED' && edit,
        manage: manage && p.status !== 'RETIRED',
        merge: merge && p.status !== 'RETIRED',
      },
    };
  }
}
