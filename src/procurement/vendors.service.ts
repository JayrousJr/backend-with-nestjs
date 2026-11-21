import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma, Vendor, VendorStatus } from '@db';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { NumberingService } from '../numbering/numbering.service';
import { PolicyService } from '../policy/policy.service';
import { VendorAuthService } from './vendor-auth.service';

export interface VendorInput {
  name: string;
  tin?: string | null;
  vrn?: string | null;
  address?: string | null;
  phone?: string | null;
  email: string;
  contactPerson?: string | null;
  categoryUniqueIds: string[];
  registeredAt?: string | null;
  note?: string | null;
}

const day = (s?: string | null) =>
  s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null;

/**
 * Vendor registry (tender spec §8). Vendors apply outside the system;
 * Procurement registers them and creates the first portal user (vendor
 * admin). Registration is valid 2 years; expired or suspended vendors can
 * sign in read-only but cannot bid.
 */
@Injectable()
export class VendorsService {
  private readonly logger = new Logger(VendorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly policy: PolicyService,
    private readonly auth: VendorAuthService,
    private readonly mail: MailService,
  ) {}

  /** Can bid today: active and registration not expired. */
  static canBid(v: Pick<Vendor, 'status' | 'validUntil'>) {
    return (
      v.status === 'ACTIVE' &&
      v.validUntil >= new Date(new Date().toDateString())
    );
  }

  private async categoryIds(uniqueIds: string[]) {
    const cats = await this.prisma.db.productCategory.findMany({
      where: { uniqueId: { in: uniqueIds } },
    });
    if (cats.length !== new Set(uniqueIds).size)
      throw new BadRequestException('errors.record_not_found');
    return cats.map((c) => c.id);
  }

  async create(actor: CurrentUser, input: VendorInput) {
    const { years } = await this.policy.params<{ years: number }>(
      'PROC_VENDOR_VALIDITY',
    );
    const registeredAt =
      day(input.registeredAt) ?? day(new Date().toISOString())!;
    const validUntil = new Date(registeredAt);
    validUntil.setUTCFullYear(validUntil.getUTCFullYear() + (years ?? 2));
    const cats = await this.categoryIds(input.categoryUniqueIds);
    const v = await this.prisma.db.$transaction(async (tx) => {
      const v = await tx.vendor.create({
        data: {
          number: await this.numbering.document('VEN', tx),
          name: input.name.trim(),
          tin: input.tin?.trim() || null,
          vrn: input.vrn?.trim() || null,
          address: input.address?.trim() || null,
          phone: input.phone?.trim() || null,
          email: input.email.trim().toLowerCase(),
          contactPerson: input.contactPerson?.trim() || null,
          note: input.note?.trim() || null,
          registeredAt,
          validUntil,
          createdById: actor.id,
          categories: { create: cats.map((categoryId) => ({ categoryId })) },
        },
      });
      await this.audit.log(
        {
          action: 'VENDOR_REGISTERED',
          entityType: 'Vendor',
          entityId: v.uniqueId,
          after: { name: v.name },
        },
        tx,
      );
      return v;
    });
    return this.get(v.uniqueId);
  }

