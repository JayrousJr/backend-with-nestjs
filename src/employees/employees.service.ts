import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { EmployeeStatus, Prisma } from '@db';
import { PrismaService, type DbTx } from '@prisma';
import { PaginationInput, buildPaginationMeta } from '@common';
import type { CurrentUser } from '@common';
import { AccessService } from '@access';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { toEmployeeRef } from '../org/employee-ref';
import {
  ChangeEmployeeStatusInput,
  CreateEmployeeInput,
  EmployeeFilterInput,
  SetDriverProfileInput,
  UpdateEmployeeInput,
} from './dto/employee.inputs';

export const EMPLOYEE_INCLUDE = {
  department: true,
  jobTitle: true,
  employmentType: true,
  supervisor: true,
  driverProfile: true,
  photo: true,
  user: { select: { uniqueId: true, status: true } },
} as const satisfies Prisma.EmployeeInclude;

type EmployeeRow = Prisma.EmployeeGetPayload<{
  include: typeof EMPLOYEE_INCLUDE;
}>;

/** Fields whose changes go to employee_history (spec §3.3). */
const TRACKED = [
  'departmentId',
  'jobTitleId',
  'supervisorId',
  'employmentTypeId',
  'status',
  'companyEmail',
] as const;

export const EVENTS = {
  EMPLOYEE_EXITED: 'employee.exited',
  EMPLOYEE_TRANSFERRED: 'employee.transferred',
  EMPLOYEE_STATUS_CHANGED: 'employee.status_changed',
} as const;

