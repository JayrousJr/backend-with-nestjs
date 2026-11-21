import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma, StockDocType } from '@db';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { LedgerService } from './ledger.service';
import { ReorderService } from './reorder.service';
import { locationPath, StoresService } from './stores.service';
import type { CreateStockDocumentInput } from './transfers.types';

/** Emitted after an issue: { documentId, storeId, beneficiary } (B2 §13 StockIssued). */
export const STOCK_ISSUED = 'stock.issued';

const INCLUDE = {
  lines: { orderBy: { lineNo: 'asc' } },
} as const satisfies Prisma.StockDocumentInclude;
type Row = Prisma.StockDocumentGetPayload<{ include: typeof INCLUDE }>;

/**
 * Issue vouchers and return notes for quantity products (B2 §4). The issue
 * records its beneficiary (department / employee / production) for
 * traceability; no money is involved (#21).
 */
@Injectable()
export class IssuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly ledger: LedgerService,
    private readonly stores: StoresService,
    private readonly reorder: ReorderService,
    private readonly events: EventEmitter2,
  ) {}

  async create(actor: CurrentUser, input: CreateStockDocumentInput) {
    const store = await this.stores.byUniqueId(input.storeUniqueId);
    await this.access.assert(
      actor,
      input.type === 'ISSUE' ? 'stock.issue' : 'stock.return',
      { storeId: store.id },
    );

    let departmentId: number | null = null;
    let employeeId: number | null = null;
    let label = '';
    if (input.beneficiaryType === 'DEPARTMENT' && input.departmentUniqueId) {
      const d = await this.prisma.db.department.findUnique({
        where: { uniqueId: input.departmentUniqueId },
      });
      departmentId = d?.id ?? null;
      label = d?.name ?? '';
    } else if (input.beneficiaryType === 'EMPLOYEE' && input.employeeUniqueId) {
      const e = await this.prisma.db.employee.findUnique({
        where: { uniqueId: input.employeeUniqueId },
      });
      employeeId = e?.id ?? null;
      departmentId = e?.departmentId ?? null;
      label = e ? `${e.employeeNumber} ${e.firstName} ${e.lastName}` : '';
    } else if (
      input.beneficiaryType === 'PRODUCTION' &&
      input.productionRef?.trim()
    ) {
      label = input.productionRef.trim();
    }
    if (!label) throw new BadRequestException('errors.issue_beneficiary');

    const products = await this.prisma.db.product.findMany({
      where: { uniqueId: { in: input.lines.map((l) => l.productUniqueId) } },
    });
    const locations = await this.prisma.db.storeLocation.findMany({
      where: { storeId: store.id, kind: 'GENERAL', isActive: true },
    });
    const pBy = new Map(products.map((p) => [p.uniqueId, p]));
    const lBy = new Map(locations.map((l) => [l.uniqueId, l]));
    const lines = input.lines.map((l, i) => {
      const p = pBy.get(l.productUniqueId);
      const loc = lBy.get(l.locationUniqueId);
      if (
        !p ||
        !p.trackingType ||
        p.trackingType === 'SERIALISED' ||
        !loc ||
        l.quantity < 1 ||
        (p.trackingType === 'BATCH' && !l.batchNumber)
      ) {
        throw new BadRequestException({
          message: 'errors.issue_line',
          args: { line: i + 1 },
        });
      }
      return {
        lineNo: i + 1,
        productId: p.id,
        locationId: loc.id,
        batchNumber: l.batchNumber || null,
        quantity: l.quantity,
      };
    });

    const beneficiary = {
      type: input.beneficiaryType,
      departmentId,
      employeeId,
      productionRef: input.productionRef ?? null,
      label,
    };
    const doc = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.numbering.document(
        input.type === 'ISSUE' ? 'ISS' : 'RTN',
        tx,
      );
      const d = await tx.stockDocument.create({
        data: {
          number,
          type: input.type,
          storeId: store.id,
          beneficiaryType: input.beneficiaryType,
          departmentId,
          employeeId,
          productionRef: input.productionRef?.trim() || null,
          reference: input.reference?.trim() || null,
          note: input.note?.trim() || null,
          userId: actor.id,
          lines: { create: lines },
        },
      });
      for (const l of lines) {
        await this.ledger.moveQuantity(
          tx,
          {
            storeId: store.id,
            locationId: l.locationId,
            productId: l.productId,
            batchNumber: l.batchNumber,
          },
          input.type === 'ISSUE' ? -l.quantity : l.quantity,
          {
            type: input.type === 'ISSUE' ? 'ISSUE' : 'RETURN_TO_STORE',
            userId: actor.id,
            referenceType: 'StockDocument',
            referenceId: number,
            reason: input.note?.trim() || null,
            beneficiary,
          },
        );
      }
      await this.audit.log(
        {
          action: input.type === 'ISSUE' ? 'stock.issue' : 'stock.return',
          entityType: 'StockDocument',
          entityId: number,
          after: { store: store.code, beneficiary: label, lines: lines.length },
        },
        tx,
      );
      return d;
    });
    if (input.type === 'ISSUE') {
      this.events.emit(STOCK_ISSUED, {
        documentId: doc.id,
        storeId: store.id,
        beneficiary,
      });
    }
    await this.reorder.check(
      lines.map((l) => ({ storeId: store.id, productId: l.productId })),
    );
    return this.get(actor, doc.uniqueId);
  }

  private async visibleWhere(
    user: CurrentUser,
  ): Promise<Prisma.StockDocumentWhereInput> {
    const scope = await this.stores.stockScope(user);
    if (scope.all) return {};
    const or: Prisma.StockDocumentWhereInput[] = [{ userId: user.id }];
    if (scope.storeIds.length) or.push({ storeId: { in: scope.storeIds } });
    if (scope.departmentIds.length)
      or.push({ departmentId: { in: scope.departmentIds } });
    return { OR: or };
  }

  async list(user: CurrentUser, storeUniqueId?: string, type?: StockDocType) {
    const store = storeUniqueId
      ? await this.stores.byUniqueId(storeUniqueId)
      : null;
    const rows = await this.prisma.db.stockDocument.findMany({
      where: {
        AND: [
          await this.visibleWhere(user),
          store ? { storeId: store.id } : {},
          type ? { type } : {},
        ],
      },
      include: INCLUDE,
      orderBy: { at: 'desc' },
      take: 200,
    });
    return this.present(rows);
  }

  async get(user: CurrentUser, uniqueId: string) {
    const d = await this.prisma.db.stockDocument.findUnique({
      where: { uniqueId },
      include: INCLUDE,
    });
    if (!d) throw new NotFoundException('errors.record_not_found');
    const n = await this.prisma.db.stockDocument.count({
      where: { AND: [{ id: d.id }, await this.visibleWhere(user)] },
    });
    if (!n) throw new ForbiddenException('errors.forbidden');
    return (await this.present([d]))[0];
  }

  private async present(rows: Row[]) {
    const ids = <T>(f: (r: Row) => T | null) => [
      ...new Set(rows.map(f).filter((x): x is T => x != null)),
    ];
    const [stores, users, departments, employees, products, locations] =
      await Promise.all([
        this.prisma.db.store.findMany({
          where: { id: { in: ids((r) => r.storeId) } },
        }),
        this.prisma.dbRaw.user.findMany({
          where: { id: { in: ids((r) => r.userId) } },
          include: { employee: true },
        }),
        this.prisma.db.department.findMany({
          where: { id: { in: ids((r) => r.departmentId) } },
        }),
        this.prisma.db.employee.findMany({
          where: { id: { in: ids((r) => r.employeeId) } },
        }),
        this.prisma.db.product.findMany({
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
        }),
        this.prisma.db.storeLocation.findMany({
          where: { storeId: { in: ids((r) => r.storeId) } },
        }),
      ]);
    const by = <T extends { id: number }>(l: T[]) =>
      new Map(l.map((x) => [x.id, x]));
    const [sB, uB, dB, eB, pB, lB] = [
      by(stores),
      by(users),
      by(departments),
      by(employees),
      by(products),
      by(locations),
    ];
    return rows.map((r) => {
      const s = sB.get(r.storeId)!;
      const u = uB.get(r.userId);
      const e = r.employeeId ? eB.get(r.employeeId) : undefined;
      const beneficiary =
        r.beneficiaryType === 'EMPLOYEE' && e
          ? `${e.firstName} ${e.lastName} (${e.employeeNumber})`
          : r.beneficiaryType === 'DEPARTMENT' && r.departmentId
            ? (dB.get(r.departmentId)?.name ?? '—')
            : (r.productionRef ?? '—');
      return {
        uniqueId: r.uniqueId,
        number: r.number,
        type: r.type,
        store: { uniqueId: s.uniqueId, code: s.code, name: s.name },
        beneficiaryType: r.beneficiaryType,
        beneficiary,
        reference: r.reference,
        note: r.note,
        by: u ? `${u.employee.firstName} ${u.employee.lastName}` : '—',
        at: r.at,
        lines: r.lines.map((l) => {
          const p = pB.get(l.productId);
          const loc = lB.get(l.locationId);
          return {
            lineNo: l.lineNo,
            productUniqueId: p?.uniqueId ?? '',
            productCode: p?.code ?? null,
            productName: p?.currentVersion?.name ?? '—',
            unit: p?.currentVersion?.unit ?? '',
            location: loc ? locationPath(loc, locations) : '—',
            batchNumber: l.batchNumber,
            quantity: l.quantity,
          };
        }),
      };
    });
  }
}
