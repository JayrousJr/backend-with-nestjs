import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { CountScope, CountStatus, Prisma } from '@db';
import { PrismaService } from '@prisma';
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
import { LedgerService, type TxnRef } from './ledger.service';
import { ReorderService } from './reorder.service';
import { locationPath, StoresService } from './stores.service';

const POINT = 'stock_count.approval';
const SUBJECT = 'StockCount';

const INCLUDE = {
  lines: { orderBy: { id: 'asc' } },
} as const satisfies Prisma.StockCountInclude;
type Row = Prisma.StockCountGetPayload<{ include: typeof INCLUDE }>;

export interface CreateCountInput {
  storeUniqueId: string;
  scope: CountScope;
  locationUniqueIds?: string[];
  categoryUniqueId?: string;
  note?: string;
}

/**
 * Stock counts (B2 §8): full or cycle (locations / category). Starting a
 * count snapshots the expected stock and freezes movements for what is
 * counted. Counting is blind; assets are scanned, consumables counted.
 * Variances go through `stock_count.approval`, then become adjustment
 * transactions; assets not found become missing.
 */
@Injectable()
export class CountsService {
  private readonly logger = new Logger(CountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly numbering: NumberingService,
    private readonly ledger: LedgerService,
    private readonly stores: StoresService,
    private readonly reorder: ReorderService,
  ) {}

  private async load(uniqueId: string) {
    const c = await this.prisma.db.stockCount.findUnique({
      where: { uniqueId },
      include: INCLUDE,
    });
    if (!c) throw new NotFoundException('errors.record_not_found');
    return c;
  }

  // ── start ────────────────────────────────────────────────────────────────

  async create(actor: CurrentUser, input: CreateCountInput) {
    const store = await this.stores.byUniqueId(input.storeUniqueId);
    await this.access.assert(actor, 'stock_count.create', {
      storeId: store.id,
    });
    const locations = await this.prisma.db.storeLocation.findMany({
      where: { storeId: store.id, kind: 'GENERAL' },
    });
    let locationIds: number[] = [];
    let categoryId: number | null = null;
    if (input.scope === 'LOCATION') {
      // A location includes the shelves / bins inside it.
      const picked = locations.filter((l) =>
        input.locationUniqueIds?.includes(l.uniqueId),
      );
      if (!picked.length) throw new BadRequestException('errors.count_scope');
      const ids = new Set(picked.map((l) => l.id));
      let grew = true;
      while (grew) {
        grew = false;
        for (const l of locations) {
          if (l.parentId && ids.has(l.parentId) && !ids.has(l.id)) {
            ids.add(l.id);
            grew = true;
          }
        }
      }
      locationIds = [...ids];
    } else if (input.scope === 'CATEGORY') {
      const cat = input.categoryUniqueId
        ? await this.prisma.db.productCategory.findUnique({
            where: { uniqueId: input.categoryUniqueId },
          })
        : null;
      if (!cat) throw new BadRequestException('errors.count_scope');
      categoryId = cat.id;
    }
    const inScopeLoc = locationIds.length
      ? { in: locationIds }
      : { in: locations.map((l) => l.id) };
    const productScope = categoryId ? { currentVersion: { categoryId } } : {};

    const count = await this.prisma.db.$transaction(async (tx) => {
      const [assets, balances] = await Promise.all([
        tx.asset.findMany({
          where: {
            storeId: store.id,
            status: { in: ['IN_STORE', 'RESERVED'] },
            locationId: inScopeLoc,
            product: productScope,
          },
        }),
        tx.stockBalance.findMany({
          where: {
            storeId: store.id,
            locationId: inScopeLoc,
            product: productScope,
            onHand: { gt: 0 },
          },
        }),
      ]);
      const number = await this.numbering.document('CNT', tx);
      const c = await tx.stockCount.create({
        data: {
          number,
          storeId: store.id,
          scope: input.scope,
          locationIds,
          categoryId,
          note: input.note?.trim() || null,
          createdByUserId: actor.id,
          lines: {
            create: [
              ...assets.map((a) => ({
                productId: a.productId,
                assetId: a.id,
                locationId: a.locationId!,
                expectedQty: 1,
              })),
              ...balances.map((b) => ({
                productId: b.productId,
                locationId: b.locationId,
                batchNumber: b.batchNumber || null,
                expectedQty: b.onHand,
              })),
            ],
          },
        },
      });
      await this.audit.log(
        {
          action: 'stock_count.create',
          entityType: SUBJECT,
          entityId: number,
          after: {
            store: store.code,
            scope: input.scope,
            assets: assets.length,
            quantities: balances.length,
          },
        },
        tx,
      );
      return c;
    });
    return this.get(actor, count.uniqueId);
  }

