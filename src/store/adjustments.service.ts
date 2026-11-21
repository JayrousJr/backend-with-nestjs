import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { I18nService } from 'nestjs-i18n';
import type {
  AdjustmentStatus,
  AdjustmentType,
  AssetCondition,
  Prisma,
} from '@db';
import { anyOf, PrismaService, type DbTx } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { NumberingService } from '../numbering/numbering.service';
import {
  APPROVAL_COMPLETED,
  WorkflowService,
  type ApprovalCompletedEvent,
} from '../workflow/workflow.service';
import { LedgerService } from './ledger.service';
import { locationPath, StoresService } from './stores.service';
import type { CreateAdjustmentInput } from './store.types';

const POINT = 'stock_adjustment.approval';
const SUBJECT = 'StockAdjustment';

/** Asset data on a serialised line (stored as JSON until posted). */
export interface LineAsset {
  tag: string | null;
  serialNumber: string | null;
  brand: string | null;
  model: string | null;
  condition: AssetCondition;
  purchaseDate: string | null;
  purchasePrice: number | null;
  priceEstimated: boolean;
  warrantyExpiry: string | null;
  notes: string | null;
  holderEmployeeId: number | null;
  holderLabel: string | null;
  owningDepartmentId: number | null;
  kitTag: string | null;
  isKit: boolean;
  vehicle: {
    registrationNumber: string;
    chassisNumber: string | null;
    engineNumber: string | null;
    fuelType: string | null;
    seatingCapacity: number | null;
    insuranceExpiry: string | null;
    roadLicenceExpiry: string | null;
    serviceIntervalKm: number | null;
    serviceIntervalMonths: number | null;
  } | null;
}

export interface NewLine {
  productId: number;
  locationId: number;
  quantity: number;
  batchNumber: string | null;
  expiryDate: string | null;
  asset: LineAsset | null;
}

const INCLUDE = {
  store: true,
  lines: { orderBy: { lineNo: 'asc' } },
} as const satisfies Prisma.StockAdjustmentInclude;
type Row = Prisma.StockAdjustmentGetPayload<{ include: typeof INCLUDE }>;

const day = (s?: string | null) =>
  s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null;

/**
 * Stock adjustments (B2 §4, §6, §12): opening balance from the tagging
 * campaign, found / donated items and corrections. Nothing is posted until
 * `stock_adjustment.approval` approves; posting writes assets, balances and
 * ledger rows in one transaction.
 */
@Injectable()
export class AdjustmentsService implements OnModuleInit {
  private readonly logger = new Logger(AdjustmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly numbering: NumberingService,
    private readonly ledger: LedgerService,
    private readonly stores: StoresService,
    private readonly i18n: I18nService,
  ) {}

  onModuleInit() {
    this.workflow.registerGuard(POINT, async (actor, request, decision) => {
      if (decision.decision !== 'APPROVE') return;
      const adj = await this.prisma.db.stockAdjustment.findUnique({
        where: { uniqueId: request.subjectId },
      });
      await this.policy.enforceSod(
        'SOD_ADJUST_SELF_APPROVE',
        !!adj && adj.createdByUserId === actor.id,
      );
    });
  }

  // ── create ───────────────────────────────────────────────────────────────