function toEntity(e: EmployeeRow, personal: boolean) {
  return {
    ...e,
    fullName: [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' '),
    phone: personal ? e.phone : null,
    photoFileId: personal ? (e.photo?.uniqueId ?? null) : null,
    department: {
      uniqueId: e.department.uniqueId,
      code: e.department.code,
      name: e.department.name,
    },
    jobTitle: e.jobTitle,
    employmentType: e.employmentType,
    supervisor: toEmployeeRef(e.supervisor),
    driverProfile:
      personal && e.driverProfile?.isActive ? e.driverProfile : null,
    user: e.user,
    personalVisible: personal,
  };
}

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────

  async list(
    user: CurrentUser,
    filter?: EmployeeFilterInput,
    pagination?: PaginationInput,
  ) {
    const scope = await this.access.scopeWhere<Prisma.EmployeeWhereInput>(
      user,
      'employee.view',
      {
        department: (ids) => ({ departmentId: { in: ids } }),
        ownRecords: (u) => ({ id: u.employeeId }),
      },
    );

    const and: Prisma.EmployeeWhereInput[] = [scope];
    if (filter?.search) {
      const q = filter.search.trim();
      and.push({
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { employeeNumber: { contains: q, mode: 'insensitive' } },
          { companyEmail: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
    if (filter?.departmentUniqueId) {
      and.push({ department: { uniqueId: filter.departmentUniqueId } });
    }
    if (filter?.statuses?.length) and.push({ status: { in: filter.statuses } });
    if (filter?.jobTitleUniqueId) {
      and.push({ jobTitle: { uniqueId: filter.jobTitleUniqueId } });
    }
    if (filter?.employmentTypeUniqueId) {
      and.push({ employmentType: { uniqueId: filter.employmentTypeUniqueId } });
    }
    if (filter?.hasUser !== undefined) {
      and.push(filter.hasUser ? { user: { isNot: null } } : { user: null });
    }
    if (filter?.isDriver !== undefined) {
      and.push(
        filter.isDriver
          ? { driverProfile: { is: { isActive: true } } }
          : { NOT: { driverProfile: { is: { isActive: true } } } },
      );
    }
    if (filter?.contractEndsBefore) {
      and.push({ contractEndDate: { lte: filter.contractEndsBefore } });
    }
    const where: Prisma.EmployeeWhereInput = { AND: and };

    const page = Math.max(1, pagination?.page ?? 1);
    const limit = Math.min(100, pagination?.limit ?? 25);
    const [rows, total, personal] = await Promise.all([
      this.prisma.db.employee.findMany({
        where,
        include: EMPLOYEE_INCLUDE,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.db.employee.count({ where }),
      this.access.resolveScope(user, 'employee.view_personal'),
    ]);

    return {
      data: rows.map((e) =>
        toEntity(
          e,
          personal.all || personal.departmentIds.includes(e.departmentId),
        ),
      ),
      ...buildPaginationMeta(total, page, limit),
    };
  }

  private async find(uniqueId: string): Promise<EmployeeRow> {
    const e = await this.prisma.db.employee.findFirst({
      where: { uniqueId },
      include: EMPLOYEE_INCLUDE,
    });
    if (!e) throw new NotFoundException('errors.employee_not_found');
    return e;
  }

  private subject(e: { id: number; departmentId: number }) {
    return { departmentId: e.departmentId, subjectEmployeeId: e.id };
  }

  async get(user: CurrentUser, uniqueId: string) {
    const e = await this.find(uniqueId);
    await this.access.assert(user, 'employee.view', this.subject(e));
    const personal = await this.access.can(user, 'employee.view_personal', {
      departmentId: e.departmentId,
    });
    return toEntity(e, personal);
  }

  async history(user: CurrentUser, uniqueId: string) {
    const e = await this.find(uniqueId);
    await this.access.assert(user, 'employee.view_personal', {
      departmentId: e.departmentId,
    });
    const rows = await this.prisma.db.employeeHistory.findMany({
      where: { employeeId: e.id },
      orderBy: { createdAt: 'desc' },
    });
    const userIds = [
      ...new Set(
        rows.map((r) => r.changedById).filter((x): x is number => !!x),
      ),
    ];
    const users = await this.prisma.db.user.findMany({
      where: { id: { in: userIds } },
      include: { employee: true },
    });
    const names = new Map(
      users.map((u) => [
        u.id,
        `${u.employee.firstName} ${u.employee.lastName}`,
      ]),
    );
    return rows.map((r) => ({
      ...r,
      changedBy: r.changedById ? (names.get(r.changedById) ?? null) : null,
    }));
  }

  // ── validation helpers ───────────────────────────────────────────────────

  private async assertEmail(email: string, exceptEmployeeId?: number) {
    if (!(await this.policy.isAllowedEmail(email))) {
      throw new BadRequestException({
        message: 'errors.email_domain_not_allowed',
        args: { domains: (await this.policy.allowedEmailDomains()).join(', ') },
      });
    }
    const clash = await this.prisma.dbRaw.employee.findFirst({
      where: {
        companyEmail: { equals: email, mode: 'insensitive' },
        ...(exceptEmployeeId && { id: { not: exceptEmployeeId } }),
      },
    });
    if (clash) throw new ConflictException('errors.email_in_use');
  }

  private async resolveRefs(input: {
    departmentUniqueId?: string;
    jobTitleUniqueId?: string;
    employmentTypeUniqueId?: string;
    supervisorUniqueId?: string;
  }) {
    const db = this.prisma.db;
    const [department, jobTitle, employmentType, supervisor] =
      await Promise.all([
        input.departmentUniqueId
          ? db.department.findFirst({
              where: { uniqueId: input.departmentUniqueId, isActive: true },
            })
          : null,
        input.jobTitleUniqueId
          ? db.jobTitle.findFirst({
              where: { uniqueId: input.jobTitleUniqueId, isActive: true },
            })
          : null,
        input.employmentTypeUniqueId
          ? db.employmentType.findFirst({
              where: { uniqueId: input.employmentTypeUniqueId, isActive: true },
            })
          : null,
        input.supervisorUniqueId
          ? db.employee.findFirst({
              where: { uniqueId: input.supervisorUniqueId },
            })
          : null,
      ]);
    if (input.departmentUniqueId && !department)
      throw new BadRequestException('errors.department_not_found');
    if (input.jobTitleUniqueId && !jobTitle)
      throw new BadRequestException('errors.job_title_not_found');
    if (input.employmentTypeUniqueId && !employmentType)
      throw new BadRequestException('errors.employment_type_not_found');
    if (input.supervisorUniqueId && !supervisor)
      throw new BadRequestException('errors.supervisor_not_found');
    return { department, jobTitle, employmentType, supervisor };
  }

  // ── writes ───────────────────────────────────────────────────────────────

  async create(user: CurrentUser, input: CreateEmployeeInput) {
    const refs = await this.resolveRefs(input);
    await this.access.assert(user, 'employee.manage', {
      departmentId: refs.department!.id,
    });

    const email = input.companyEmail.trim().toLowerCase();
    await this.assertEmail(email);
    const number = input.employeeNumber.trim();
    const numberClash = await this.prisma.dbRaw.employee.findFirst({
      where: { employeeNumber: number },
    });
    // Employee numbers are never reused — even exited employees keep theirs.
    if (numberClash)
      throw new ConflictException('errors.employee_number_in_use');

    if (refs.employmentType!.requiresEndDate && !input.contractEndDate) {
      throw new BadRequestException('errors.contract_end_required');
    }
    if (input.contractEndDate && input.contractEndDate < input.startDate) {
      throw new BadRequestException('errors.invalid_date_range');
    }

    const e = await this.prisma.db.employee.create({
      data: {
        employeeNumber: number,
        firstName: input.firstName.trim(),
        middleName: input.middleName?.trim() || null,
        lastName: input.lastName.trim(),
        gender: input.gender,
        companyEmail: email,
        phone: input.phone.trim(),
        departmentId: refs.department!.id,
        jobTitleId: refs.jobTitle!.id,
        employmentTypeId: refs.employmentType!.id,
        startDate: input.startDate,
        contractEndDate: input.contractEndDate,
        supervisorId: refs.supervisor?.id,
        workLocation: input.workLocation,
        skills: input.skills ?? [],
        qualifications: input.qualifications ?? [],
        professionalRoles: input.professionalRoles ?? [],
        createdById: user.id,
      },
      include: EMPLOYEE_INCLUDE,
    });
    await this.audit.log({
      action: 'employee.create',
      entityType: 'Employee',
      entityId: e.uniqueId,
      after: e,
    });
    return toEntity(e, true);
  }

  async update(user: CurrentUser, input: UpdateEmployeeInput) {
    const before = await this.find(input.uniqueId);
    await this.access.assert(user, 'employee.manage', {
      departmentId: before.departmentId,
    });
    const refs = await this.resolveRefs(input);
    if (refs.department) {
      // Moving someone into another department needs rights there too.
      await this.access.assert(user, 'employee.manage', {
        departmentId: refs.department.id,
      });
    }
    if (refs.supervisor?.id === before.id) {
      throw new BadRequestException('errors.supervisor_self');
    }

    let email: string | undefined;
    if (input.companyEmail) {
      email = input.companyEmail.trim().toLowerCase();
      if (email !== before.companyEmail)
        await this.assertEmail(email, before.id);
      else email = undefined;
    }

    const employmentType = refs.employmentType ?? before.employmentType;
    const contractEndDate = input.clearContractEndDate
      ? null
      : (input.contractEndDate ?? before.contractEndDate);
    if (employmentType.requiresEndDate && !contractEndDate) {
      throw new BadRequestException('errors.contract_end_required');
    }

    const data: Prisma.EmployeeUncheckedUpdateInput = {
      ...(input.firstName !== undefined && {
        firstName: input.firstName.trim(),
      }),
      ...(input.middleName !== undefined && {
        middleName: input.middleName.trim() || null,
      }),
      ...(input.lastName !== undefined && { lastName: input.lastName.trim() }),
      ...(input.gender !== undefined && { gender: input.gender }),
      ...(email && { companyEmail: email }),
      ...(input.phone !== undefined && { phone: input.phone.trim() }),
      ...(refs.department && { departmentId: refs.department.id }),
      ...(refs.jobTitle && { jobTitleId: refs.jobTitle.id }),
      ...(refs.employmentType && { employmentTypeId: refs.employmentType.id }),
      contractEndDate,
      ...(refs.supervisor && { supervisorId: refs.supervisor.id }),
      ...(input.clearSupervisor && { supervisorId: null }),
      ...(input.workLocation !== undefined && {
        workLocation: input.workLocation || null,
      }),
      ...(input.skills && { skills: input.skills }),
      ...(input.qualifications && { qualifications: input.qualifications }),
      ...(input.professionalRoles && {
        professionalRoles: input.professionalRoles,
      }),
      updatedById: user.id,
    };

    const after = await this.prisma.db.$transaction(async (tx) => {
      const updated = await tx.employee.update({
        where: { id: before.id },
        data,
        include: EMPLOYEE_INCLUDE,
      });
      await this.writeHistory(
        tx,
        user,
        before,
        updated,
        input.effectiveDate,
        input.reason,
      );
      // The login email follows the company email (history kept above).
      if (email && before.user) {
        await tx.user.update({
          where: { uniqueId: before.user.uniqueId },
          data: { email },
        });
      }
      await this.audit.log(
        {
          action: 'employee.update',
          entityType: 'Employee',
          entityId: updated.uniqueId,
          before,
          after: updated,
        },
        tx,
      );
      return updated;
    });

    if (after.departmentId !== before.departmentId) {
      // B3 builds the custody review list for the old and new HOD from this.
      this.events.emit(EVENTS.EMPLOYEE_TRANSFERRED, {
        employeeId: after.id,
        fromDepartmentId: before.departmentId,
        toDepartmentId: after.departmentId,
      });
    }
    return toEntity(after, true);
  }

  private async writeHistory(
    tx: DbTx,
    user: CurrentUser,
    before: EmployeeRow,
    after: EmployeeRow,
    effectiveDate?: Date,
    reason?: string,
  ) {
    const label = (field: (typeof TRACKED)[number], e: EmployeeRow) => {
      switch (field) {
        case 'departmentId':
          return e.department.name;
        case 'jobTitleId':
          return e.jobTitle.name;
        case 'employmentTypeId':
          return e.employmentType.name;
        case 'supervisorId':
          return toEmployeeRef(e.supervisor)?.fullName ?? null;
        default:
          return e[field] as string | null;
      }
    };
    const rows = TRACKED.filter((f) => before[f] !== after[f]).map((f) => ({
      employeeId: after.id,
      field: f.replace(/Id$/, ''),
      oldValue: label(f, before),
      newValue: label(f, after),
      effectiveDate: effectiveDate ?? new Date(),
      changedById: user.id,
      reason,
    }));
    if (rows.length) await tx.employeeHistory.createMany({ data: rows });
  }

  /**
   * Status changes and their effects (spec §3.2):
   * On Leave → login allowed; Suspended → login blocked, sessions ended;
   * Exited → user deactivated, sessions ended, delegations cancelled, exit
   * clearance starts; Exited → Active is a rehire (same number, same user,
   * roles must be reassigned).
   */
  async changeStatus(user: CurrentUser, input: ChangeEmployeeStatusInput) {
    const before = await this.find(input.uniqueId);
    const from = before.status;
    const to = input.status;
    if (from === to) return toEntity(before, true);

    const isExit = to === 'EXITED';
    const isRehire = from === 'EXITED';
    await this.access.assert(
      user,
      isExit ? 'employee.exit' : 'employee.manage',
      { departmentId: before.departmentId },
    );
    if (isRehire && to !== 'ACTIVE') {
      throw new BadRequestException('errors.rehire_must_be_active');
    }
    if (isRehire && !input.newStartDate) {
      throw new BadRequestException('errors.rehire_start_date_required');
    }

    const after = await this.prisma.db.$transaction(async (tx) => {
      const updated = await tx.employee.update({
        where: { id: before.id },
        data: {
          status: to,
          ...(isRehire && {
            startDate: input.newStartDate,
            contractEndDate: null,
          }),
          updatedById: user.id,
        },
        include: EMPLOYEE_INCLUDE,
      });
      await this.writeHistory(
        tx,
        user,
        before,
        updated,
        input.effectiveDate,
        input.reason,
      );
      await this.applyUserEffects(tx, before.id, from, to);
      await this.audit.log(
        {
          action: isExit
            ? 'employee.exit'
            : isRehire
              ? 'employee.rehire'
              : 'employee.status',
          entityType: 'Employee',
          entityId: updated.uniqueId,
          before: { status: from },
          after: { status: to, reason: input.reason },
        },
        tx,
      );
      return updated;
    });

    this.events.emit(EVENTS.EMPLOYEE_STATUS_CHANGED, {
      employeeId: after.id,
      from,
      to,
    });
    if (isExit) {
      this.events.emit(EVENTS.EMPLOYEE_EXITED, { employeeId: after.id });
    }
    // Re-read: the user's status changed inside the transaction.
    return toEntity(await this.find(after.uniqueId), true);
  }

  private async applyUserEffects(
    tx: DbTx,
    employeeId: number,
    from: EmployeeStatus,
    to: EmployeeStatus,
  ) {
    const u = await tx.user.findUnique({ where: { employeeId } });
    if (!u) return;

    const endSessions = () =>
      tx.session.updateMany({
        where: { userId: u.id, isDeleted: false },
        data: { isDeleted: true, deletedAt: new Date() },
      });

    if (to === 'SUSPENDED' || to === 'EXITED') await endSessions();

    if (to === 'EXITED') {
      await tx.user.update({
        where: { id: u.id },
        data: { status: 'DEACTIVATED' },
      });
      await tx.delegation.updateMany({
        where: {
          OR: [{ fromUserId: u.id }, { toUserId: u.id }],
          status: { in: ['PENDING', 'APPROVED'] },
        },
        data: { status: 'CANCELLED' },
      });
    }

    if (from === 'EXITED' && to === 'ACTIVE') {
      // Rehire: same user reactivated; roles must be reassigned.
      await tx.userRole.deleteMany({ where: { userId: u.id } });
      await tx.userGroupMember.deleteMany({ where: { userId: u.id } });
      await tx.user.update({
        where: { id: u.id },
        data: {
          status: u.password ? 'ACTIVE' : 'PENDING_ACTIVATION',
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
    }
  }

  async setDriverProfile(user: CurrentUser, input: SetDriverProfileInput) {
    const e = await this.find(input.employeeUniqueId);
    const before = e.driverProfile;
    const data = {
      licenceNumber: input.licenceNumber.trim().toUpperCase(),
      licenceClass: input.licenceClass.trim().toUpperCase(),
      licenceExpiry: input.licenceExpiry,
    };
    await this.prisma.db.driverProfile.upsert({
      where: { employeeId: e.id },
      update: { ...data, isActive: true, updatedById: user.id },
      create: { ...data, employeeId: e.id, createdById: user.id },
    });
    await this.audit.log({
      action: 'driver_profile.set',
      entityType: 'Employee',
      entityId: e.uniqueId,
      before,
      after: data,
    });
    return toEntity(await this.find(e.uniqueId), true);
  }

  async removeDriverProfile(user: CurrentUser, employeeUniqueId: string) {
    const e = await this.find(employeeUniqueId);
    if (e.driverProfile) {
      // Kept forever: the profile is deactivated, not deleted.
      await this.prisma.db.driverProfile.update({
        where: { employeeId: e.id },
        data: { isActive: false, updatedById: user.id },
      });
      await this.audit.log({
        action: 'driver_profile.remove',
        entityType: 'Employee',
        entityId: e.uniqueId,
        before: e.driverProfile,
      });
    }
    return toEntity(await this.find(e.uniqueId), true);
  }
}