  // ── counting ─────────────────────────────────────────────────────────────

  private async assertCounter(actor: CurrentUser, c: Row) {
    if (c.status !== 'COUNTING')
      throw new BadRequestException('errors.count_status');
    await this.access.assert(actor, 'stock_count.count', {
      storeId: c.storeId,
    });
  }

  /** Enter counted quantities (consumables) or found/not found (assets). */
  async record(
    actor: CurrentUser,
    uniqueId: string,
    entries: { lineId: number; countedQty: number; note?: string }[],
  ) {
    const c = await this.load(uniqueId);
    await this.assertCounter(actor, c);
    const ids = new Set(c.lines.map((l) => l.id));
    await this.prisma.db.$transaction(async (tx) => {
      for (const e of entries) {
        if (!ids.has(e.lineId) || e.countedQty < 0) {
          throw new BadRequestException('errors.count_line');
        }
        const line = c.lines.find((l) => l.id === e.lineId)!;
        await tx.stockCountLine.update({
          where: { id: e.lineId },
          data: {
            countedQty: line.assetId ? Math.min(e.countedQty, 1) : e.countedQty,
            countedByUserId: actor.id,
            countedAt: new Date(),
            note: e.note?.trim() || line.note,
          },
        });
      }
    });
    return this.get(actor, uniqueId);
  }

  /** Scan a tag: marks the expected asset found, or records an unexpected one. */
  async scan(
    actor: CurrentUser,
    uniqueId: string,
    tag: string,
    locationUniqueId?: string,
  ) {
    const c = await this.load(uniqueId);
    await this.assertCounter(actor, c);
    const asset = await this.prisma.db.asset.findFirst({
      where: { tag: { equals: tag.trim(), mode: 'insensitive' } },
    });
    if (!asset)
      throw new NotFoundException({
        message: 'errors.tag_unknown',
        args: { tag },
      });
    const line = c.lines.find((l) => l.assetId === asset.id);
    if (line) {
      await this.prisma.db.stockCountLine.update({
        where: { id: line.id },
        data: {
          countedQty: 1,
          countedByUserId: actor.id,
          countedAt: new Date(),
        },
      });
    } else {
      // Found where it was not expected (other location / status): recorded for review.
      const loc = locationUniqueId
        ? await this.prisma.db.storeLocation.findUnique({
            where: { uniqueId: locationUniqueId },
          })
        : null;
      const locationId =
        loc && loc.storeId === c.storeId
          ? loc.id
          : (c.locationIds[0] ??
            (await this.prisma.db.storeLocation.findFirst({
              where: { storeId: c.storeId, kind: 'GENERAL' },
            }))!.id);
      await this.prisma.db.stockCountLine.create({
        data: {
          countId: c.id,
          productId: asset.productId,
          assetId: asset.id,
          locationId,
          expectedQty: 0,
          countedQty: 1,
          unexpected: true,
          countedByUserId: actor.id,
          countedAt: new Date(),
          note: `Expected: ${asset.status}${asset.storeId !== c.storeId ? ' in another store' : ''}`,
        },
      });
    }
    return this.get(actor, uniqueId);
  }