  /** Resolve and check a manual adjustment's lines. */
  private async resolveLines(
    input: CreateAdjustmentInput,
    storeId: number,
  ): Promise<NewLine[]> {
    const products = await this.prisma.db.product.findMany({
      where: { uniqueId: { in: input.lines.map((l) => l.productUniqueId) } },
    });
    const locations = await this.prisma.db.storeLocation.findMany({
      where: { storeId, kind: 'GENERAL', isActive: true },
    });
    const productBy = new Map(products.map((p) => [p.uniqueId, p]));
    const locationBy = new Map(locations.map((l) => [l.uniqueId, l]));
    const seenTags = new Set<string>();
    const lines: NewLine[] = [];
    for (const [i, l] of input.lines.entries()) {
      const fail = (message: string) =>
        new BadRequestException({ message, args: { line: i + 1 } });
      const p = productBy.get(l.productUniqueId);
      if (!p || p.status !== 'ACTIVE' || !p.trackingType)
        throw fail('errors.adjustment_line_product');
      const loc = locationBy.get(l.locationUniqueId);
      if (!loc) throw fail('errors.adjustment_line_location');
      if (p.trackingType === 'SERIALISED') {
        if (input.type === 'CORRECTION')
          throw fail('errors.adjustment_correction_assets');
        if (l.quantity !== 1 || !l.asset)
          throw fail('errors.adjustment_line_asset');
        const tag = l.asset.tag?.trim().toUpperCase() || null;
        if (tag) {
          if (seenTags.has(tag)) throw fail('errors.adjustment_tag_twice');
          seenTags.add(tag);
        }
        if (p.isVehicle && !l.asset.vehicle)
          throw fail('errors.adjustment_vehicle_data');
        const v = l.asset.vehicle;
        lines.push({
          productId: p.id,
          locationId: loc.id,
          quantity: 1,
          batchNumber: null,
          expiryDate: null,
          asset: {
            tag,
            serialNumber: l.asset.serialNumber?.trim() || null,
            brand: l.asset.brand?.trim() || null,
            model: l.asset.model?.trim() || null,
            condition: l.asset.condition,
            purchaseDate: l.asset.purchaseDate ?? null,
            purchasePrice: l.asset.purchasePrice ?? null,
            priceEstimated: l.asset.priceEstimated ?? false,
            warrantyExpiry: l.asset.warrantyExpiry ?? null,
            notes: l.asset.notes?.trim() || null,
            holderEmployeeId: null,
            holderLabel: null,
            owningDepartmentId: null,
            kitTag: null,
            isKit: false,
            vehicle:
              p.isVehicle && v
                ? {
                    registrationNumber: v.registrationNumber
                      .trim()
                      .toUpperCase(),
                    chassisNumber: v.chassisNumber?.trim() || null,
                    engineNumber: v.engineNumber?.trim() || null,
                    fuelType: v.fuelType?.trim() || null,
                    seatingCapacity: v.seatingCapacity ?? null,
                    insuranceExpiry: v.insuranceExpiry ?? null,
                    roadLicenceExpiry: v.roadLicenceExpiry ?? null,
                    serviceIntervalKm: v.serviceIntervalKm ?? null,
                    serviceIntervalMonths: v.serviceIntervalMonths ?? null,
                  }
                : null,
          },
        });
      } else {
        if (!l.quantity) throw fail('errors.adjustment_line_quantity');
        if (l.quantity < 0 && input.type !== 'CORRECTION')
          throw fail('errors.adjustment_line_quantity');
        if (p.trackingType === 'BATCH' && !l.batchNumber?.trim())
          throw fail('errors.adjustment_line_batch');
        lines.push({
          productId: p.id,
          locationId: loc.id,
          quantity: l.quantity,
          batchNumber:
            p.trackingType === 'BATCH' ? l.batchNumber!.trim() : null,
          expiryDate:
            p.trackingType === 'BATCH' ? (l.expiryDate ?? null) : null,
          asset: null,
        });
      }
    }
    await this.checkTags(
      lines.flatMap((l) => (l.asset?.tag ? [l.asset.tag] : [])),
    );
    return lines;
  }

  /** Pre-printed tags must be issued and not yet on an asset. */
  async checkTags(tags: string[], tx?: DbTx) {
    if (!tags.length) return;
    const found = await (tx ?? this.prisma.db).assetTag.findMany({
      where: { tag: { in: tags } },
      include: { asset: true },
    });
    const by = new Map(found.map((t) => [t.tag, t]));
    for (const tag of tags) {
      const t = by.get(tag);
      if (!t)
        throw new BadRequestException({
          message: 'errors.tag_unknown',
          args: { tag },
        });
      if (t.asset)
        throw new BadRequestException({
          message: 'errors.tag_used',
          args: { tag },
        });
    }
  }

  async create(actor: CurrentUser, input: CreateAdjustmentInput) {
    const store = await this.stores.byUniqueId(input.storeUniqueId);
    await this.access.assert(actor, 'stock.adjust', { storeId: store.id });
    const lines = await this.resolveLines(input, store.id);
    const adj = await this.prisma.db.$transaction((tx) =>
      this.createDocument(
        tx,
        actor,
        store.id,
        input.type,
        input.reason.trim(),
        lines,
      ),
    );
    return this.get(actor, adj.uniqueId);
  }

