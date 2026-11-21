import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import type {
  Asset,
  AssetCondition,
  AssetReportType,
  Prisma,
  ResponsibilityDecision,
} from '@db';
import { PrismaService, type DbTx } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DepartmentsService } from '../org/departments.service';
import { LedgerService, type TxnRef } from '../store/ledger.service';
import {
  MAINTENANCE_COMPLETED,
  MaintenanceService,
} from '../store/maintenance.service';
import {
  APPROVAL_COMPLETED,
  WorkflowService,
  type ApprovalCompletedEvent,
} from '../workflow/workflow.service';
import { CUSTODY_EVENTS, HandoverService } from './handover.service';

const RANK: Record<AssetCondition, number> = {
  GOOD: 0,
  FAIR: 1,
  NEEDS_REPAIR: 2,
  UNDER_REPAIR: 3,
  BEYOND_REPAIR: 4,
};
const DAY = 86_400_000;

export interface ReceiveReturnInput {
  storeUniqueId: string;
  returnUniqueId?: string;
  lines: {
    assetUniqueId: string;
    condition: AssetCondition;
    locationUniqueId: string;
    accessoriesReturned?: string[];
    missing?: string;
    photoFileUniqueIds?: string[];
    note?: string;
  }[];
}

/**
 * Custody after handover (B3 §5–§8): returns to any store, fault / damage /
 * loss / theft reports, responsibility decisions, condition inspections,
 * custody transfers between employees, and the custody views.
 */