  async submit(actor: CurrentUser, uniqueId: string) {
    const c = await this.load(uniqueId);
    await this.assertCounter(actor, c);
    if (c.lines.some((l) => l.countedQty == null)) {
      throw new BadRequestException('errors.count_not_complete');
    }
    // SOD_COUNT_CUSTODIAN: the store's storekeepers may not be the only counters.
    const keepers = new Set(await this.stores.keeperUserIds(c.storeId));
    const counters = new Set(
      c.lines.map((l) => l.countedByUserId).filter((x): x is number => !!x),
    );
    await this.policy.enforceSod(
      'SOD_COUNT_CUSTODIAN',
      counters.size > 0 && [...counters].every((u) => keepers.has(u)),
    );
    const store = await this.prisma.db.store.findUniqueOrThrow({
      where: { id: c.storeId },
    });
    const variances = c.lines.filter(
      (l) => l.countedQty !== l.expectedQty,
    ).length;
    await this.prisma.db.$transaction(async (tx) => {
      await tx.stockCount.update({
        where: { id: c.id },
        data: { status: 'IN_APPROVAL', submittedAt: new Date() },
      });
      const req = await this.workflow.start(
        {
          pointCode: POINT,
          subjectType: SUBJECT,
          subjectId: c.uniqueId,
          subjectDepartmentId: store.managingDepartmentId,
          title: `Stock count ${c.number} — ${store.name} (${variances} variances)`,
          requesterUserId: actor.id,
          context: { store: store.code, variances },
        },
        tx,
      );
      await tx.stockCount.update({
        where: { id: c.id },
        data: { approvalRequestId: req.id },
      });
      await this.audit.log(
        {
          action: 'stock_count.submit',
          entityType: SUBJECT,
          entityId: c.number,
          after: { variances },
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  async cancel(actor: CurrentUser, uniqueId: string, reason: string) {
    const c = await this.load(uniqueId);
    if (c.status !== 'COUNTING')
      throw new BadRequestException('errors.count_status');
    await this.access.assert(actor, 'stock_count.create', {
      storeId: c.storeId,
    });
    if (!reason?.trim())
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      await tx.stockCount.update({
        where: { id: c.id },
        data: { status: 'CANCELLED' },
      });
      await this.audit.log(
        {
          action: 'stock_count.cancel',
          entityType: SUBJECT,
          entityId: c.number,
          after: { reason },
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  // ── approval → posting ───────────────────────────────────────────────────

  @OnEvent(APPROVAL_COMPLETED, { async: true })
  async onCompleted(e: ApprovalCompletedEvent) {
    if (e.pointCode !== POINT || e.subjectType !== SUBJECT) return;
    if (e.status === 'RETURNED') {
      // Back to counting (recount), movements frozen again.
      await this.prisma.db.stockCount.updateMany({
        where: { uniqueId: e.subjectId, status: 'IN_APPROVAL' },
        data: { status: 'COUNTING', approvalRequestId: null },
      });
      return;
    }
    const status: CountStatus =
      e.status === 'APPROVED'
        ? 'APPROVED'
        : e.status === 'REJECTED'
          ? 'REJECTED'
          : 'CANCELLED';
    const moved = await this.prisma.db.stockCount.updateMany({
      where: { uniqueId: e.subjectId, status: 'IN_APPROVAL' },
      data: { status },
    });
    if (!moved.count || status !== 'APPROVED') return;
    await this.post(e.subjectId, e.deciderUserId ?? null);
  }

  async post(uniqueId: string, userId: number | null) {
    const c = await this.load(uniqueId);
    if (c.status !== 'APPROVED' || c.postedAt) return;
    try {
      await this.prisma.db.$transaction(
        async (tx) => {
          const ref: TxnRef = {
            type: 'ADJUSTMENT',
            userId,
            referenceType: SUBJECT,
            referenceId: c.number,
            reason: 'Stock count variance',
          };
          for (const l of c.lines) {
            const diff = (l.countedQty ?? 0) - l.expectedQty;
            if (!diff && !l.unexpected) continue;
            if (l.assetId) {
              const a = await tx.asset.findUniqueOrThrow({
                where: { id: l.assetId },
              });
              if (
                diff < 0 &&
                (a.status === 'IN_STORE' || a.status === 'RESERVED')
              ) {
                await this.ledger.moveAsset(
                  tx,
                  a,
                  { status: 'MISSING', locationId: null },
                  ref,
                );
              } else if (
                l.unexpected &&
                a.storeId === c.storeId &&
                (a.status === 'IN_STORE' || a.status === 'MISSING')
              ) {
                // In this store but elsewhere / missing: put it where it was found.
                await this.ledger.moveAsset(
                  tx,
                  a,
                  { status: 'IN_STORE', locationId: l.locationId },
                  ref,
                );
              }
              // Unexpected assets of another store are left for follow-up (noted on the line).
            } else {
              await this.ledger.moveQuantity(
                tx,
                {
                  storeId: c.storeId,
                  locationId: l.locationId,
                  productId: l.productId,
                  batchNumber: l.batchNumber,
                },
                diff,
                ref,
              );
            }
          }
          await tx.stockCount.update({
            where: { id: c.id },
            data: { postedAt: new Date(), postError: null },
          });
          await this.audit.log(
            {
              action: 'stock_count.post',
              entityType: SUBJECT,
              entityId: c.number,
            },
            tx,
          );
        },
        { timeout: 120_000 },
      );
      await this.reorder.check(
        c.lines.map((l) => ({ storeId: c.storeId, productId: l.productId })),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Posting count ${c.number} failed: ${message}`);
      await this.prisma.db.stockCount.update({
        where: { id: c.id },
        data: {
          postError:
            'Could not post the variances (reserved stock may be involved). Review and try again.',
        },
      });
    }
  }

  async retryPost(actor: CurrentUser, uniqueId: string) {
    const c = await this.load(uniqueId);
    await this.access.assert(actor, 'stock_count.create', {
      storeId: c.storeId,
    });
    await this.post(uniqueId, actor.id);
    return this.get(actor, uniqueId);
  }

  // ── queries ──────────────────────────────────────────────────────────────

  private async canSee(user: CurrentUser, c: Row) {
    if (c.createdByUserId === user.id) return true;
    if (await this.stores.canSeeStore(user, c.storeId)) return true;
    if (
      await this.access.can(user, 'stock_count.count', { storeId: c.storeId })
    )
      return true;
    if (c.approvalRequestId) {
      const n = await this.prisma.db.approvalAssignment.count({
        where: { requestId: c.approvalRequestId, userId: user.id },
      });
      if (n) return true;
    }
    return false;
  }

  async list(user: CurrentUser, storeUniqueId?: string) {
    const scope = await this.stores.stockScope(user);
    const countStores = (
      await this.access.resolveScope(user, 'stock_count.count')
    ).storeIds;
    const store = storeUniqueId
      ? await this.stores.byUniqueId(storeUniqueId)
      : null;
    const rows = await this.prisma.db.stockCount.findMany({
      where: {
        AND: [
          scope.all
            ? {}
            : {
                OR: [
                  { createdByUserId: user.id },
                  { storeId: { in: [...scope.storeIds, ...countStores] } },
                ],
              },
          store ? { storeId: store.id } : {},
        ],
      },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return this.present(user, rows, false);
  }

  async get(user: CurrentUser, uniqueId: string) {
    const c = await this.load(uniqueId);
    if (!(await this.canSee(user, c)))
      throw new ForbiddenException('errors.forbidden');
    return (await this.present(user, [c], true))[0];
  }

  private async present(user: CurrentUser, rows: Row[], withLines: boolean) {
    const stores = await this.prisma.db.store.findMany({
      where: { id: { in: rows.map((r) => r.storeId) } },
    });
    const storeBy = new Map(stores.map((s) => [s.id, s]));
    const userIds = rows
      .flatMap((r) => [
        r.createdByUserId,
        ...r.lines.map((l) => l.countedByUserId),
      ])
      .filter((x): x is number => !!x);
    const users = await this.prisma.dbRaw.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
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
    const pBy = new Map(lineProducts.map((p) => [p.id, p]));
    const assets = withLines
      ? await this.prisma.db.asset.findMany({
          where: {
            id: {
              in: rows
                .flatMap((r) => r.lines.map((l) => l.assetId))
                .filter((x): x is number => !!x),
            },
          },
          select: { id: true, uniqueId: true, tag: true, serialNumber: true },
        })
      : [];
    const aBy = new Map(assets.map((a) => [a.id, a]));
    const locations = withLines
      ? await this.prisma.db.storeLocation.findMany({
          where: { storeId: { in: rows.map((r) => r.storeId) } },
        })
      : [];
    const lBy = new Map(locations.map((l) => [l.id, l]));
    const category = await this.prisma.db.productCategory.findMany({
      where: {
        id: {
          in: rows.map((r) => r.categoryId).filter((x): x is number => !!x),
        },
      },
    });
    const catBy = new Map(category.map((c) => [c.id, c.name]));

    return Promise.all(
      rows.map(async (c) => {
        const s = storeBy.get(c.storeId)!;
        const [canCount, canManage] = await Promise.all([
          this.access.can(user, 'stock_count.count', { storeId: c.storeId }),
          this.access.can(user, 'stock_count.create', { storeId: c.storeId }),
        ]);
        // Blind count: expected quantities stay hidden while counting.
        const blind = c.status === 'COUNTING';
        const counted = c.lines.filter((l) => l.countedQty != null).length;
        return {
          uniqueId: c.uniqueId,
          number: c.number,
          status: c.status,
          scope: c.scope,
          scopeLabel:
            c.scope === 'FULL'
              ? 'Whole store'
              : c.scope === 'CATEGORY'
                ? (catBy.get(c.categoryId!) ?? '')
                : c.locationIds
                    .map((id) => lBy.get(id)?.name ?? '')
                    .filter(Boolean)
                    .join(', ') || `${c.locationIds.length} locations`,
          store: { uniqueId: s.uniqueId, code: s.code, name: s.name },
          note: c.note,
          createdBy: nameBy.get(c.createdByUserId) ?? '—',
          createdAt: c.createdAt,
          submittedAt: c.submittedAt,
          postedAt: c.postedAt,
          postError: c.postError,
          approvalRequestUniqueId: c.approvalRequestId
            ? (reqBy.get(c.approvalRequestId) ?? null)
            : null,
          lineCount: c.lines.length,
          countedCount: counted,
          varianceCount: blind
            ? null
            : c.lines.filter((l) => l.countedQty !== l.expectedQty).length,
          lines: withLines
            ? c.lines.map((l) => {
                const p = pBy.get(l.productId);
                const a = l.assetId ? aBy.get(l.assetId) : undefined;
                const loc = lBy.get(l.locationId);
                return {
                  id: l.id,
                  productName: p?.currentVersion?.name ?? '—',
                  productCode: p?.code ?? null,
                  unit: p?.currentVersion?.unit ?? '',
                  assetUniqueId: a?.uniqueId ?? null,
                  assetTag: a?.tag ?? null,
                  serialNumber: a?.serialNumber ?? null,
                  location: loc ? locationPath(loc, locations) : '—',
                  batchNumber: l.batchNumber,
                  expectedQty: blind ? null : l.expectedQty,
                  countedQty: l.countedQty,
                  variance:
                    blind || l.countedQty == null
                      ? null
                      : l.countedQty - l.expectedQty,
                  unexpected: l.unexpected,
                  countedBy: l.countedByUserId
                    ? (nameBy.get(l.countedByUserId) ?? null)
                    : null,
                  note: l.note,
                };
              })
            : [],
          can: {
            count: canCount && c.status === 'COUNTING',
            submit:
              canCount && c.status === 'COUNTING' && counted === c.lines.length,
            cancel: canManage && c.status === 'COUNTING',
            retry: canManage && c.status === 'APPROVED' && !c.postedAt,
          },
        };
      }),
    );
  }
}