  /** Write the document and start its approval (used by imports too). */
  async createDocument(
    tx: DbTx,
    actor: CurrentUser,
    storeId: number,
    type: AdjustmentType,
    reason: string,
    lines: NewLine[],
    importBatchId?: number,
  ) {
    const store = await tx.store.findUniqueOrThrow({ where: { id: storeId } });
    const number = await this.numbering.document('ADJ', tx);
    const adj = await tx.stockAdjustment.create({
      data: {
        number,
        type,
        status: 'IN_APPROVAL',
        storeId,
        reason,
        createdByUserId: actor.id,
        importBatchId: importBatchId ?? null,
        lines: {
          create: lines.map((l, i) => ({
            lineNo: i + 1,
            productId: l.productId,
            locationId: l.locationId,
            quantity: l.quantity,
            batchNumber: l.batchNumber,
            expiryDate: day(l.expiryDate),
            asset: (l.asset ?? undefined) as Prisma.InputJsonValue | undefined,
          })),
        },
      },
    });
    await this.startApproval(tx, actor, adj.id, store.managingDepartmentId);
    await this.audit.log(
      {
        action: 'stock.adjust',
        entityType: SUBJECT,
        entityId: number,
        after: {
          type,
          store: store.code,
          reason,
          lines: lines.length,
          assets: lines.filter((l) => l.asset).length,
        },
      },
      tx,
    );
    return adj;
  }

  private async startApproval(
    tx: DbTx,
    actor: CurrentUser,
    id: number,
    departmentId: number,
  ) {
    const adj = await tx.stockAdjustment.findUniqueOrThrow({
      where: { id },
      include: { store: true, _count: { select: { lines: true } } },
    });
    const label: Record<AdjustmentType, string> = {
      OPENING_BALANCE: 'Opening balance',
      FOUND: 'Found items',
      DONATED: 'Donated items',
      COUNT_VARIANCE: 'Count variance',
      CORRECTION: 'Correction',
    };
    const req = await this.workflow.start(
      {
        pointCode: POINT,
        subjectType: SUBJECT,
        subjectId: adj.uniqueId,
        subjectDepartmentId: departmentId,
        title: `${label[adj.type]} ${adj.number} — ${adj.store.name} (${adj._count.lines} lines)`,
        requesterUserId: actor.id,
        context: {
          type: adj.type,
          store: adj.store.code,
          lines: adj._count.lines,
        },
      },
      tx,
    );
    await tx.stockAdjustment.update({
      where: { id },
      data: { approvalRequestId: req.id },
    });
  }