  async update(actor: CurrentUser, uniqueId: string, input: VendorInput) {
    const v = await this.find(uniqueId);
    const cats = await this.categoryIds(input.categoryUniqueIds);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.vendorCategory.deleteMany({ where: { vendorId: v.id } });
      await tx.vendor.update({
        where: { id: v.id },
        data: {
          name: input.name.trim(),
          tin: input.tin?.trim() || null,
          vrn: input.vrn?.trim() || null,
          address: input.address?.trim() || null,
          phone: input.phone?.trim() || null,
          email: input.email.trim().toLowerCase(),
          contactPerson: input.contactPerson?.trim() || null,
          note: input.note?.trim() || null,
          categories: { create: cats.map((categoryId) => ({ categoryId })) },
        },
      });
      await this.audit.log(
        {
          action: 'VENDOR_UPDATED',
          entityType: 'Vendor',
          entityId: v.uniqueId,
          before: { name: v.name },
          after: { name: input.name },
        },
        tx,
      );
    });
    return this.get(uniqueId);
  }

  /** Renew for another validity period from today (or from the old expiry if later). */
  async renew(actor: CurrentUser, uniqueId: string) {
    const v = await this.find(uniqueId);
    const { years } = await this.policy.params<{ years: number }>(
      'PROC_VENDOR_VALIDITY',
    );
    const today = day(new Date().toISOString())!;
    const from = v.validUntil > today ? v.validUntil : today;
    const validUntil = new Date(from);
    validUntil.setUTCFullYear(validUntil.getUTCFullYear() + (years ?? 2));
    await this.prisma.db.vendor.update({
      where: { id: v.id },
      data: { validUntil },
    });
    await this.audit.log({
      action: 'VENDOR_RENEWED',
      entityType: 'Vendor',
      entityId: v.uniqueId,
      before: { validUntil: v.validUntil },
      after: { validUntil },
    });
    return this.get(uniqueId);
  }

  async setStatus(
    actor: CurrentUser,
    uniqueId: string,
    status: VendorStatus,
    reason: string,
  ) {
    const v = await this.find(uniqueId);
    if (status !== 'ACTIVE' && reason.trim().length < 3)
      throw new BadRequestException('errors.reason_required');
    await this.prisma.db.vendor.update({
      where: { id: v.id },
      data: {
        status,
        statusReason: status === 'ACTIVE' ? null : reason.trim(),
      },
    });
    if (status === 'BLACKLISTED') {
      const users = await this.prisma.db.vendorUser.findMany({
        where: { vendorId: v.id },
      });
      await this.prisma.db.vendorSession.updateMany({
        where: {
          vendorUserId: { in: users.map((u) => u.id) },
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    }
    await this.audit.log({
      action: 'VENDOR_STATUS',
      entityType: 'Vendor',
      entityId: v.uniqueId,
      before: { status: v.status },
      after: { status, reason },
    });
    return this.get(uniqueId);
  }

  // ── portal users ────────────────────────────────────────────────────────

  /** Procurement creates the vendor admin; the admin creates the others. */
  async createUser(
    vendorId: number,
    input: { fullName: string; email: string; phone?: string | null },
    isAdmin: boolean,
    by: string,
  ) {
    const email = input.email.trim().toLowerCase();
    if (await this.prisma.db.vendorUser.findUnique({ where: { email } }))
      throw new BadRequestException('errors.email_taken');
    const vendor = await this.prisma.db.vendor.findUniqueOrThrow({
      where: { id: vendorId },
    });
    const u = await this.prisma.db.vendorUser.create({
      data: {
        vendorId,
        fullName: input.fullName.trim(),
        email,
        phone: input.phone?.trim() || null,
        isAdmin,
      },
    });
    await this.audit.log({
      action: 'VENDOR_USER_CREATED',
      entityType: 'VendorUser',
      entityId: u.uniqueId,
      after: { email, isAdmin, vendor: vendor.number, by },
    });
    const devLink = await this.auth.issueActivation(u, vendor.name);
    return { user: this.presentUser(u), devLink };
  }

  async createAdminUser(
    actor: CurrentUser,
    vendorUniqueId: string,
    input: { fullName: string; email: string; phone?: string | null },
  ) {
    const v = await this.find(vendorUniqueId);
    return this.createUser(v.id, input, true, actor.email);
  }

  async resendActivation(vendorUserUniqueId: string, vendorId?: number) {
    const u = await this.prisma.db.vendorUser.findUnique({
      where: { uniqueId: vendorUserUniqueId },
      include: { vendor: true },
    });
    if (!u || (vendorId && u.vendorId !== vendorId))
      throw new NotFoundException('errors.record_not_found');
    if (u.status === 'ACTIVE')
      throw new BadRequestException('errors.already_active');
    return { devLink: await this.auth.issueActivation(u, u.vendor.name) };
  }

  async setUserActive(
    vendorUserUniqueId: string,
    active: boolean,
    vendorId?: number,
  ) {
    const u = await this.prisma.db.vendorUser.findUnique({
      where: { uniqueId: vendorUserUniqueId },
    });
    if (!u || (vendorId && u.vendorId !== vendorId))
      throw new NotFoundException('errors.record_not_found');
    await this.prisma.db.vendorUser.update({
      where: { id: u.id },
      data: {
        status: active
          ? u.password
            ? 'ACTIVE'
            : 'PENDING_ACTIVATION'
          : 'DEACTIVATED',
      },
    });
    if (!active)
      await this.prisma.db.vendorSession.updateMany({
        where: { vendorUserId: u.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    await this.audit.log({
      action: active ? 'VENDOR_USER_REACTIVATED' : 'VENDOR_USER_DEACTIVATED',
      entityType: 'VendorUser',
      entityId: u.uniqueId,
    });
  }

  async resetUser2fa(
    vendorUserUniqueId: string,
    by: string,
    vendorId?: number,
  ) {
    const u = await this.prisma.db.vendorUser.findUnique({
      where: { uniqueId: vendorUserUniqueId },
    });
    if (!u || (vendorId && u.vendorId !== vendorId))
      throw new NotFoundException('errors.record_not_found');
    await this.auth.resetTwoFactor(u.id, by);
  }

  // ── queries ─────────────────────────────────────────────────────────────

  private async find(uniqueId: string) {
    const v = await this.prisma.db.vendor.findUnique({ where: { uniqueId } });
    if (!v) throw new NotFoundException('errors.record_not_found');
    return v;
  }

  async list(search?: string, categoryUniqueId?: string) {
    const where: Prisma.VendorWhereInput = {};
    if (search?.trim()) {
      where.OR = [
        { name: { contains: search.trim(), mode: 'insensitive' } },
        { number: { contains: search.trim(), mode: 'insensitive' } },
        { tin: { contains: search.trim() } },
      ];
    }
    if (categoryUniqueId) {
      const c = await this.prisma.db.productCategory.findUnique({
        where: { uniqueId: categoryUniqueId },
      });
      where.categories = { some: { categoryId: c?.id ?? -1 } };
    }
    const rows = await this.prisma.db.vendor.findMany({
      where,
      include: { categories: true, users: true },
      orderBy: { name: 'asc' },
    });
    return this.present(rows);
  }

  async get(uniqueId: string) {
    const v = await this.prisma.db.vendor.findUnique({
      where: { uniqueId },
      include: { categories: true, users: { orderBy: { createdAt: 'asc' } } },
    });
    if (!v) throw new NotFoundException('errors.record_not_found');
    return (await this.present([v]))[0];
  }

  async present(
    rows: Prisma.VendorGetPayload<{
      include: { categories: true; users: true };
    }>[],
  ) {
    const cats = await this.prisma.db.productCategory.findMany({
      where: {
        id: { in: rows.flatMap((r) => r.categories.map((c) => c.categoryId)) },
      },
    });
    const cB = new Map(cats.map((c) => [c.id, c]));
    const today = new Date(new Date().toDateString());
    return rows.map((v) => ({
      uniqueId: v.uniqueId,
      number: v.number,
      name: v.name,
      tin: v.tin,
      vrn: v.vrn,
      address: v.address,
      phone: v.phone,
      email: v.email,
      contactPerson: v.contactPerson,
      status: v.status,
      statusReason: v.statusReason,
      registeredAt: v.registeredAt,
      validUntil: v.validUntil,
      expired: v.validUntil < today,
      canBid: VendorsService.canBid(v),
      note: v.note,
      categories: v.categories.map((c) => {
        const x = cB.get(c.categoryId)!;
        return { uniqueId: x.uniqueId, code: x.code, name: x.name };
      }),
      users: v.users.map((u) => this.presentUser(u)),
    }));
  }

  presentUser(u: {
    uniqueId: string;
    fullName: string;
    email: string;
    phone: string | null;
    isAdmin: boolean;
    status: string;
    twoFactorEnabled: boolean;
    lastLoginAt: Date | null;
  }) {
    return {
      uniqueId: u.uniqueId,
      fullName: u.fullName,
      email: u.email,
      phone: u.phone,
      isAdmin: u.isAdmin,
      status: u.status,
      twoFactorEnabled: u.twoFactorEnabled,
      lastLoginAt: u.lastLoginAt,
    };
  }

  /** Renewal reminders to Procurement and the vendor (daily, 07:30 EAT). */
  @Cron('30 7 * * *', { timeZone: 'Africa/Dar_es_Salaam' })
  async renewalReminders() {
    const { reminderDays } = await this.policy.params<{ reminderDays: number }>(
      'PROC_VENDOR_VALIDITY',
    );
    const target = new Date(new Date().toDateString());
    target.setDate(target.getDate() + (reminderDays ?? 30));
    const due = await this.prisma.db.vendor.findMany({
      where: { status: 'ACTIVE', validUntil: target },
    });
    for (const v of due) {
      await this.mail.queueGeneric({
        email: v.email,
        subject: 'AzamTV vendor registration expiring',
        greeting: `Dear ${v.name},`,
        body: `Your AzamTV vendor registration ${v.number} expires on ${v.validUntil.toISOString().slice(0, 10)}. Please contact AzamTV Procurement to renew; expired vendors cannot bid.`,
      });
    }
    if (due.length) this.logger.log(`Vendor renewal reminders: ${due.length}`);
  }
}
