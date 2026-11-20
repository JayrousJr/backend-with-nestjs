import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AuditService } from '../audit/audit.service';
import { LookupInput, UpdateLookupInput } from './dto/org.inputs';

/** Job titles and employment types (configurable lists). */
@Injectable()
export class LookupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  jobTitles(includeInactive = false) {
    return this.prisma.db.jobTitle.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  employmentTypes(includeInactive = false) {
    return this.prisma.db.employmentType.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async createJobTitle(actor: CurrentUser, input: LookupInput) {
    const row = await this.prisma.db.jobTitle.create({
      data: {
        code: input.code.trim().toUpperCase(),
        name: input.name.trim(),
        createdById: actor.id,
      },
    });
    await this.audit.log({
      action: 'job_title.create',
      entityType: 'JobTitle',
      entityId: row.uniqueId,
      after: row,
    });
    return row;
  }

  async updateJobTitle(actor: CurrentUser, input: UpdateLookupInput) {
    const before = await this.prisma.db.jobTitle.findFirst({
      where: { uniqueId: input.uniqueId },
    });
    if (!before) throw new NotFoundException('errors.record_not_found');
    const row = await this.prisma.db.jobTitle.update({
      where: { id: before.id },
      data: {
        ...(input.name && { name: input.name.trim() }),
        updatedById: actor.id,
      },
    });
    await this.audit.log({
      action: 'job_title.update',
      entityType: 'JobTitle',
      entityId: row.uniqueId,
      before,
      after: row,
    });
    return row;
  }

  async setJobTitleActive(
    actor: CurrentUser,
    uniqueId: string,
    isActive: boolean,
  ) {
    const row = await this.prisma.db.jobTitle.update({
      where: { uniqueId },
      data: { isActive, updatedById: actor.id },
    });
    await this.audit.log({
      action: isActive ? 'job_title.activate' : 'job_title.deactivate',
      entityType: 'JobTitle',
      entityId: uniqueId,
    });
    return row;
  }

  async createEmploymentType(actor: CurrentUser, input: LookupInput) {
    const row = await this.prisma.db.employmentType.create({
      data: {
        code: input.code.trim().toUpperCase(),
        name: input.name.trim(),
        requiresEndDate: input.requiresEndDate ?? false,
        createdById: actor.id,
      },
    });
    await this.audit.log({
      action: 'employment_type.create',
      entityType: 'EmploymentType',
      entityId: row.uniqueId,
      after: row,
    });
    return row;
  }

  async updateEmploymentType(actor: CurrentUser, input: UpdateLookupInput) {
    const before = await this.prisma.db.employmentType.findFirst({
      where: { uniqueId: input.uniqueId },
    });
    if (!before) throw new NotFoundException('errors.record_not_found');
    const row = await this.prisma.db.employmentType.update({
      where: { id: before.id },
      data: {
        ...(input.name && { name: input.name.trim() }),
        ...(input.requiresEndDate !== undefined && {
          requiresEndDate: input.requiresEndDate,
        }),
        updatedById: actor.id,
      },
    });
    await this.audit.log({
      action: 'employment_type.update',
      entityType: 'EmploymentType',
      entityId: row.uniqueId,
      before,
      after: row,
    });
    return row;
  }

  async setEmploymentTypeActive(
    actor: CurrentUser,
    uniqueId: string,
    isActive: boolean,
  ) {
    const row = await this.prisma.db.employmentType.update({
      where: { uniqueId },
      data: { isActive, updatedById: actor.id },
    });
    await this.audit.log({
      action: isActive
        ? 'employment_type.activate'
        : 'employment_type.deactivate',
      entityType: 'EmploymentType',
      entityId: uniqueId,
    });
    return row;
  }
}