  async resubmit(actor: CurrentUser, uniqueId: string) {
    const adj = await this.load(uniqueId);
    if (adj.status !== 'RETURNED')
      throw new BadRequestException('errors.adjustment_not_returned');
    await this.access.assert(actor, 'stock.adjust', { storeId: adj.storeId });
    await this.prisma.db.$transaction(async (tx) => {
      await tx.stockAdjustment.update({
        where: { id: adj.id },
        data: { status: 'IN_APPROVAL' },
      });
      await this.startApproval(
        tx,
        actor,
        adj.id,
        adj.store.managingDepartmentId,
      );
      await this.audit.log(
        {
          action: 'stock.adjust_resubmit',
          entityType: SUBJECT,
          entityId: adj.number,
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  async cancel(actor: CurrentUser, uniqueId: string, reason: string) {
    const adj = await this.load(uniqueId);
    if (adj.status !== 'IN_APPROVAL' && adj.status !== 'RETURNED') {
      throw new BadRequestException('errors.adjustment_not_cancellable');
    }
    await this.access.assert(actor, 'stock.adjust', { storeId: adj.storeId });
    if (!reason?.trim())
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      await tx.stockAdjustment.update({
        where: { id: adj.id },
        data: { status: 'CANCELLED' },
      });
      if (adj.status === 'IN_APPROVAL' && adj.approvalRequestId) {
        await this.workflow.cancel(adj.approvalRequestId, reason, tx);
      }
      await this.audit.log(
        {
          action: 'stock.adjust_cancel',
          entityType: SUBJECT,
          entityId: adj.number,
          after: { reason },
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  // ── posting ──────────────────────────────────────────────────────────────

  @OnEvent(APPROVAL_COMPLETED, { async: true })
  async onCompleted(e: ApprovalCompletedEvent) {
    if (e.pointCode !== POINT || e.subjectType !== SUBJECT) return;
    const map: Record<ApprovalCompletedEvent['status'], AdjustmentStatus> = {
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED',
      RETURNED: 'RETURNED',
      CANCELLED: 'CANCELLED',
    };
    // Conditional update: waits for the creating transaction to commit.
    const moved = await this.prisma.db.stockAdjustment.updateMany({
      where: { uniqueId: e.subjectId, status: 'IN_APPROVAL' },
      data: { status: map[e.status] },
    });
    if (!moved.count || e.status !== 'APPROVED') return;
    await this.post(e.subjectId, e.deciderUserId ?? null);
  }

  /** Post an approved adjustment. Failures are kept on the document. */
  async post(uniqueId: string, userId: number | null) {
    try {
      await this.prisma.db.$transaction(
        async (tx) => {
          const adj = await tx.stockAdjustment.findUniqueOrThrow({
            where: { uniqueId },
            include: INCLUDE,
          });
          if (adj.status !== 'APPROVED' || adj.postedAt) return;
          const products = await tx.product.findMany({
            where: { id: { in: adj.lines.map((l) => l.productId) } },
          });
          const productBy = new Map(products.map((p) => [p.id, p]));
          const ref = {
            type:
              adj.type === 'OPENING_BALANCE'
                ? ('OPENING_BALANCE' as const)
                : ('ADJUSTMENT' as const),
            userId,
            referenceType: SUBJECT,
            referenceId: adj.number,
            reason: adj.reason,
          };
          const source =
            adj.type === 'FOUND'
              ? 'FOUND'
              : adj.type === 'DONATED'
                ? 'DONATED'
                : 'OPENING_BALANCE';
          const tagToAsset = new Map<string, number>();
          const kits: { assetId: number; kitTag: string; line: number }[] = [];

          await this.checkTags(
            adj.lines.flatMap((l) =>
              (l.asset as LineAsset | null)?.tag
                ? [(l.asset as unknown as LineAsset).tag!]
                : [],
            ),
            tx,
          );
          for (const line of adj.lines) {
            const p = productBy.get(line.productId)!;
            const a = line.asset as unknown as LineAsset | null;
            if (!a) {
              await this.ledger.moveQuantity(
                tx,
                {
                  storeId: adj.storeId,
                  locationId: line.locationId,
                  productId: line.productId,
                  batchNumber: line.batchNumber,
                  expiryDate: line.expiryDate,
                },
                line.quantity,
                ref,
              );
              continue;
            }
            if (!p.currentVersionId)
              throw new Error(`Line ${line.lineNo}: product not active`);
            if (a.serialNumber) {
              const dup = await tx.asset.findFirst({
                where: { productId: p.id, serialNumber: a.serialNumber },
              });
              if (dup)
                throw new Error(
                  `Line ${line.lineNo}: serial ${a.serialNumber} already on ${dup.tag}`,
                );
            }
            const tag = a.tag
              ? await tx.assetTag.findUniqueOrThrow({ where: { tag: a.tag } })
              : (
                  await this.ledger.issueTags(
                    await this.categoryPrefix(tx, p.currentVersionId),
                    1,
                    userId,
                    tx,
                  )
                )[0];
            const held = a.holderEmployeeId != null;
            const asset = await this.ledger.createAsset(
              tx,
              {
                tagId: tag.id,
                serialNumber: a.serialNumber,
                brand: a.brand,
                model: a.model,
                productId: p.id,
                productVersionId: p.currentVersionId,
                owningDepartmentId:
                  a.owningDepartmentId ?? p.owningDepartmentId,
                source,
                purchasePrice: a.purchasePrice,
                priceEstimated: a.priceEstimated,
                purchaseDate: day(a.purchaseDate),
                warrantyExpiry: day(a.warrantyExpiry),
                storeId: adj.storeId,
                locationId: held ? null : line.locationId,
                custodianEmployeeId: a.holderEmployeeId,
                condition: a.condition,
                status: held ? 'ASSIGNED_TO_EMPLOYEE' : 'IN_STORE',
                isKit: a.isKit,
                notes: a.notes,
              },
              ref,
            );
            if (a.vehicle) {
              await tx.vehicleDetails.create({
                data: {
                  ...a.vehicle,
                  insuranceExpiry: day(a.vehicle.insuranceExpiry),
                  roadLicenceExpiry: day(a.vehicle.roadLicenceExpiry),
                  assetId: asset.id,
                },
              });
            }
            await tx.stockAdjustmentLine.update({
              where: { id: line.id },
              data: { assetId: asset.id },
            });
            tagToAsset.set(asset.tag, asset.id);
            if (a.kitTag)
              kits.push({
                assetId: asset.id,
                kitTag: a.kitTag,
                line: line.lineNo,
              });
          }
          // Kit membership: components point to their kit (in this file or existing).
          for (const k of kits) {
            let parentId = tagToAsset.get(k.kitTag);
            if (!parentId) {
              const existing = await tx.asset.findUnique({
                where: { tag: k.kitTag },
              });
              if (!existing)
                throw new Error(`Line ${k.line}: kit ${k.kitTag} not found`);
              parentId = existing.id;
            }
            if (parentId === k.assetId)
              throw new Error(`Line ${k.line}: an asset cannot be its own kit`);
            await tx.asset.update({
              where: { id: parentId },
              data: { isKit: true },
            });
            await tx.asset.update({
              where: { id: k.assetId },
              data: { parentAssetId: parentId },
            });
          }
          await tx.stockAdjustment.update({
            where: { id: adj.id },
            data: { postedAt: new Date(), postError: null },
          });
          await this.audit.log(
            {
              action: 'stock.adjust_post',
              entityType: SUBJECT,
              entityId: adj.number,
              after: { lines: adj.lines.length, assets: tagToAsset.size },
            },
            tx,
          );
        },
        { timeout: 300_000 },
      );
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (error instanceof BadRequestException) {
        const r = error.getResponse() as {
          message?: string;
          args?: Record<string, unknown>;
        };
        if (typeof r.message === 'string' && r.message.startsWith('errors.')) {
          message = String(
            this.i18n.t(r.message, { lang: 'en', args: r.args }),
          );
        }
      }
      this.logger.error(`Posting adjustment ${uniqueId} failed: ${message}`);
      await this.prisma.db.stockAdjustment.update({
        where: { uniqueId },
        data: { postError: message.slice(0, 1000) },
      });
    }
  }

  private async categoryPrefix(tx: DbTx, versionId: number) {
    const v = await tx.productVersion.findUniqueOrThrow({
      where: { id: versionId },
      include: { category: true },
    });
    return v.category.tagPrefix;
  }

  /** Retry posting after fixing the cause (e.g. a tag used meanwhile). */
  async retryPost(actor: CurrentUser, uniqueId: string) {
    const adj = await this.load(uniqueId);
    if (adj.status !== 'APPROVED' || adj.postedAt) {
      throw new BadRequestException('errors.adjustment_not_postable');
    }
    await this.access.assert(actor, 'stock.adjust', { storeId: adj.storeId });
    await this.post(uniqueId, actor.id);
    return this.get(actor, uniqueId);
  }

  // ── queries ──────────────────────────────────────────────────────────────

  private async load(uniqueId: string) {
    const a = await this.prisma.db.stockAdjustment.findUnique({
      where: { uniqueId },
      include: INCLUDE,
    });
    if (!a) throw new NotFoundException('errors.record_not_found');
    return a;
  }

  private async canSee(user: CurrentUser, adj: Row) {
    if (adj.createdByUserId === user.id) return true;
    if (await this.access.can(user, 'store.manage')) return true;
    if (await this.stores.canSeeStore(user, adj.storeId)) return true;
    if (adj.approvalRequestId) {
      const n = await this.prisma.db.approvalAssignment.count({
        where: { requestId: adj.approvalRequestId, userId: user.id },
      });
      if (n) return true;
    }
    return false;
  }

  async get(user: CurrentUser, uniqueId: string) {
    const adj = await this.load(uniqueId);
    if (!(await this.canSee(user, adj)))
      throw new ForbiddenException('errors.forbidden');
    return (await this.present(user, [adj], true))[0];
  }

  async list(
    user: CurrentUser,
    storeUniqueId?: string,
    status?: AdjustmentStatus,
  ) {
    const manage = await this.access.can(user, 'store.manage');
    const scope = await this.stores.stockScope(user);
    const or: Prisma.StockAdjustmentWhereInput[] = [
      { createdByUserId: user.id },
    ];
    if (manage || scope.all) or.push({});
    if (scope.storeIds.length) or.push({ storeId: { in: scope.storeIds } });
    const rows = await this.prisma.db.stockAdjustment.findMany({
      where: {
        AND: [
          anyOf(or),
          storeUniqueId ? { store: { uniqueId: storeUniqueId } } : {},
          status ? { status } : {},
        ],
      },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.present(user, rows, false);
  }

  private async present(user: CurrentUser, rows: Row[], withLines: boolean) {
    const userIds = [...new Set(rows.map((r) => r.createdByUserId))];
    const users = await this.prisma.dbRaw.user.findMany({
      where: { id: { in: userIds } },
      include: { employee: true },
    });
    const nameBy = new Map(
      users.map((u) => [
        u.id,
        `${u.employee.firstName} ${u.employee.lastName}`,
      ]),
    );
    const reqs = await this.prisma.db.approvalRequest.findMany({
      where: {
        id: {
          in: rows
            .map((r) => r.approvalRequestId)
            .filter((x): x is number => !!x),
        },
      },
      select: { id: true, uniqueId: true },
    });
    const reqBy = new Map(reqs.map((r) => [r.id, r.uniqueId]));
    const lineProducts = withLines
      ? await this.prisma.db.product.findMany({
          where: {
            id: {
              in: [
                ...new Set(
                  rows.flatMap((r) => r.lines.map((l) => l.productId)),
                ),
              ],
            },
          },
          include: { currentVersion: true },
        })
      : [];
    const productBy = new Map(lineProducts.map((p) => [p.id, p]));
    const locations = withLines
      ? await this.prisma.db.storeLocation.findMany({
          where: { storeId: { in: rows.map((r) => r.storeId) } },
        })
      : [];
    const locBy = new Map(locations.map((l) => [l.id, l]));
    const assets = withLines
      ? await this.prisma.db.asset.findMany({
          where: {
            id: {
              in: rows.flatMap((r) =>
                r.lines.map((l) => l.assetId).filter((x): x is number => !!x),
              ),
            },
          },
          select: { id: true, uniqueId: true, tag: true },
        })
      : [];
    const assetBy = new Map(assets.map((a) => [a.id, a]));
    const storeIds = [...new Set(rows.map((r) => r.storeId))];
    const acts = await Promise.all(
      storeIds.map((storeId) =>
        this.access.can(user, 'stock.adjust', { storeId }),
      ),
    );
    const mayActIn = new Map(storeIds.map((id, i) => [id, acts[i]]));
    return rows.map((r) => {
      const mayAct = mayActIn.get(r.storeId) ?? false;
      return {
        uniqueId: r.uniqueId,
        number: r.number,
        type: r.type,
        status: r.status,
        store: {
          uniqueId: r.store.uniqueId,
          code: r.store.code,
          name: r.store.name,
        },
        reason: r.reason,
        createdBy: nameBy.get(r.createdByUserId) ?? '—',
        createdAt: r.createdAt,
        postedAt: r.postedAt,
        postError: r.postError,
        approvalRequestUniqueId: r.approvalRequestId
          ? (reqBy.get(r.approvalRequestId) ?? null)
          : null,
        lineCount: r.lines.length,
        assetCount: r.lines.filter((l) => l.asset).length,
        quantityTotal: r.lines.reduce((s, l) => s + l.quantity, 0),
        lines: withLines
          ? r.lines.map((l) => {
              const a = l.asset as unknown as LineAsset | null;
              const p = productBy.get(l.productId);
              const loc = locBy.get(l.locationId);
              const posted = l.assetId ? assetBy.get(l.assetId) : undefined;
              return {
                lineNo: l.lineNo,
                productUniqueId: p?.uniqueId ?? '',
                productCode: p?.code ?? null,
                productName: p?.currentVersion?.name ?? '—',
                location: loc ? locationPath(loc, locations) : '—',
                quantity: l.quantity,
                batchNumber: l.batchNumber,
                expiryDate: l.expiryDate,
                tag: posted?.tag ?? a?.tag ?? null,
                serialNumber: a?.serialNumber ?? null,
                brand: a?.brand ?? null,
                model: a?.model ?? null,
                condition: a?.condition ?? null,
                holder: a?.holderLabel ?? null,
                kitTag: a?.kitTag ?? null,
                assetUniqueId: posted?.uniqueId ?? null,
              };
            })
          : [],
        canResubmit: mayAct && r.status === 'RETURNED',
        canCancel:
          mayAct && (r.status === 'IN_APPROVAL' || r.status === 'RETURNED'),
      };
    });
  }
}