@Injectable()
export class CustodyService implements OnModuleInit {
  private readonly logger = new Logger(CustodyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly departments: DepartmentsService,
    private readonly ledger: LedgerService,
    private readonly maintenance: MaintenanceService,
    private readonly workflow: WorkflowService,
    private readonly handovers: HandoverService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit() {
    // SOD_LOSS_SELF_APPROVE: the custodian never decides about their own item.
    for (const point of [
      'asset_loss.approval',
      'asset_responsibility.approval',
    ]) {
      this.workflow.registerGuard(point, async (actor, request) => {
        const r = await this.prisma.db.assetReport.findUnique({
          where: { uniqueId: request.subjectId },
        });
        await this.policy.enforceSod(
          'SOD_LOSS_SELF_APPROVE',
          !!r && r.custodianEmployeeId === actor.employeeId,
        );
      });
    }
  }

  private subjectFor(a: Asset) {
    return {
      departmentId: a.owningDepartmentId,
      storeId: a.storeId,
      subjectEmployeeId: a.custodianEmployeeId,
    };
  }

  private async userOf(employeeId: number) {
    return this.prisma.db.user.findFirst({
      where: { employeeId, status: 'ACTIVE' },
    });
  }

  private async withComponents(tx: DbTx, a: Asset) {
    const comps = a.isKit
      ? await tx.asset.findMany({
          where: {
            parentAssetId: a.id,
            custodianEmployeeId: a.custodianEmployeeId,
          },
        })
      : [];
    return [a, ...comps];
  }

  /** May the user act on custody of this asset (custodian, their HOD, the store)? */
  private async canAct(
    user: CurrentUser,
    a: Asset,
    perm: 'return.request' | 'asset_report.create' | 'custody.recall',
  ) {
    if (a.custodianEmployeeId && a.custodianEmployeeId === user.employeeId) {
      return this.access.can(user, perm, {
        subjectEmployeeId: a.custodianEmployeeId,
      });
    }
    const custodian = a.custodianEmployeeId
      ? await this.prisma.db.employee.findUnique({
          where: { id: a.custodianEmployeeId },
        })
      : null;
    return (
      (custodian &&
        (await this.access.can(user, perm, {
          departmentId: custodian.departmentId,
        }))) ||
      (await this.access.can(user, perm, {
        departmentId: a.owningDepartmentId,
      })) ||
      (await this.access.can(user, perm, { storeId: a.storeId }))
    );
  }

  // ── returns ──────────────────────────────────────────────────────────────

  /** Custodian / HOD asks to return, or store / owning department recalls. */
  async requestReturn(
    actor: CurrentUser,
    input: { assetUniqueIds: string[]; reason: string; recall?: boolean },
  ) {
    const assets = await this.prisma.db.asset.findMany({
      where: { uniqueId: { in: input.assetUniqueIds } },
    });
    if (
      !assets.length ||
      assets.some(
        (a) => a.status !== 'ASSIGNED_TO_EMPLOYEE' && a.status !== 'MISSING',
      )
    ) {
      throw new BadRequestException('errors.return_assets');
    }
    const custodianId = assets[0].custodianEmployeeId!;
    if (assets.some((a) => a.custodianEmployeeId !== custodianId))
      throw new BadRequestException('errors.return_assets');
    for (const a of assets) {
      const ok = await this.canAct(
        actor,
        a,
        input.recall ? 'custody.recall' : 'return.request',
      );
      if (!ok) throw new ForbiddenException('errors.forbidden');
    }
    const r = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.numbering.document('RTA', tx);
      const created = await tx.assetReturn.create({
        data: {
          number,
          custodianEmployeeId: custodianId,
          trigger: input.recall ? 'RECALL' : 'RETURN_REQUEST',
          reason: input.reason?.trim() || null,
          requestedByUserId: actor.id,
          lines: { create: assets.map((a) => ({ assetId: a.id })) },
        },
      });
      await this.audit.log(
        {
          action: input.recall ? 'custody.recall' : 'return.request',
          entityType: 'AssetReturn',
          entityId: number,
          after: { assets: assets.map((a) => a.tag), reason: input.reason },
        },
        tx,
      );
      return created;
    });
    const u = await this.userOf(custodianId);
    if (u && u.id !== actor.id) {
      await this.notifications.notify(u.id, {
        titleKey: input.recall
          ? 'notifications.recall_title'
          : 'notifications.return_requested_title',
        messageKey: 'notifications.return_requested_message',
        params: { number: r.number, items: assets.length },
        link: '/my-items',
      });
    }
    return this.getReturn(actor, r.uniqueId);
  }

  /** Store receives items back (any store), with a condition check per item. */
  async receiveReturn(actor: CurrentUser, input: ReceiveReturnInput) {
    const store = await this.prisma.db.store.findUnique({
      where: { uniqueId: input.storeUniqueId },
    });
    if (!store) throw new NotFoundException('errors.record_not_found');
    await this.access.assert(actor, 'return.receive', { storeId: store.id });
    const assets = await this.prisma.db.asset.findMany({
      where: { uniqueId: { in: input.lines.map((l) => l.assetUniqueId) } },
    });
    const byUid = new Map(assets.map((a) => [a.uniqueId, a]));
    if (!assets.length || assets.length !== input.lines.length)
      throw new BadRequestException('errors.return_assets');
    const custodianId = assets[0].custodianEmployeeId;
    if (
      !custodianId ||
      assets.some(
        (a) =>
          a.custodianEmployeeId !== custodianId ||
          a.status !== 'ASSIGNED_TO_EMPLOYEE',
      )
    ) {
      throw new BadRequestException('errors.return_assets');
    }
    // SOD_RETURN_SELF: a storekeeper never receives their own items.
    await this.policy.enforceSod(
      'SOD_RETURN_SELF',
      actor.employeeId === custodianId,
    );
    const locations = await this.prisma.db.storeLocation.findMany({
      where: { storeId: store.id, kind: 'GENERAL', isActive: true },
    });
    const locBy = new Map(locations.map((l) => [l.uniqueId, l]));
    const files = await this.prisma.db.file.findMany({
      where: {
        uniqueId: {
          in: input.lines.flatMap((l) => l.photoFileUniqueIds ?? []),
        },
      },
    });
    const fileBy = new Map(files.map((f) => [f.uniqueId, f.id]));
    let existing = input.returnUniqueId
      ? await this.prisma.db.assetReturn.findUnique({
          where: { uniqueId: input.returnUniqueId },
          include: { lines: true },
        })
      : await this.prisma.db.assetReturn.findFirst({
          // A return already requested for these items is the one received.
          where: {
            custodianEmployeeId: custodianId,
            status: { in: ['REQUESTED', 'PARTIALLY_RECEIVED'] },
            lines: {
              some: {
                assetId: { in: assets.map((a) => a.id) },
                received: false,
              },
            },
          },
          include: { lines: true },
          orderBy: { createdAt: 'desc' },
        });
    if (
      input.returnUniqueId &&
      (!existing ||
        existing.custodianEmployeeId !== custodianId ||
        ['RECEIVED', 'CANCELLED'].includes(existing.status))
    ) {
      throw new BadRequestException('errors.return_assets');
    }
    const worse: { asset: Asset; from: AssetCondition; to: AssetCondition }[] =
      [];
    const ret = await this.prisma.db.$transaction(
      async (tx) => {
        if (!existing) {
          const number = await this.numbering.document('RTA', tx);
          existing = await tx.assetReturn.create({
            data: {
              number,
              custodianEmployeeId: custodianId,
              trigger: 'RETURN_REQUEST',
              requestedByUserId: actor.id,
              lines: { create: assets.map((a) => ({ assetId: a.id })) },
            },
            include: { lines: true },
          });
        }
        const r = existing;
        for (const [i, l] of input.lines.entries()) {
          const a = byUid.get(l.assetUniqueId)!;
          const loc = locBy.get(l.locationUniqueId);
          if (!loc) throw new BadRequestException('errors.location_not_found');
          const photos = (l.photoFileUniqueIds ?? [])
            .map((u) => fileBy.get(u))
            .filter((x): x is number => !!x);
          if (a.isKit && !photos.length)
            throw new BadRequestException({
              message: 'errors.handover_kit_photo',
              args: { line: i + 1 },
            });
          const ref: TxnRef = {
            type: 'RETURN_TO_STORE',
            userId: actor.id,
            referenceType: 'AssetReturn',
            referenceId: r.number,
            reason: l.note ?? null,
          };
          const handoverLine = await tx.handoverLine.findFirst({
            where: {
              assetId: a.id,
              returnedAt: null,
              handover: {
                custodianEmployeeId: custodianId,
                status: {
                  in: [
                    'ACKNOWLEDGED',
                    'PARTIALLY_RETURNED',
                    'AWAITING_ACKNOWLEDGEMENT',
                    'DISPUTED',
                  ],
                },
              },
            },
            include: { handover: true },
          });
          for (const x of await this.withComponents(tx, a)) {
            await this.ledger.moveAsset(
              tx,
              x,
              {
                status: 'IN_STORE',
                storeId: store.id,
                locationId: loc.id,
                custodianEmployeeId: null,
                ...(x.id === a.id ? { condition: l.condition } : {}),
              },
              ref,
            );
            await tx.custody.updateMany({
              where: { assetId: x.id, toAt: null },
              data: { toAt: new Date(), returnId: r.id, endReason: 'RETURNED' },
            });
          }
          const line = r.lines.find((x) => x.assetId === a.id);
          const data = {
            received: true,
            condition: l.condition,
            accessoriesReturned: l.accessoriesReturned ?? [],
            missing: l.missing?.trim() || null,
            photoFileIds: photos,
            note: l.note?.trim() || null,
          };
          if (line)
            await tx.assetReturnLine.update({ where: { id: line.id }, data });
          else
            await tx.assetReturnLine.create({
              data: { ...data, returnId: r.id, assetId: a.id },
            });
          if (handoverLine) {
            await tx.handoverLine.update({
              where: { id: handoverLine.id },
              data: { returnedAt: new Date(), returnId: r.id },
            });
            const open = await tx.handoverLine.count({
              where: { handoverId: handoverLine.handoverId, returnedAt: null },
            });
            await tx.handover.update({
              where: { id: handoverLine.handoverId },
              data: { status: open ? 'PARTIALLY_RETURNED' : 'CLOSED' },
            });
            if (
              RANK[l.condition] > RANK[handoverLine.condition] ||
              l.missing?.trim()
            ) {
              worse.push({
                asset: a,
                from: handoverLine.condition,
                to: l.condition,
              });
            }
          }
          await this.handovers.clearExitItem(
            tx,
            custodianId,
            a.tag,
            `Returned to ${store.name} (${r.number})`,
            actor.id,
          );
        }
        const pending = await tx.assetReturnLine.count({
          where: { returnId: r.id, received: false },
        });
        await tx.assetReturn.update({
          where: { id: r.id },
          data: {
            status: pending ? 'PARTIALLY_RECEIVED' : 'RECEIVED',
            storeId: store.id,
            receivedByUserId: actor.id,
            receivedAt: new Date(),
          },
        });
        await this.audit.log(
          {
            action: 'return.receive',
            entityType: 'AssetReturn',
            entityId: r.number,
            after: { store: store.code, items: input.lines.length },
          },
          tx,
        );
        return r;
      },
      { timeout: 60_000 },
    );
    // A condition difference creates a damage report automatically (§8.2).
    for (const w of worse) {
      await this.createReport(null, {
        assetUniqueId: w.asset.uniqueId,
        type: 'DAMAGE',
        occurredAt: new Date().toISOString(),
        circumstances: `Returned in ${w.to} condition (handed over ${w.from}) — return ${ret.number}`,
        stillUsable: RANK[w.to] < RANK.NEEDS_REPAIR,
        custodianEmployeeId: custodianId,
        automatic: true,
      }).catch((e) =>
        this.logger.warn(`Automatic damage report for ${w.asset.tag}: ${e}`),
      );
    }
    // Other open return requests for items that are now back are closed.
    const stale = await this.prisma.db.assetReturn.findMany({
      where: {
        custodianEmployeeId: custodianId,
        status: { in: ['REQUESTED', 'PARTIALLY_RECEIVED'] },
        NOT: { id: ret.id },
      },
      include: { lines: true },
    });
    for (const o of stale) {
      const stillHeld = await this.prisma.db.asset.count({
        where: {
          id: { in: o.lines.filter((l) => !l.received).map((l) => l.assetId) },
          custodianEmployeeId: custodianId,
        },
      });
      if (!stillHeld) {
        await this.prisma.db.assetReturn.update({
          where: { id: o.id },
          data: {
            status: 'CANCELLED',
            reason:
              `${o.reason ?? ''} (items received on ${ret.number})`.trim(),
          },
        });
      }
    }
    this.events.emit(CUSTODY_EVENTS.ASSET_RETURNED, { returnId: ret.id });
    return this.getReturn(actor, ret.uniqueId);
  }

  async cancelReturn(actor: CurrentUser, uniqueId: string) {
    const r = await this.prisma.db.assetReturn.findUnique({
      where: { uniqueId },
    });
    if (!r || r.status !== 'REQUESTED')
      throw new BadRequestException('errors.return_status');
    if (
      r.requestedByUserId !== actor.id &&
      !(await this.access.can(actor, 'return.receive'))
    ) {
      throw new ForbiddenException('errors.forbidden');
    }
    await this.prisma.db.assetReturn.update({
      where: { id: r.id },
      data: { status: 'CANCELLED' },
    });
    await this.audit.log({
      action: 'return.cancel',
      entityType: 'AssetReturn',
      entityId: r.number,
    });
    return this.getReturn(actor, uniqueId);
  }

  async listReturns(user: CurrentUser, open = false) {
    const s = await this.access.resolveScope(user, 'custody.view');
    const stores = (await this.access.resolveScope(user, 'return.receive'))
      .storeIds;
    const seeAll = s.all || stores.length > 0;
    const or: Prisma.AssetReturnWhereInput[] = [];
    if (user.employeeId) or.push({ custodianEmployeeId: user.employeeId });
    if (s.departmentIds.length) {
      const emps = await this.prisma.db.employee.findMany({
        where: { departmentId: { in: s.departmentIds } },
        select: { id: true },
      });
      or.push({ custodianEmployeeId: { in: emps.map((e) => e.id) } });
    }
    const rows = await this.prisma.db.assetReturn.findMany({
      where: {
        AND: [
          seeAll ? {} : { OR: or },
          open ? { status: { in: ['REQUESTED', 'PARTIALLY_RECEIVED'] } } : {},
        ],
      },
      include: { lines: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.presentReturns(rows);
  }

  async getReturn(user: CurrentUser, uniqueId: string) {
    const all = await this.listReturns(user);
    const r = all.find((x) => x.uniqueId === uniqueId);
    if (!r) throw new NotFoundException('errors.record_not_found');
    return r;
  }

  private async presentReturns(
    rows: Prisma.AssetReturnGetPayload<{ include: { lines: true } }>[],
  ) {
    const [emps, stores, assets, users] = await Promise.all([
      this.prisma.db.employee.findMany({
        where: { id: { in: rows.map((r) => r.custodianEmployeeId) } },
      }),
      this.prisma.db.store.findMany({
        where: {
          id: {
            in: rows.map((r) => r.storeId).filter((x): x is number => !!x),
          },
        },
      }),
      this.prisma.db.asset.findMany({
        where: {
          id: { in: rows.flatMap((r) => r.lines.map((l) => l.assetId)) },
        },
        include: { version: true },
      }),
      this.prisma.dbRaw.user.findMany({
        where: {
          id: {
            in: rows
              .flatMap((r) => [r.requestedByUserId, r.receivedByUserId])
              .filter((x): x is number => !!x),
          },
        },
        include: { employee: true },
      }),
    ]);
    const by = <T extends { id: number }>(l: T[]) =>
      new Map(l.map((x) => [x.id, x]));
    const [eB, sB, aB, uB] = [by(emps), by(stores), by(assets), by(users)];
    const name = (id: number | null) => {
      const u = id ? uB.get(id) : undefined;
      return u ? `${u.employee.firstName} ${u.employee.lastName}` : null;
    };
    return rows.map((r) => {
      const e = eB.get(r.custodianEmployeeId)!;
      const s = r.storeId ? sB.get(r.storeId) : undefined;
      return {
        uniqueId: r.uniqueId,
        number: r.number,
        status: r.status,
        trigger: r.trigger,
        reason: r.reason,
        custodian: {
          uniqueId: e.uniqueId,
          employeeNumber: e.employeeNumber,
          fullName: `${e.firstName} ${e.lastName}`,
          companyEmail: e.companyEmail,
        },
        store: s ? { uniqueId: s.uniqueId, code: s.code, name: s.name } : null,
        requestedBy: name(r.requestedByUserId),
        receivedBy: name(r.receivedByUserId),
        createdAt: r.createdAt,
        receivedAt: r.receivedAt,
        lines: r.lines.map((l) => {
          const a = aB.get(l.assetId)!;
          return {
            assetUniqueId: a.uniqueId,
            tag: a.tag,
            productName: a.version.name,
            isKit: a.isKit,
            received: l.received,
            condition: l.condition,
            accessoriesReturned: l.accessoriesReturned,
            missing: l.missing,
            note: l.note,
          };
        }),
      };
    });
  }

  // ── reports: fault, damage, loss, theft ──────────────────────────────────

  async createReport(
    actor: CurrentUser | null,
    input: {
      assetUniqueId: string;
      type: AssetReportType;
      occurredAt: string;
      circumstances: string;
      stillUsable: boolean;
      fileUniqueIds?: string[];
      custodianEmployeeId?: number;
      automatic?: boolean;
    },
  ) {
    const a = await this.prisma.db.asset.findUnique({
      where: { uniqueId: input.assetUniqueId },
      include: { version: true },
    });
    if (!a) throw new NotFoundException('errors.record_not_found');
    if (actor && !(await this.canAct(actor, a, 'asset_report.create')))
      throw new ForbiddenException('errors.forbidden');
    if (['DISPOSED', 'LOST', 'PENDING_DISPOSAL'].includes(a.status))
      throw new BadRequestException('errors.asset_status_change');
    const loss = input.type === 'LOSS' || input.type === 'THEFT';
    if (
      loss &&
      a.status !== 'ASSIGNED_TO_EMPLOYEE' &&
      a.status !== 'IN_STORE'
    ) {
      throw new BadRequestException('errors.asset_status_change');
    }
    const files = input.fileUniqueIds?.length
      ? await this.prisma.db.file.findMany({
          where: { uniqueId: { in: input.fileUniqueIds } },
        })
      : [];
    const custodianId = input.custodianEmployeeId ?? a.custodianEmployeeId;
    let ticketId: number | null = null;
    const report = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.numbering.document('RPT', tx);
      const r = await tx.assetReport.create({
        data: {
          number,
          type: input.type,
          assetId: a.id,
          custodianEmployeeId: custodianId,
          occurredAt: new Date(input.occurredAt),
          circumstances: input.circumstances.trim(),
          stillUsable: input.stillUsable,
          fileIds: files.map((f) => f.id),
          reportedByUserId: actor?.id ?? null,
          automatic: input.automatic ?? false,
        },
      });
      if (loss) {
        const ref: TxnRef = {
          type: 'ADJUSTMENT',
          userId: actor?.id ?? null,
          referenceType: 'AssetReport',
          referenceId: number,
          reason: `${input.type}: ${input.circumstances}`,
        };
        for (const x of await this.withComponents(tx, a)) {
          await this.ledger.moveAsset(
            tx,
            x,
            { status: 'MISSING', locationId: null },
            ref,
          );
        }
        const req = await this.workflow.start(
          {
            pointCode: 'asset_loss.approval',
            subjectType: 'AssetReport',
            subjectId: r.uniqueId,
            subjectDepartmentId: a.owningDepartmentId,
            title: `${input.type === 'THEFT' ? 'Theft' : 'Loss'} report ${number}: ${a.tag} ${a.version.name}`,
            requesterUserId: actor?.id ?? null,
            context: { type: input.type },
          },
          tx,
        );
        await tx.assetReport.update({
          where: { id: r.id },
          data: { status: 'IN_APPROVAL', lossApprovalRequestId: req.id },
        });
      } else if (!input.stillUsable && RANK[a.condition] < RANK.NEEDS_REPAIR) {
        await this.ledger.moveAsset(
          tx,
          a,
          { condition: 'NEEDS_REPAIR' },
          {
            type: 'ADJUSTMENT',
            userId: actor?.id ?? null,
            referenceType: 'AssetReport',
            referenceId: number,
            reason: 'Reported not usable',
          },
        );
      }
      await this.audit.log(
        {
          action: 'asset_report.create',
          entityType: 'AssetReport',
          entityId: number,
          after: {
            asset: a.tag,
            type: input.type,
            automatic: input.automatic ?? false,
          },
        },
        tx,
      );
      return r;
    });
    // Fault / damage → maintenance ticket in the store (§6.2).
    if (!loss) {
      const open = await this.prisma.db.maintenanceTicket.findFirst({
        where: { assetId: a.id, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      });
      if (open) ticketId = open.id;
      else {
        await this.maintenance.open(null, {
          assetUniqueId: a.uniqueId,
          source: input.automatic ? 'TRANSFER_RECEIPT' : 'FAULT_REPORT',
          description: `${input.type} report ${report.number}: ${input.circumstances}`,
        });
        ticketId =
          (
            await this.prisma.db.maintenanceTicket.findFirst({
              where: { assetId: a.id },
              orderBy: { id: 'desc' },
            })
          )?.id ?? null;
      }
      await this.prisma.db.assetReport.update({
        where: { id: report.id },
        data: { maintenanceTicketId: ticketId },
      });
    }
    return actor ? this.getReport(actor, report.uniqueId) : null;
  }

  /** Responsibility decision (§6.5): decision and reason only, no amounts. */
  async proposeResponsibility(
    actor: CurrentUser,
    uniqueId: string,
    decision: ResponsibilityDecision,
    reason: string,
  ) {
    const r = await this.prisma.db.assetReport.findUnique({
      where: { uniqueId },
    });
    if (!r) throw new NotFoundException('errors.record_not_found');
    if (r.type === 'FAULT')
      throw new BadRequestException('errors.report_responsibility_fault');
    if (
      r.responsibilityStatus === 'PENDING' ||
      r.responsibilityStatus === 'APPROVED'
    )
      throw new BadRequestException('errors.report_status');
    const a = await this.prisma.db.asset.findUniqueOrThrow({
      where: { id: r.assetId },
      include: { version: true },
    });
    const custodian = r.custodianEmployeeId
      ? await this.prisma.db.employee.findUnique({
          where: { id: r.custodianEmployeeId },
        })
      : null;
    const ok =
      (await this.access.can(actor, 'asset_report.create', {
        departmentId: a.owningDepartmentId,
      })) ||
      (custodian &&
        (await this.access.can(actor, 'asset_report.create', {
          departmentId: custodian.departmentId,
        })));
    if (!ok || actor.employeeId === r.custodianEmployeeId)
      throw new ForbiddenException('errors.forbidden');
    if (!reason?.trim())
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      const req = await this.workflow.start(
        {
          pointCode: 'asset_responsibility.approval',
          subjectType: 'AssetReport',
          subjectId: r.uniqueId,
          subjectDepartmentId: a.owningDepartmentId,
          title: `Responsibility (${decision.replace('_', ' ').toLowerCase()}) — ${r.number} ${a.tag}`,
          requesterUserId: actor.id,
          context: { decision },
        },
        tx,
      );
      await tx.assetReport.update({
        where: { id: r.id },
        data: {
          responsibility: decision,
          responsibilityReason: reason.trim(),
          responsibilityStatus: 'PENDING',
          responsibilityRequestId: req.id,
        },
      });
      await this.audit.log(
        {
          action: 'asset_report.responsibility',
          entityType: 'AssetReport',
          entityId: r.number,
          after: { decision, reason },
        },
        tx,
      );
    });
    return this.getReport(actor, uniqueId);
  }

  @OnEvent(APPROVAL_COMPLETED, { async: true })
  async onCompleted(e: ApprovalCompletedEvent) {
    if (
      e.subjectType === 'AssetReport' &&
      e.pointCode === 'asset_loss.approval'
    ) {
      const r = await this.prisma.db.assetReport.findUnique({
        where: { uniqueId: e.subjectId },
      });
      if (!r || r.status !== 'IN_APPROVAL') return;
      const a = await this.prisma.db.asset.findUniqueOrThrow({
        where: { id: r.assetId },
      });
      await this.prisma.db.$transaction(async (tx) => {
        const ref: TxnRef = {
          type: 'ADJUSTMENT',
          userId: e.deciderUserId ?? null,
          referenceType: 'AssetReport',
          referenceId: r.number,
        };
        if (e.status === 'APPROVED') {
          for (const x of await this.withComponents(tx, a)) {
            await this.ledger.moveAsset(
              tx,
              x,
              { status: 'LOST', custodianEmployeeId: null },
              { ...ref, reason: 'Loss confirmed' },
            );
            await tx.custody.updateMany({
              where: { assetId: x.id, toAt: null },
              data: { toAt: new Date(), endReason: 'LOST' },
            });
            await tx.handoverLine.updateMany({
              where: { assetId: x.id, returnedAt: null },
              data: { returnedAt: new Date() },
            });
          }
          await tx.assetReport.update({
            where: { id: r.id },
            data: { status: 'CONFIRMED' },
          });
        } else {
          // Not confirmed: back with the custodian (or the store).
          const back = r.custodianEmployeeId
            ? 'ASSIGNED_TO_EMPLOYEE'
            : 'IN_STORE';
          for (const x of await this.withComponents(tx, a)) {
            if (x.status === 'MISSING')
              await this.ledger.moveAsset(
                tx,
                x,
                { status: back },
                { ...ref, reason: `Loss report ${e.status.toLowerCase()}` },
              );
          }
          await tx.assetReport.update({
            where: { id: r.id },
            data: { status: 'REJECTED' },
          });
        }
      });
      await this.maybeClose(r.uniqueId, e.deciderUserId ?? null);
    } else if (
      e.subjectType === 'AssetReport' &&
      e.pointCode === 'asset_responsibility.approval'
    ) {
      const r = await this.prisma.db.assetReport.findUnique({
        where: { uniqueId: e.subjectId },
      });
      if (!r || r.responsibilityStatus !== 'PENDING') return;
      await this.prisma.db.assetReport.update({
        where: { id: r.id },
        data: {
          responsibilityStatus:
            e.status === 'APPROVED' ? 'APPROVED' : 'REJECTED',
        },
      });
      await this.maybeClose(r.uniqueId, e.deciderUserId ?? null);
    } else if (
      e.subjectType === 'CustodyTransfer' &&
      e.pointCode === 'custody_transfer.approval'
    ) {
      await this.onTransferDecided(e);
    }
  }

  /** Repair finished: fault reports close; damage reports close once responsibility is approved. */
  @OnEvent(MAINTENANCE_COMPLETED, { async: true })
  async onRepaired(e: { ticketId: number }) {
    const reports = await this.prisma.db.assetReport.findMany({
      where: { maintenanceTicketId: e.ticketId, status: 'OPEN' },
    });
    for (const r of reports) {
      if (r.type === 'FAULT') {
        await this.prisma.db.assetReport.update({
          where: { id: r.id },
          data: { status: 'CLOSED' },
        });
      } else {
        await this.maybeClose(r.uniqueId, null);
      }
    }
  }

  /**
   * Loss confirmed (or damage repaired) + responsibility approved → report
   * closed; exit-clearance item cleared.
   */
  private async maybeClose(uniqueId: string, userId: number | null) {
    const r = await this.prisma.db.assetReport.findUniqueOrThrow({
      where: { uniqueId },
    });
    if (r.responsibilityStatus !== 'APPROVED') return;
    if (r.type === 'DAMAGE') {
      const ticket = r.maintenanceTicketId
        ? await this.prisma.db.maintenanceTicket.findUnique({
            where: { id: r.maintenanceTicketId },
          })
        : null;
      if (ticket && ticket.status !== 'COMPLETED') return;
    } else if (r.status !== 'CONFIRMED') {
      return;
    }
    const a = await this.prisma.db.asset.findUniqueOrThrow({
      where: { id: r.assetId },
    });
    await this.prisma.db.$transaction(async (tx) => {
      await tx.assetReport.update({
        where: { id: r.id },
        data: { status: 'CLOSED' },
      });
      if (r.custodianEmployeeId) {
        await this.handovers.clearExitItem(
          tx,
          r.custodianEmployeeId,
          a.tag,
          `${r.type} report ${r.number} approved; responsibility: ${r.responsibility}`,
          userId,
        );
      }
    });
  }

  async listReports(user: CurrentUser, assetUniqueId?: string) {
    const s = await this.access.resolveScope(user, 'custody.view');
    const stores = [
      ...(await this.access.resolveScope(user, 'asset_report.create')).storeIds,
    ];
    const or: Prisma.AssetReportWhereInput[] = [];
    if (user.employeeId) or.push({ custodianEmployeeId: user.employeeId });
    if (s.departmentIds.length) {
      const emps = await this.prisma.db.employee.findMany({
        where: { departmentId: { in: s.departmentIds } },
        select: { id: true },
      });
      const owned = await this.prisma.db.asset.findMany({
        where: { owningDepartmentId: { in: s.departmentIds } },
        select: { id: true },
      });
      or.push(
        { custodianEmployeeId: { in: emps.map((e) => e.id) } },
        { assetId: { in: owned.map((a) => a.id) } },
      );
    }
    if (stores.length) {
      const inStore = await this.prisma.db.asset.findMany({
        where: { storeId: { in: stores } },
        select: { id: true },
      });
      or.push({ assetId: { in: inStore.map((a) => a.id) } });
    }
    const tasks = await this.prisma.db.approvalAssignment.findMany({
      where: { userId: user.id },
      select: { requestId: true },
    });
    if (tasks.length) {
      or.push(
        { lossApprovalRequestId: { in: tasks.map((t) => t.requestId) } },
        { responsibilityRequestId: { in: tasks.map((t) => t.requestId) } },
      );
    }
    if (!or.length && !s.all) throw new ForbiddenException('errors.forbidden');
    const asset = assetUniqueId
      ? await this.prisma.db.asset.findUnique({
          where: { uniqueId: assetUniqueId },
        })
      : null;
    const rows = await this.prisma.db.assetReport.findMany({
      where: {
        AND: [s.all ? {} : { OR: or }, asset ? { assetId: asset.id } : {}],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.presentReports(user, rows);
  }

  async getReport(user: CurrentUser, uniqueId: string) {
    const r = (await this.listReports(user)).find(
      (x) => x.uniqueId === uniqueId,
    );
    if (!r) throw new NotFoundException('errors.record_not_found');
    return r;
  }

  private async presentReports(
    user: CurrentUser,
    rows: Prisma.AssetReportGetPayload<object>[],
  ) {
    const [assets, emps, reqs, tickets, users] = await Promise.all([
      this.prisma.db.asset.findMany({
        where: { id: { in: rows.map((r) => r.assetId) } },
        include: { version: true },
      }),
      this.prisma.db.employee.findMany({
        where: {
          id: {
            in: rows
              .map((r) => r.custodianEmployeeId)
              .filter((x): x is number => !!x),
          },
        },
      }),
      this.prisma.db.approvalRequest.findMany({
        where: {
          id: {
            in: rows
              .flatMap((r) => [
                r.lossApprovalRequestId,
                r.responsibilityRequestId,
              ])
              .filter((x): x is number => !!x),
          },
        },
        select: { id: true, uniqueId: true },
      }),
      this.prisma.db.maintenanceTicket.findMany({
        where: {
          id: {
            in: rows
              .map((r) => r.maintenanceTicketId)
              .filter((x): x is number => !!x),
          },
        },
      }),
      this.prisma.dbRaw.user.findMany({
        where: {
          id: {
            in: rows
              .map((r) => r.reportedByUserId)
              .filter((x): x is number => !!x),
          },
        },
        include: { employee: true },
      }),
    ]);
    const by = <T extends { id: number }>(l: T[]) =>
      new Map(l.map((x) => [x.id, x]));
    const [aB, eB, rB, tB, uB] = [
      by(assets),
      by(emps),
      by(reqs),
      by(tickets),
      by(users),
    ];
    return Promise.all(
      rows.map(async (r) => {
        const a = aB.get(r.assetId)!;
        const e = r.custodianEmployeeId
          ? eB.get(r.custodianEmployeeId)
          : undefined;
        const u = r.reportedByUserId ? uB.get(r.reportedByUserId) : undefined;
        const canDecide =
          r.type !== 'FAULT' &&
          !['PENDING', 'APPROVED'].includes(r.responsibilityStatus ?? '') &&
          user.employeeId !== r.custodianEmployeeId &&
          ((await this.access.can(user, 'asset_report.create', {
            departmentId: a.owningDepartmentId,
          })) ||
            (!!e &&
              (await this.access.can(user, 'asset_report.create', {
                departmentId: e.departmentId,
              }))));
        return {
          uniqueId: r.uniqueId,
          number: r.number,
          type: r.type,
          status: r.status,
          asset: {
            uniqueId: a.uniqueId,
            tag: a.tag,
            productName: a.version.name,
            status: a.status,
            condition: a.condition,
          },
          custodian: e
            ? `${e.firstName} ${e.lastName} (${e.employeeNumber})`
            : null,
          occurredAt: r.occurredAt,
          circumstances: r.circumstances,
          stillUsable: r.stillUsable,
          automatic: r.automatic,
          reportedBy: u
            ? `${u.employee.firstName} ${u.employee.lastName}`
            : r.automatic
              ? 'System'
              : null,
          createdAt: r.createdAt,
          maintenanceTicketUniqueId: r.maintenanceTicketId
            ? (tB.get(r.maintenanceTicketId)?.uniqueId ?? null)
            : null,
          lossApprovalUniqueId: r.lossApprovalRequestId
            ? (rB.get(r.lossApprovalRequestId)?.uniqueId ?? null)
            : null,
          responsibility: r.responsibility,
          responsibilityReason: r.responsibilityReason,
          responsibilityStatus: r.responsibilityStatus,
          responsibilityApprovalUniqueId: r.responsibilityRequestId
            ? (rB.get(r.responsibilityRequestId)?.uniqueId ?? null)
            : null,
          canDecideResponsibility: canDecide,
        };
      }),
    );
  }

  // ── inspections ──────────────────────────────────────────────────────────

  async inspect(
    actor: CurrentUser,
    input: {
      assetUniqueId: string;
      condition: AssetCondition;
      remarks?: string;
      checklist?: { item: string; pass: boolean }[];
    },
  ) {
    const a = await this.prisma.db.asset.findUnique({
      where: { uniqueId: input.assetUniqueId },
    });
    if (!a) throw new NotFoundException('errors.record_not_found');
    const ok =
      (await this.access.can(actor, 'asset_inspection.perform', {
        departmentId: a.owningDepartmentId,
      })) ||
      (await this.access.can(actor, 'asset_inspection.perform', {
        storeId: a.storeId,
      }));
    if (!ok) throw new ForbiddenException('errors.forbidden');
    await this.prisma.db.$transaction(async (tx) => {
      await tx.assetInspection.create({
        data: {
          assetId: a.id,
          custodianEmployeeId: a.custodianEmployeeId,
          condition: input.condition,
          remarks: input.remarks?.trim() || null,
          checklist: (input.checklist ?? []) as Prisma.InputJsonValue,
          inspectedByUserId: actor.id,
        },
      });
      if (input.condition !== a.condition) {
        await this.ledger.moveAsset(
          tx,
          a,
          { condition: input.condition },
          {
            type: 'ADJUSTMENT',
            userId: actor.id,
            referenceType: 'AssetInspection',
            referenceId: a.tag,
            reason: `Inspection: ${input.remarks ?? input.condition}`,
          },
        );
      }
      await this.audit.log(
        {
          action: 'asset_inspection.perform',
          entityType: 'Asset',
          entityId: a.tag,
          after: { condition: input.condition, remarks: input.remarks },
        },
        tx,
      );
    });
    if (input.condition === 'BEYOND_REPAIR' && a.custodianEmployeeId) {
      // Beyond repair → proposed for return and disposal (§6.3).
      const u = await this.userOf(a.custodianEmployeeId);
      if (u) {
        await this.notifications.notify(u.id, {
          type: 'WARNING',
          titleKey: 'notifications.beyond_repair_title',
          messageKey: 'notifications.beyond_repair_message',
          params: { tag: a.tag },
          link: '/my-items',
        });
      }
    }
    return { ok: true };
  }

  /** Items in custody whose inspection is due within `days` (or overdue). */
  async inspectionsDue(user: CurrentUser, days = 30) {
    const items = await this.custodyItems(user, {});
    const now = Date.now();
    return items
      .filter(
        (i) =>
          i.nextInspection &&
          new Date(i.nextInspection).getTime() - now <= days * DAY,
      )
      .sort(
        (x, y) =>
          new Date(x.nextInspection!).getTime() -
          new Date(y.nextInspection!).getTime(),
      );
  }

  /** Daily: overdue inspections remind the custodian and their HOD (§6.1). */
  @Cron('30 8 * * *', { timeZone: 'Africa/Dar_es_Salaam' })
  async inspectionReminders() {
    const open = await this.prisma.db.custody.findMany({
      where: { toAt: null },
    });
    for (const c of open) {
      const a = await this.prisma.db.asset.findUnique({
        where: { id: c.assetId },
        include: { version: { include: { category: true } } },
      });
      const months = a?.version.category.inspectionMonths;
      if (!a || !months || a.parentAssetId) continue;
      const last = await this.prisma.db.assetInspection.findFirst({
        where: { assetId: a.id },
        orderBy: { at: 'desc' },
      });
      const due = new Date(last?.at ?? c.fromAt);
      due.setMonth(due.getMonth() + months);
      const overdueDays = Math.floor((Date.now() - due.getTime()) / DAY);
      if (overdueDays < 0 || overdueDays % 7 !== 0) continue;
      const emp = await this.prisma.db.employee.findUniqueOrThrow({
        where: { id: c.custodianEmployeeId },
      });
      const targets = [await this.userOf(emp.id)];
      const headId = await this.departments.resolveHeadEmployeeId(
        emp.departmentId,
      );
      if (headId) targets.push(await this.userOf(headId));
      for (const u of targets) {
        if (!u) continue;
        await this.notifications.notify(u.id, {
          type: 'WARNING',
          titleKey: 'notifications.inspection_overdue_title',
          messageKey: 'notifications.inspection_overdue_message',
          params: { tag: a.tag, name: `${emp.firstName} ${emp.lastName}` },
          link: `/store/assets/${a.uniqueId}`,
        });
      }
    }
  }

  // ── custody transfers between employees ──────────────────────────────────

  async requestTransfer(
    actor: CurrentUser,
    input: {
      assetUniqueIds: string[];
      toEmployeeUniqueId: string;
      reason: string;
    },
  ) {
    const assets = await this.prisma.db.asset.findMany({
      where: { uniqueId: { in: input.assetUniqueIds } },
    });
    const fromId = assets[0]?.custodianEmployeeId;
    if (
      !assets.length ||
      !fromId ||
      assets.some(
        (a) =>
          a.custodianEmployeeId !== fromId ||
          a.status !== 'ASSIGNED_TO_EMPLOYEE',
      )
    ) {
      throw new BadRequestException('errors.return_assets');
    }
    const [from, to] = await Promise.all([
      this.prisma.db.employee.findUniqueOrThrow({ where: { id: fromId } }),
      this.prisma.db.employee.findUnique({
        where: { uniqueId: input.toEmployeeUniqueId },
      }),
    ]);
    if (!to || to.status === 'EXITED' || to.id === from.id)
      throw new BadRequestException('errors.request_beneficiary');
    // Requested by the HOD of either department (within / between departments).
    const ok =
      (await this.access.can(actor, 'custody_transfer.request', {
        departmentId: from.departmentId,
      })) ||
      (await this.access.can(actor, 'custody_transfer.request', {
        departmentId: to.departmentId,
      }));
    if (!ok) throw new ForbiddenException('errors.forbidden');
    if (!input.reason?.trim())
      throw new BadRequestException('errors.reason_required');
    const t = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.numbering.document('CTR', tx);
      const x = await tx.custodyTransfer.create({
        data: {
          number,
          assetIds: assets.map((a) => a.id),
          fromEmployeeId: from.id,
          toEmployeeId: to.id,
          reason: input.reason.trim(),
          requestedByUserId: actor.id,
        },
      });
      const req = await this.workflow.start(
        {
          pointCode: 'custody_transfer.approval',
          subjectType: 'CustodyTransfer',
          subjectId: x.uniqueId,
          subjectDepartmentId: to.departmentId,
          title: `Custody transfer ${number}: ${from.firstName} ${from.lastName} → ${to.firstName} ${to.lastName} (${assets.length} items)`,
          requesterUserId: actor.id,
          context: { items: assets.length },
        },
        tx,
      );
      await tx.custodyTransfer.update({
        where: { id: x.id },
        data: { approvalRequestId: req.id },
      });
      await this.audit.log(
        {
          action: 'custody_transfer.request',
          entityType: 'CustodyTransfer',
          entityId: number,
          after: {
            from: from.employeeNumber,
            to: to.employeeNumber,
            assets: assets.map((a) => a.tag),
          },
        },
        tx,
      );
      return x;
    });
    return this.getTransfer(actor, t.uniqueId);
  }

  /** Approved: through the store — a return from the giver, then a handover to the receiver. */
  private async onTransferDecided(e: ApprovalCompletedEvent) {
    const t = await this.prisma.db.custodyTransfer.findUnique({
      where: { uniqueId: e.subjectId },
    });
    if (!t || t.status !== 'IN_APPROVAL') return;
    if (e.status !== 'APPROVED') {
      await this.prisma.db.custodyTransfer.update({
        where: { id: t.id },
        data: { status: e.status === 'CANCELLED' ? 'CANCELLED' : 'REJECTED' },
      });
      return;
    }
    await this.prisma.db.$transaction(async (tx) => {
      await tx.custodyTransfer.update({
        where: { id: t.id },
        data: { status: 'APPROVED' },
      });
      const number = await this.numbering.document('RTA', tx);
      await tx.assetReturn.create({
        data: {
          number,
          custodianEmployeeId: t.fromEmployeeId,
          trigger: 'TRANSFER',
          reason: `Custody transfer ${t.number}`,
          custodyTransferId: t.id,
          lines: { create: t.assetIds.map((assetId) => ({ assetId })) },
        },
      });
    });
    const u = await this.userOf(t.fromEmployeeId);
    if (u) {
      await this.notifications.notify(u.id, {
        titleKey: 'notifications.return_requested_title',
        messageKey: 'notifications.custody_transfer_return_message',
        params: { number: t.number },
        link: '/my-items',
      });
    }
  }

  async listTransfers(user: CurrentUser) {
    const s = await this.access.resolveScope(user, 'custody.view');
    const seeAll = s.all || (await this.access.can(user, 'handover.prepare'));
    const or: Prisma.CustodyTransferWhereInput[] = [
      { requestedByUserId: user.id },
    ];
    if (user.employeeId)
      or.push(
        { fromEmployeeId: user.employeeId },
        { toEmployeeId: user.employeeId },
      );
    if (s.departmentIds.length) {
      const emps = (
        await this.prisma.db.employee.findMany({
          where: { departmentId: { in: s.departmentIds } },
          select: { id: true },
        })
      ).map((e) => e.id);
      or.push({ fromEmployeeId: { in: emps } }, { toEmployeeId: { in: emps } });
    }
    const tasks = await this.prisma.db.approvalAssignment.findMany({
      where: { userId: user.id },
      select: { requestId: true },
    });
    if (tasks.length)
      or.push({ approvalRequestId: { in: tasks.map((x) => x.requestId) } });
    const rows = await this.prisma.db.custodyTransfer.findMany({
      where: seeAll ? {} : { OR: or },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const [emps, assets, reqs] = await Promise.all([
      this.prisma.db.employee.findMany({
        where: {
          id: { in: rows.flatMap((r) => [r.fromEmployeeId, r.toEmployeeId]) },
        },
      }),
      this.prisma.db.asset.findMany({
        where: { id: { in: rows.flatMap((r) => r.assetIds) } },
        include: { version: true },
      }),
      this.prisma.db.approvalRequest.findMany({
        where: {
          id: {
            in: rows
              .map((r) => r.approvalRequestId)
              .filter((x): x is number => !!x),
          },
        },
        select: { id: true, uniqueId: true },
      }),
    ]);
    const by = <T extends { id: number }>(l: T[]) =>
      new Map(l.map((x) => [x.id, x]));
    const [eB, aB, rB] = [by(emps), by(assets), by(reqs)];
    const person = (id: number) => {
      const e = eB.get(id)!;
      return {
        uniqueId: e.uniqueId,
        employeeNumber: e.employeeNumber,
        fullName: `${e.firstName} ${e.lastName}`,
        companyEmail: e.companyEmail,
      };
    };
    return rows.map((t) => ({
      uniqueId: t.uniqueId,
      number: t.number,
      status: t.status,
      from: person(t.fromEmployeeId),
      to: person(t.toEmployeeId),
      reason: t.reason,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
      approvalRequestUniqueId: t.approvalRequestId
        ? (rB.get(t.approvalRequestId)?.uniqueId ?? null)
        : null,
      assets: t.assetIds.map((id) => {
        const a = aB.get(id)!;
        return {
          uniqueId: a.uniqueId,
          tag: a.tag,
          productName: a.version.name,
          status: a.status,
        };
      }),
    }));
  }

  async getTransfer(user: CurrentUser, uniqueId: string) {
    const t = (await this.listTransfers(user)).find(
      (x) => x.uniqueId === uniqueId,
    );
    if (!t) throw new NotFoundException('errors.record_not_found');
    return t;
  }

  // ── custody views ────────────────────────────────────────────────────────

  /**
   * Items currently in custody, scoped by custody.view: own records (My
   * items), own department (custodian's department), all. Store staff see
   * everything (handover.prepare).
   */
  async custodyItems(
    user: CurrentUser,
    filter: {
      employeeUniqueId?: string;
      mine?: boolean;
      departmentUniqueId?: string;
    },
  ) {
    const s = await this.access.resolveScope(user, 'custody.view');
    const seeAll = s.all || (await this.access.can(user, 'handover.prepare'));
    const or: Prisma.CustodyWhereInput[] = [];
    if (user.employeeId) or.push({ custodianEmployeeId: user.employeeId });
    if (s.departmentIds.length) {
      const emps = await this.prisma.db.employee.findMany({
        where: { departmentId: { in: s.departmentIds } },
        select: { id: true },
      });
      or.push({ custodianEmployeeId: { in: emps.map((e) => e.id) } });
    }
    if (!seeAll && !or.length) throw new ForbiddenException('errors.forbidden');
    const and: Prisma.CustodyWhereInput[] = [
      seeAll ? {} : { OR: or },
      { toAt: null },
    ];
    if (filter.mine) and.push({ custodianEmployeeId: user.employeeId ?? -1 });
    if (filter.employeeUniqueId) {
      const e = await this.prisma.db.employee.findUnique({
        where: { uniqueId: filter.employeeUniqueId },
      });
      and.push({ custodianEmployeeId: e?.id ?? -1 });
    }
    if (filter.departmentUniqueId) {
      const d = await this.prisma.db.department.findUnique({
        where: { uniqueId: filter.departmentUniqueId },
      });
      const emps = d
        ? await this.prisma.db.employee.findMany({
            where: { departmentId: d.id },
            select: { id: true },
          })
        : [];
      and.push({ custodianEmployeeId: { in: emps.map((e) => e.id) } });
    }
    const rows = await this.prisma.db.custody.findMany({
      where: { AND: and },
      orderBy: { fromAt: 'desc' },
      take: 500,
    });
    return this.presentCustody(rows);
  }

  /** Full custody history of an asset or an employee. */
  async custodyHistory(
    user: CurrentUser,
    filter: { assetUniqueId?: string; employeeUniqueId?: string },
  ) {
    const asset = filter.assetUniqueId
      ? await this.prisma.db.asset.findUnique({
          where: { uniqueId: filter.assetUniqueId },
        })
      : null;
    const emp = filter.employeeUniqueId
      ? await this.prisma.db.employee.findUnique({
          where: { uniqueId: filter.employeeUniqueId },
        })
      : null;
    if (!asset && !emp) throw new NotFoundException('errors.record_not_found');
    const s = await this.access.resolveScope(user, 'custody.view');
    const store = await this.access.can(user, 'handover.prepare');
    const assetVisible = asset
      ? (await this.prisma.db.asset.count({ where: { id: asset.id } })) > 0
      : true;
    const allowed =
      s.all ||
      store ||
      (emp && emp.id === user.employeeId) ||
      (emp && s.departmentIds.includes(emp.departmentId)) ||
      (asset && assetVisible && (await this.access.can(user, 'asset.view')));
    if (!allowed) throw new ForbiddenException('errors.forbidden');
    const rows = await this.prisma.db.custody.findMany({
      where: {
        ...(asset ? { assetId: asset.id } : {}),
        ...(emp ? { custodianEmployeeId: emp.id } : {}),
      },
      orderBy: { fromAt: 'desc' },
      take: 500,
    });
    return this.presentCustody(rows);
  }

  private async presentCustody(rows: Prisma.CustodyGetPayload<object>[]) {
    const [assets, emps, handovers] = await Promise.all([
      this.prisma.db.asset.findMany({
        where: { id: { in: rows.map((r) => r.assetId) } },
        include: { version: { include: { category: true } } },
      }),
      this.prisma.db.employee.findMany({
        where: { id: { in: rows.map((r) => r.custodianEmployeeId) } },
        include: { department: true },
      }),
      this.prisma.db.handover.findMany({
        where: { id: { in: rows.map((r) => r.handoverId) } },
        include: { lines: true },
      }),
    ]);
    const inspections = await this.prisma.db.assetInspection.findMany({
      where: { assetId: { in: rows.map((r) => r.assetId) } },
      orderBy: { at: 'desc' },
    });
    const reports = await this.prisma.db.assetReport.findMany({
      where: {
        assetId: { in: rows.map((r) => r.assetId) },
        status: { in: ['OPEN', 'IN_APPROVAL'] },
      },
    });
    const by = <T extends { id: number }>(l: T[]) =>
      new Map(l.map((x) => [x.id, x]));
    const [aB, eB, hB] = [by(assets), by(emps), by(handovers)];
    return rows.map((c) => {
      const a = aB.get(c.assetId)!;
      const e = eB.get(c.custodianEmployeeId)!;
      const h = hB.get(c.handoverId);
      const last = inspections.find((i) => i.assetId === a.id);
      const months = a.version.category.inspectionMonths;
      let next: Date | null = null;
      if (months && !c.toAt && !a.parentAssetId) {
        next = new Date(last?.at ?? c.fromAt);
        next.setMonth(next.getMonth() + months);
      }
      return {
        assetUniqueId: a.uniqueId,
        tag: a.tag,
        productName: a.version.name,
        categoryName: a.version.category.name,
        serialNumber: a.serialNumber,
        status: a.status,
        condition: a.condition,
        isComponent: !!a.parentAssetId,
        custodian: {
          uniqueId: e.uniqueId,
          employeeNumber: e.employeeNumber,
          fullName: `${e.firstName} ${e.lastName}`,
          companyEmail: e.companyEmail,
        },
        departmentName: e.department.name,
        handoverUniqueId: h?.uniqueId ?? null,
        handoverNumber: h?.number ?? null,
        acknowledged: !!h?.acknowledgedAt,
        expectedReturnDate: h?.expectedReturnDate ?? null,
        overdue:
          !!h?.expectedReturnDate &&
          !c.toAt &&
          h.expectedReturnDate.getTime() < Date.now() - DAY,
        from: c.fromAt,
        to: c.toAt,
        endReason: c.endReason,
        lastInspection: last?.at ?? null,
        nextInspection: next,
        openReports: reports.filter((r) => r.assetId === a.id).length,
      };
    });
  }
}
