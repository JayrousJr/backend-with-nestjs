import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@db';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AuditService } from '../audit/audit.service';
import { toEmployeeRef } from './employee-ref';
import {
  CreateActingAssignmentInput,
  CreateDepartmentInput,
  SetDepartmentPersonInput,
  UpdateDepartmentInput,
} from './dto/org.inputs';

const DEPT_INCLUDE = {
  parent: true,
  head: true,
  deputy: true,
  actingHeads: {
    where: { isActive: true },
    include: { employee: true },
    orderBy: { from: 'desc' },
  },
  _count: { select: { employees: { where: { status: { not: 'EXITED' } } } } },
} as const satisfies Prisma.DepartmentInclude;

type DeptRow = Prisma.DepartmentGetPayload<{ include: typeof DEPT_INCLUDE }>;

function toActing(a: DeptRow['actingHeads'][number] | undefined | null) {
  if (!a) return null;
  return {
    uniqueId: a.uniqueId,
    employee: toEmployeeRef(a.employee)!,
    from: a.from,
    to: a.to,
    reason: a.reason,
    isActive: a.isActive,
  };
}

function toEntity(d: DeptRow) {
  const now = new Date();
  return {
    ...d,
    parent: d.parent
      ? {
          uniqueId: d.parent.uniqueId,
          code: d.parent.code,
          name: d.parent.name,
        }
      : null,
    head: toEmployeeRef(d.head),
    deputy: toEmployeeRef(d.deputy),
    actingHead: toActing(
      d.actingHeads.find((a) => a.from <= now && a.to >= now),
    ),
    activeEmployeeCount: d._count.employees,
  };
}

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(includeInactive = false) {
    const rows = await this.prisma.db.department.findMany({
      where: includeInactive ? {} : { isActive: true },
      include: DEPT_INCLUDE,
      orderBy: [{ parentId: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    });
    return rows.map(toEntity);
  }

  async get(uniqueId: string) {
    const d = await this.prisma.db.department.findFirst({
      where: { uniqueId },
      include: DEPT_INCLUDE,
    });
    if (!d) throw new NotFoundException('errors.department_not_found');
    return toEntity(d);
  }

  async headHistory(uniqueId: string) {
    const d = await this.prisma.db.department.findFirst({
      where: { uniqueId },
      include: {
        headHistory: { include: { employee: true }, orderBy: { from: 'desc' } },
      },
    });
    if (!d) throw new NotFoundException('errors.department_not_found');
    return d.headHistory.map((h) => ({
      employee: toEmployeeRef(h.employee),
      from: h.from,
      to: h.to,
    }));
  }

  async actingAssignments(uniqueId: string) {
    const d = await this.prisma.db.department.findFirst({
      where: { uniqueId },
      include: {
        actingHeads: { include: { employee: true }, orderBy: { from: 'desc' } },
      },
    });
    if (!d) throw new NotFoundException('errors.department_not_found');
    return d.actingHeads.map((a) => toActing(a)!);
  }

  /**
   * The person who acts as HOD on a date: the acting HOD if one is in
   * force, else the HOD. Used by assignee rules such as
   * `requester_department` / `responsible_department`.
   */
  async resolveHeadEmployeeId(
    departmentId: number,
    at = new Date(),
  ): Promise<number | null> {
    const acting = await this.prisma.db.actingAssignment.findFirst({
      where: {
        departmentId,
        isActive: true,
        from: { lte: at },
        to: { gte: at },
      },
      orderBy: { from: 'desc' },
    });
    if (acting) return acting.employeeId;
    const d = await this.prisma.db.department.findUnique({
      where: { id: departmentId },
      select: { headEmployeeId: true },
    });
    return d?.headEmployeeId ?? null;
  }

  private async parentId(parentUniqueId: string, selfId?: number) {
    const parent = await this.prisma.db.department.findFirst({
      where: { uniqueId: parentUniqueId, isActive: true },
    });
    if (!parent) throw new BadRequestException('errors.department_not_found');
    // Two levels only: department → section.
    if (parent.parentId != null) {
      throw new BadRequestException('errors.department_depth');
    }
    if (selfId != null) {
      if (parent.id === selfId) {
        throw new BadRequestException('errors.department_depth');
      }
      const hasChildren = await this.prisma.db.department.count({
        where: { parentId: selfId },
      });
      if (hasChildren) throw new BadRequestException('errors.department_depth');
    }
    return parent.id;
  }

  async create(actor: CurrentUser, input: CreateDepartmentInput) {
    const parentId = input.parentUniqueId
      ? await this.parentId(input.parentUniqueId)
      : null;
    const d = await this.prisma.db.department.create({
      data: {
        code: input.code.trim().toUpperCase(),
        name: input.name.trim(),
        parentId,
        createdById: actor.id,
      },
      include: DEPT_INCLUDE,
    });
    await this.audit.log({
      action: 'department.create',
      entityType: 'Department',
      entityId: d.uniqueId,
      after: { code: d.code, name: d.name, parentId },
    });
    return toEntity(d);
  }

  async update(actor: CurrentUser, input: UpdateDepartmentInput) {
    const before = await this.prisma.db.department.findFirst({
      where: { uniqueId: input.uniqueId },
    });
    if (!before) throw new NotFoundException('errors.department_not_found');
    let parentId: number | null | undefined;
    if (input.clearParent) parentId = null;
    else if (input.parentUniqueId) {
      parentId = await this.parentId(input.parentUniqueId, before.id);
    }
    const d = await this.prisma.db.department.update({
      where: { id: before.id },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(parentId !== undefined && { parentId }),
        updatedById: actor.id,
      },
      include: DEPT_INCLUDE,
    });
    await this.audit.log({
      action: 'department.update',
      entityType: 'Department',
      entityId: d.uniqueId,
      before: { name: before.name, parentId: before.parentId },
      after: { name: d.name, parentId: d.parentId },
    });
    return toEntity(d);
  }

  private async findEmployee(uniqueId: string) {
    const e = await this.prisma.db.employee.findFirst({ where: { uniqueId } });
    if (!e) throw new BadRequestException('errors.employee_not_found');
    if (e.status === 'EXITED' || e.status === 'SUSPENDED') {
      throw new BadRequestException('errors.employee_not_assignable');
    }
    return e;
  }

  /** Set (or clear) the HOD; the change is kept in history. */
  async setHead(actor: CurrentUser, input: SetDepartmentPersonInput) {
    const dept = await this.prisma.db.department.findFirst({
      where: { uniqueId: input.departmentUniqueId },
    });
    if (!dept) throw new NotFoundException('errors.department_not_found');
    const employee = input.employeeUniqueId
      ? await this.findEmployee(input.employeeUniqueId)
      : null;
    if ((employee?.id ?? null) === dept.headEmployeeId) {
      return this.get(dept.uniqueId);
    }

    const now = new Date();
    await this.prisma.db.$transaction(async (tx) => {
      await tx.departmentHeadHistory.updateMany({
        where: { departmentId: dept.id, to: null },
        data: { to: now },
      });
      await tx.departmentHeadHistory.create({
        data: {
          departmentId: dept.id,
          employeeId: employee?.id,
          from: now,
          changedById: actor.id,
        },
      });
      await tx.department.update({
        where: { id: dept.id },
        data: { headEmployeeId: employee?.id ?? null, updatedById: actor.id },
      });
      await this.audit.log(
        {
          action: 'department.set_head',
          entityType: 'Department',
          entityId: dept.uniqueId,
          before: { headEmployeeId: dept.headEmployeeId },
          after: { headEmployeeId: employee?.id ?? null },
        },
        tx,
      );
    });
    return this.get(dept.uniqueId);
  }

  async setDeputy(actor: CurrentUser, input: SetDepartmentPersonInput) {
    const dept = await this.prisma.db.department.findFirst({
      where: { uniqueId: input.departmentUniqueId },
    });
    if (!dept) throw new NotFoundException('errors.department_not_found');
    const employee = input.employeeUniqueId
      ? await this.findEmployee(input.employeeUniqueId)
      : null;
    await this.prisma.db.department.update({
      where: { id: dept.id },
      data: { deputyEmployeeId: employee?.id ?? null, updatedById: actor.id },
    });
    await this.audit.log({
      action: 'department.set_deputy',
      entityType: 'Department',
      entityId: dept.uniqueId,
      before: { deputyEmployeeId: dept.deputyEmployeeId },
      after: { deputyEmployeeId: employee?.id ?? null },
    });
    return this.get(dept.uniqueId);
  }

  async createActing(actor: CurrentUser, input: CreateActingAssignmentInput) {
    if (input.to < input.from) {
      throw new BadRequestException('errors.invalid_date_range');
    }
    const dept = await this.prisma.db.department.findFirst({
      where: { uniqueId: input.departmentUniqueId, isActive: true },
    });
    if (!dept) throw new NotFoundException('errors.department_not_found');
    const employee = await this.findEmployee(input.employeeUniqueId);
    const overlap = await this.prisma.db.actingAssignment.count({
      where: {
        departmentId: dept.id,
        isActive: true,
        from: { lte: input.to },
        to: { gte: input.from },
      },
    });
    if (overlap) throw new BadRequestException('errors.acting_overlap');

    const a = await this.prisma.db.actingAssignment.create({
      data: {
        departmentId: dept.id,
        employeeId: employee.id,
        from: input.from,
        to: input.to,
        reason: input.reason,
        createdById: actor.id,
      },
      include: { employee: true },
    });
    await this.audit.log({
      action: 'department.acting_create',
      entityType: 'ActingAssignment',
      entityId: a.uniqueId,
      after: {
        departmentId: dept.id,
        employeeId: employee.id,
        from: a.from,
        to: a.to,
      },
    });
    return toActing(a)!;
  }

  async cancelActing(actor: CurrentUser, uniqueId: string) {
    const a = await this.prisma.db.actingAssignment.findFirst({
      where: { uniqueId, isActive: true },
    });
    if (!a) throw new NotFoundException('errors.record_not_found');
    const updated = await this.prisma.db.actingAssignment.update({
      where: { id: a.id },
      data: { isActive: false, updatedById: actor.id },
      include: { employee: true },
    });
    await this.audit.log({
      action: 'department.acting_cancel',
      entityType: 'ActingAssignment',
      entityId: uniqueId,
    });
    return toActing(updated)!;
  }

  /**
   * Deactivate only when the department has no active employees (and, once
   * those modules exist, no open requests or active products). Never deleted.
   */
  async setActive(actor: CurrentUser, uniqueId: string, isActive: boolean) {
    const dept = await this.prisma.db.department.findFirst({
      where: { uniqueId },
    });
    if (!dept) throw new NotFoundException('errors.department_not_found');
    if (!isActive) {
      const [employees, activeChildren] = await Promise.all([
        this.prisma.db.employee.count({
          where: { departmentId: dept.id, status: { not: 'EXITED' } },
        }),
        this.prisma.db.department.count({
          where: { parentId: dept.id, isActive: true },
        }),
      ]);
      if (employees || activeChildren) {
        throw new BadRequestException('errors.department_in_use');
      }
    }
    await this.prisma.db.department.update({
      where: { id: dept.id },
      data: { isActive, updatedById: actor.id },
    });
    await this.audit.log({
      action: isActive ? 'department.activate' : 'department.deactivate',
      entityType: 'Department',
      entityId: uniqueId,
    });
    return this.get(uniqueId);
  }
}
