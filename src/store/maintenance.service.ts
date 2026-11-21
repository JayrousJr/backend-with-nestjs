import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import type {
  Asset,
  AssetCondition,
  MaintenanceSource,
  MaintenanceStatus,
  Prisma,
} from '@db';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService, type TxnRef } from './ledger.service';
import { StoresService } from './stores.service';

/** B2 §13: Store → Module 07. */
export const VEHICLE_DOCUMENT_EXPIRING = 'vehicle.document_expiring';

const SUBJECT = 'MaintenanceTicket';
const CLOSED: MaintenanceStatus[] = ['COMPLETED', 'CANCELLED'];
const OUT_OF_SERVICE = ['IN_STORE', 'DAMAGED'] as const;

const day = 86_400_000;

/**
 * Maintenance (B2 §10): tickets from fault reports, production returns,
 * counts, transfer receipts or scheduled services (vehicle intervals).
 * Internal repair by the owning department or external by a vendor
 * (send-out / back-from-repair). No repair costs (#21); downtime recorded.
 * Assets under maintenance cannot be reserved, issued or transferred.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly ledger: LedgerService,
    private readonly stores: StoresService,
    private readonly events: EventEmitter2,
  ) {}

  private subject(a: Asset) {
    return { departmentId: a.owningDepartmentId, storeId: a.storeId };
  }

  private async load(uniqueId: string) {
    const t = await this.prisma.db.maintenanceTicket.findUnique({
      where: { uniqueId },
    });
    if (!t) throw new NotFoundException('errors.record_not_found');
    const asset = await this.prisma.db.asset.findUniqueOrThrow({
      where: { id: t.assetId },
    });
    return { t, asset };
  }

  private ref(
    number: string,
    userId: number | null,
    type: TxnRef['type'] = 'REPAIR_OUT',
  ): TxnRef {
    return { type, userId, referenceType: SUBJECT, referenceId: number };
  }

  // ── open ─────────────────────────────────────────────────────────────────

  async open(
    actor: CurrentUser | null,
    input: {
      assetUniqueId: string;
      source: MaintenanceSource;
      description: string;
    },
  ) {
    const asset = await this.prisma.db.asset.findUnique({
      where: { uniqueId: input.assetUniqueId },
    });
    if (!asset) throw new NotFoundException('errors.record_not_found');
    if (actor)
      await this.access.assert(
        actor,
        'maintenance.create',
        this.subject(asset),
      );
    if (['DISPOSED', 'LOST', 'PENDING_DISPOSAL'].includes(asset.status)) {
      throw new BadRequestException('errors.maintenance_asset');
    }
    const open = await this.prisma.db.maintenanceTicket.findFirst({
      where: { assetId: asset.id, status: { notIn: CLOSED } },
    });
    if (open) {
      throw new BadRequestException({
        message: 'errors.maintenance_open',
        args: { number: open.number },
      });
    }
    const underWarranty =
      !!asset.warrantyExpiry &&
      asset.warrantyExpiry.getTime() >= Date.now() - day;
    const t = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.numbering.document('MNT', tx);
      const ticket = await tx.maintenanceTicket.create({
        data: {
          number,
          assetId: asset.id,
          source: input.source,
          description: input.description.trim(),
          underWarranty,
          // Warranty: suggest the original vendor.
          vendorName: underWarranty ? asset.vendorRef : null,
          openedByUserId: actor?.id ?? null,
        },
      });
      await this.audit.log(
        {
          action: 'maintenance.create',
          entityType: SUBJECT,
          entityId: number,
          after: { asset: asset.tag, source: input.source, underWarranty },
        },
        tx,
      );
      return ticket;
    });
    if (actor) return this.get(actor, t.uniqueId);
    return null;
  }

  // ── work ─────────────────────────────────────────────────────────────────

  private async assertWorker(actor: CurrentUser, asset: Asset) {
    await this.access.assert(actor, 'maintenance.update', this.subject(asset));
  }

  /** Take the asset out of service for internal repair. */
  async start(actor: CurrentUser, uniqueId: string) {
    const { t, asset } = await this.load(uniqueId);
    await this.assertWorker(actor, asset);
    if (t.status !== 'OPEN')
      throw new BadRequestException('errors.maintenance_status');
    if (!(OUT_OF_SERVICE as readonly string[]).includes(asset.status)) {
      throw new BadRequestException('errors.maintenance_asset');
    }
    await this.prisma.db.$transaction(async (tx) => {
      await this.ledger.moveAsset(
        tx,
        asset,
        { status: 'UNDER_MAINTENANCE' },
        {
          ...this.ref(t.number, actor.id),
          reason: 'Internal repair',
        },
      );
      await tx.maintenanceTicket.update({
        where: { id: t.id },
        data: {
          status: 'IN_REPAIR',
          startedAt: t.startedAt ?? new Date(),
          previousStatus: asset.status,
        },
      });
      await this.audit.log(
        {
          action: 'maintenance.start',
          entityType: SUBJECT,
          entityId: t.number,
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  /** External repair: the asset leaves for the vendor. */
  async sendToVendor(actor: CurrentUser, uniqueId: string, vendorName: string) {
    const { t, asset } = await this.load(uniqueId);
    await this.assertWorker(actor, asset);
    if (t.status !== 'OPEN' && t.status !== 'IN_REPAIR') {
      throw new BadRequestException('errors.maintenance_status');
    }
    const allowed =
      t.status === 'IN_REPAIR' ? ['UNDER_MAINTENANCE'] : [...OUT_OF_SERVICE];
    if (!allowed.includes(asset.status))
      throw new BadRequestException('errors.maintenance_asset');
    if (!vendorName?.trim())
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      await this.ledger.moveAsset(
        tx,
        asset,
        { status: 'AT_VENDOR_FOR_REPAIR', locationId: null },
        {
          ...this.ref(t.number, actor.id),
          reason: `Sent to ${vendorName.trim()}`,
        },
      );
      await tx.maintenanceTicket.update({
        where: { id: t.id },
        data: {
          status: 'AT_VENDOR',
          external: true,
          vendorName: vendorName.trim(),
          sentOutAt: new Date(),
          startedAt: t.startedAt ?? new Date(),
          previousStatus: t.previousStatus ?? asset.status,
        },
      });
      await this.audit.log(
        {
          action: 'maintenance.send_out',
          entityType: SUBJECT,
          entityId: t.number,
          after: { vendorName },
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  /**
   * Close the ticket: back from the vendor or internal repair done. The
   * asset returns to the store with its new condition (beyond repair →
   * propose disposal).
   */
  async complete(
    actor: CurrentUser,
    uniqueId: string,
    input: {
      outcome: string;
      condition: AssetCondition;
      locationUniqueId: string;
    },
  ) {
    const { t, asset } = await this.load(uniqueId);
    await this.assertWorker(actor, asset);
    if (t.status !== 'IN_REPAIR' && t.status !== 'AT_VENDOR') {
      throw new BadRequestException('errors.maintenance_status');
    }
    const loc = await this.prisma.db.storeLocation.findUnique({
      where: { uniqueId: input.locationUniqueId },
    });
    if (!loc || loc.storeId !== asset.storeId || loc.kind !== 'GENERAL') {
      throw new BadRequestException('errors.location_not_found');
    }
    if (!input.outcome?.trim())
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      await this.ledger.moveAsset(
        tx,
        asset,
        { status: 'IN_STORE', locationId: loc.id, condition: input.condition },
        {
          ...this.ref(t.number, actor.id, 'REPAIR_BACK'),
          reason: input.outcome.trim(),
        },
      );
      await tx.maintenanceTicket.update({
        where: { id: t.id },
        data: {
          status: 'COMPLETED',
          backAt: t.status === 'AT_VENDOR' ? new Date() : t.backAt,
          completedAt: new Date(),
          completedByUserId: actor.id,
          outcome: input.outcome.trim(),
          outcomeCondition: input.condition,
        },
      });
      await this.audit.log(
        {
          action: 'maintenance.complete',
          entityType: SUBJECT,
          entityId: t.number,
          after: { condition: input.condition, outcome: input.outcome },
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  async cancel(actor: CurrentUser, uniqueId: string, reason: string) {
    const { t, asset } = await this.load(uniqueId);
    await this.assertWorker(actor, asset);
    if (t.status !== 'OPEN')
      throw new BadRequestException('errors.maintenance_status');
    if (!reason?.trim())
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.$transaction(async (tx) => {
      await tx.maintenanceTicket.update({
        where: { id: t.id },
        data: { status: 'CANCELLED', outcome: reason.trim() },
      });
      await this.audit.log(
        {
          action: 'maintenance.cancel',
          entityType: SUBJECT,
          entityId: t.number,
          after: { reason },
        },
        tx,
      );
    });
    return this.get(actor, uniqueId);
  }

  // ── scheduled ────────────────────────────────────────────────────────────

  /**
   * Daily (07:00 EAT): open scheduled services for vehicles whose service
   * interval has passed, and remind about expiring insurance / road licence
   * (30, 14, 7, 1 and 0 days before, then weekly once expired).
   */
  @Cron('0 7 * * *', { timeZone: 'Africa/Dar_es_Salaam' })
  async daily() {
    const vehicles = await this.prisma.db.asset.findMany({
      where: {
        product: { isVehicle: true },
        status: { notIn: ['DISPOSED', 'LOST'] },
      },
      include: { vehicle: true, version: true },
    });
    const today = new Date();
    let opened = 0;
    let reminded = 0;
    for (const v of vehicles) {
      const months = v.vehicle?.serviceIntervalMonths;
      if (months) {
        const last = await this.prisma.db.maintenanceTicket.findFirst({
          where: { assetId: v.id, source: 'SCHEDULED' },
          orderBy: { createdAt: 'desc' },
        });
        const open = await this.prisma.db.maintenanceTicket.count({
          where: { assetId: v.id, status: { notIn: CLOSED } },
        });
        const base =
          last?.completedAt ?? last?.createdAt ?? v.purchaseDate ?? v.createdAt;
        const due = new Date(base);
        due.setMonth(due.getMonth() + months);
        if (!open && due <= today) {
          await this.open(null, {
            assetUniqueId: v.uniqueId,
            source: 'SCHEDULED',
            description: `Scheduled service (every ${months} months)`,
          }).catch((e) => this.logger.warn(`Scheduled service ${v.tag}: ${e}`));
          opened++;
        }
      }
      for (const [doc, date] of [
        ['insurance', v.vehicle?.insuranceExpiry],
        ['road licence', v.vehicle?.roadLicenceExpiry],
      ] as const) {
        if (!date) continue;
        const days = Math.floor((date.getTime() - today.getTime()) / day);
        const remind =
          [30, 14, 7, 1, 0].includes(days) || (days < 0 && -days % 7 === 0);
        if (!remind) continue;
        reminded++;
        this.events.emit(VEHICLE_DOCUMENT_EXPIRING, {
          assetId: v.id,
          document: doc,
          expiresOn: date,
          days,
        });
        await this.notifyVehicleTeam({
          registration: v.vehicle!.registrationNumber,
          vehicle: v.version.name,
          document: doc,
          days,
        });
      }
    }
    return { opened, reminded };
  }

  private async notifyVehicleTeam(params: {
    registration: string;
    vehicle: string;
    document: string;
    days: number;
  }) {
    const members = await this.prisma.db.userGroupMember.findMany({
      where: {
        group: { code: { in: ['TRANSPORT_OFFICERS', 'STORE_MANAGERS'] } },
        user: { status: 'ACTIVE' },
      },
      select: { userId: true },
    });
    for (const userId of new Set(members.map((m) => m.userId))) {
      await this.notifications.notify(userId, {
        type: 'WARNING',
        titleKey:
          params.days < 0
            ? 'notifications.vehicle_doc_expired_title'
            : 'notifications.vehicle_doc_expiring_title',
        messageKey: 'notifications.vehicle_doc_message',
        params: { ...params, days: Math.abs(params.days) },
        link: '/store/assets?vehicles=yes',
      });
    }
  }

  // ── queries ──────────────────────────────────────────────────────────────

  private async visibleWhere(
    user: CurrentUser,
  ): Promise<Prisma.AssetWhereInput> {
    return this.stores.assetWhere(user);
  }

  async list(
    user: CurrentUser,
    status?: MaintenanceStatus,
    assetUniqueId?: string,
  ) {
    const assetWhere = await this.visibleWhere(user).catch(() => null);
    const createScope = await this.access.resolveScope(
      user,
      'maintenance.create',
    );
    const or: Prisma.AssetWhereInput[] = [];
    if (assetWhere) or.push(assetWhere);
    if (createScope.all) or.push({});
    if (createScope.departmentIds.length)
      or.push({ owningDepartmentId: { in: createScope.departmentIds } });
    if (createScope.storeIds.length)
      or.push({ storeId: { in: createScope.storeIds } });
    if (!or.length) throw new ForbiddenException('errors.forbidden');
    const assets = await this.prisma.db.asset.findMany({
      where: {
        AND: [{ OR: or }, assetUniqueId ? { uniqueId: assetUniqueId } : {}],
      },
      select: { id: true },
    });
    const rows = await this.prisma.db.maintenanceTicket.findMany({
      where: {
        assetId: { in: assets.map((a) => a.id) },
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.present(user, rows);
  }

  async get(user: CurrentUser, uniqueId: string) {
    const { t, asset } = await this.load(uniqueId);
    const can =
      (await this.access.can(
        user,
        'maintenance.create',
        this.subject(asset),
      )) ||
      (await this.access.can(
        user,
        'maintenance.update',
        this.subject(asset),
      )) ||
      (await this.prisma.db.asset
        .count({
          where: { AND: [{ id: asset.id }, await this.visibleWhere(user)] },
        })
        .catch(() => 0)) > 0;
    if (!can) throw new ForbiddenException('errors.forbidden');
    return (await this.present(user, [t]))[0];
  }

  private async present(
    user: CurrentUser,
    rows: Prisma.MaintenanceTicketGetPayload<object>[],
  ) {
    const assets = await this.prisma.db.asset.findMany({
      where: { id: { in: rows.map((r) => r.assetId) } },
      include: { version: true, store: true },
    });
    const aBy = new Map(assets.map((a) => [a.id, a]));
    const userIds = rows
      .flatMap((r) => [r.openedByUserId, r.completedByUserId])
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
    return Promise.all(
      rows.map(async (t) => {
        const a = aBy.get(t.assetId)!;
        const update = await this.access.can(
          user,
          'maintenance.update',
          this.subject(a),
        );
        const end = t.completedAt ?? new Date();
        return {
          uniqueId: t.uniqueId,
          number: t.number,
          status: t.status,
          source: t.source,
          description: t.description,
          external: t.external,
          vendorName: t.vendorName,
          underWarranty: t.underWarranty,
          openedBy: t.openedByUserId
            ? (nameBy.get(t.openedByUserId) ?? '—')
            : 'System',
          createdAt: t.createdAt,
          startedAt: t.startedAt,
          sentOutAt: t.sentOutAt,
          backAt: t.backAt,
          completedAt: t.completedAt,
          completedBy: t.completedByUserId
            ? (nameBy.get(t.completedByUserId) ?? null)
            : null,
          outcome: t.outcome,
          outcomeCondition: t.outcomeCondition,
          downtimeHours: t.startedAt
            ? Math.round((end.getTime() - t.startedAt.getTime()) / 3600_000)
            : null,
          asset: {
            uniqueId: a.uniqueId,
            tag: a.tag,
            productName: a.version.name,
            status: a.status,
            condition: a.condition,
            storeUniqueId: a.store?.uniqueId ?? null,
            storeName: a.store?.name ?? null,
          },
          can: {
            start:
              update &&
              t.status === 'OPEN' &&
              (OUT_OF_SERVICE as readonly string[]).includes(a.status),
            sendOut:
              update && (t.status === 'OPEN' || t.status === 'IN_REPAIR'),
            complete:
              update && (t.status === 'IN_REPAIR' || t.status === 'AT_VENDOR'),
            cancel: update && t.status === 'OPEN',
          },
        };
      }),
    );
  }
}
