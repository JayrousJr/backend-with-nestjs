import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { Prisma } from '@db';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AccessService, type PermissionCode } from '@access';
import { AuditService } from '../audit/audit.service';
import { AssetsService } from '../store/assets.service';
import { StoresService } from '../store/stores.service';

type Cell = string | number | Date | null | undefined;

interface Column {
  header: string;
  width?: number;
  /** dd/mm/yyyy, or with time. */
  format?: 'date' | 'datetime';
}

interface Table {
  title: string;
  columns: Column[];
  rows: Cell[][];
  /** Shown under the title (filters used). */
  notes?: string[];
}

export type ReportParams = Record<string, string | undefined>;

interface ReportDefinition {
  name: string;
  description: string;
  permission: PermissionCode;
  params?: {
    key: string;
    label: string;
    type: 'text' | 'number' | 'date' | 'permission';
  }[];
  build: (user: CurrentUser, p: ReportParams) => Promise<Table>;
}

const fullName = (e: {
  firstName: string;
  middleName?: string | null;
  lastName: string;
}) => [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ');

/** A1 (user-employee-spec.md §12) and B2 (§9, §11) reports, exported as Excel. */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly assets: AssetsService,
    private readonly stores: StoresService,
  ) {}

  private readonly reports: Record<string, ReportDefinition> = {
    'employee-register': {
      name: 'Employee register',
      description:
        'Every employee you may see, with department, job, type and status',
      permission: 'employee.view',
      params: [
        {
          key: 'status',
          label: 'Status (ACTIVE, ON_LEAVE, SUSPENDED, EXITED; empty = all)',
          type: 'text',
        },
      ],
      build: async (user, p) => {
        const scope = await this.access.scopeWhere<Prisma.EmployeeWhereInput>(
          user,
          'employee.view',
          {
            department: (ids) => ({ departmentId: { in: ids } }),
            ownRecords: (u) => ({ id: u.employeeId }),
          },
        );
        const personal = await this.access.resolveScope(
          user,
          'employee.view_personal',
        );
        const rows = await this.prisma.db.employee.findMany({
          where: {
            AND: [scope, p.status ? { status: p.status as never } : {}],
          },
          include: {
            department: true,
            jobTitle: true,
            employmentType: true,
            supervisor: true,
            user: true,
          },
          orderBy: [{ department: { name: 'asc' } }, { lastName: 'asc' }],
        });
        return {
          title: 'Employee register',
          notes: p.status ? [`Status: ${p.status}`] : [],
          columns: [
            { header: 'Employee no.', width: 14 },
            { header: 'Name', width: 28 },
            { header: 'Gender', width: 9 },
            { header: 'Company email', width: 30 },
            { header: 'Phone', width: 18 },
            { header: 'Department', width: 22 },
            { header: 'Job title', width: 24 },
            { header: 'Employment type', width: 16 },
            { header: 'Start date', width: 12, format: 'date' },
            { header: 'Contract end', width: 12, format: 'date' },
            { header: 'Supervisor', width: 24 },
            { header: 'Status', width: 12 },
            { header: 'User account', width: 18 },
          ],
          rows: rows.map((e) => [
            e.employeeNumber,
            fullName(e),
            e.gender,
            e.companyEmail,
            personal.all || personal.departmentIds.includes(e.departmentId)
              ? e.phone
              : '(hidden)',
            e.department.name,
            e.jobTitle.name,
            e.employmentType.name,
            e.startDate,
            e.contractEndDate,
            e.supervisor ? fullName(e.supervisor) : '',
            e.status,
            e.user?.status ?? 'none',
          ]),
        };
      },
    },

    'employees-without-users': {
      name: 'Employees without users',
      description: 'Active employees who have no user account',
      permission: 'user.view',
      build: async () => {
        const rows = await this.prisma.db.employee.findMany({
          where: { user: null, status: { in: ['ACTIVE', 'ON_LEAVE'] } },
          include: { department: true, jobTitle: true },
          orderBy: [{ department: { name: 'asc' } }, { lastName: 'asc' }],
        });
        return {
          title: 'Employees without users',
          columns: [
            { header: 'Employee no.', width: 14 },
            { header: 'Name', width: 28 },
            { header: 'Company email', width: 30 },
            { header: 'Department', width: 22 },
            { header: 'Job title', width: 24 },
            { header: 'Status', width: 12 },
          ],
          rows: rows.map((e) => [
            e.employeeNumber,
            fullName(e),
            e.companyEmail,
            e.department.name,
            e.jobTitle.name,
            e.status,
          ]),
        };
      },
    },

    'users-by-role': {
      name: 'Users by role',
      description: 'Each role with its users (direct and through groups)',
      permission: 'user.view',
      build: async () => {
        const roles = await this.prisma.db.role.findMany({
          orderBy: { name: 'asc' },
          include: {
            users: {
              include: {
                user: {
                  include: { employee: { include: { department: true } } },
                },
              },
            },
            groupRoles: {
              include: {
                group: {
                  include: {
                    members: {
                      include: {
                        user: {
                          include: {
                            employee: { include: { department: true } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        });
        const rows: Cell[][] = [];
        for (const r of roles) {
          for (const ur of r.users) {
            rows.push([
              r.name,
              r.isActive ? 'active' : 'retired',
              fullName(ur.user.employee),
              ur.user.email,
              ur.user.employee.department.name,
              ur.user.status,
              'direct',
            ]);
          }
          for (const gr of r.groupRoles) {
            for (const m of gr.group.members) {
              rows.push([
                r.name,
                r.isActive ? 'active' : 'retired',
                fullName(m.user.employee),
                m.user.email,
                m.user.employee.department.name,
                m.user.status,
                `group ${gr.group.name}`,
              ]);
            }
          }
          if (
            !r.users.length &&
            !r.groupRoles.some((g) => g.group.members.length)
          ) {
            rows.push([
              r.name,
              r.isActive ? 'active' : 'retired',
              '(no users)',
              '',
              '',
              '',
              '',
            ]);
          }
        }
        return {
          title: 'Users by role',
          columns: [
            { header: 'Role', width: 24 },
            { header: 'Role status', width: 11 },
            { header: 'User', width: 26 },
            { header: 'Email', width: 30 },
            { header: 'Department', width: 22 },
            { header: 'User status', width: 18 },
            { header: 'Through', width: 22 },
          ],
          rows,
        };
      },
    },

    'role-permission-matrix': {
      name: 'Role–permission matrix',
      description:
        'Every permission (rows) against every active role (columns), with the granted scope',
      permission: 'role.view',
      build: async () => {
        const [perms, roles] = await Promise.all([
          this.prisma.db.permission.findMany({
            where: { isActive: true },
            orderBy: [{ module: 'asc' }, { code: 'asc' }],
          }),
          this.prisma.db.role.findMany({
            where: { isActive: true },
            include: { grants: true },
            orderBy: { name: 'asc' },
          }),
        ]);
        return {
          title: 'Role–permission matrix',
          columns: [
            { header: 'Module', width: 8 },
            { header: 'Permission', width: 32 },
            ...roles.map((r) => ({ header: r.name, width: 16 })),
          ],
          rows: perms.map((p) => [
            p.module,
            p.code,
            ...roles.map((r) =>
              r.grants
                .filter((g) => g.permissionCode === p.code)
                .map((g) => g.scope.toLowerCase())
                .join(', '),
            ),
          ]),
        };
      },
    },

    'permission-holders': {
      name: 'Who holds permission X',
      description:
        'Every active user holding a permission, through which role and with which scope',
      permission: 'role.view',
      params: [
        { key: 'permission', label: 'Permission code', type: 'permission' },
      ],
      build: async (_user, p) => {
        if (!p.permission)
          throw new BadRequestException('errors.report_param_required');
        const grants = await this.prisma.db.roleGrant.findMany({
          where: { permissionCode: p.permission, role: { isActive: true } },
          include: {
            role: {
              include: {
                users: {
                  include: {
                    user: {
                      include: { employee: { include: { department: true } } },
                    },
                  },
                },
                groupRoles: {
                  include: {
                    group: {
                      include: {
                        members: {
                          include: {
                            user: {
                              include: {
                                employee: { include: { department: true } },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        });
        const rows: Cell[][] = [];
        for (const g of grants) {
          for (const ur of g.role.users) {
            rows.push([
              fullName(ur.user.employee),
              ur.user.email,
              ur.user.employee.department.name,
              ur.user.status,
              g.role.name,
              g.scope,
              'direct',
            ]);
          }
          for (const gr of g.role.groupRoles) {
            if (!gr.group.isActive) continue;
            for (const m of gr.group.members) {
              rows.push([
                fullName(m.user.employee),
                m.user.email,
                m.user.employee.department.name,
                m.user.status,
                g.role.name,
                g.scope,
                `group ${gr.group.name}`,
              ]);
            }
          }
        }
        return {
          title: `Who holds ${p.permission}`,
          notes: [
            'Delegations in force add holders temporarily; see the delegations report.',
          ],
          columns: [
            { header: 'User', width: 26 },
            { header: 'Email', width: 30 },
            { header: 'Department', width: 22 },
            { header: 'User status', width: 18 },
            { header: 'Role', width: 24 },
            { header: 'Scope', width: 16 },
            { header: 'Through', width: 22 },
          ],
          rows,
        };
      },
    },

    'inactive-locked-accounts': {
      name: 'Inactive and locked accounts',
      description:
        'Users deactivated, locked, never activated, or not logged in for N days',
      permission: 'user.view',
      params: [{ key: 'days', label: 'No login for (days)', type: 'number' }],
      build: async (_u, p) => {
        const days = Number(p.days || 90);
        const since = new Date(Date.now() - days * 86_400_000);
        const users = await this.prisma.db.user.findMany({
          where: {
            OR: [
              {
                status: { in: ['DEACTIVATED', 'LOCKED', 'PENDING_ACTIVATION'] },
              },
              { lockedUntil: { gt: new Date() } },
              {
                status: 'ACTIVE',
                OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: since } }],
              },
            ],
          },
          include: { employee: { include: { department: true } } },
          orderBy: { email: 'asc' },
        });
        return {
          title: 'Inactive and locked accounts',
          notes: [`Inactive = no login for ${days} days`],
          columns: [
            { header: 'User', width: 26 },
            { header: 'Email', width: 30 },
            { header: 'Department', width: 22 },
            { header: 'Status', width: 18 },
            { header: 'Locked until', width: 18, format: 'datetime' },
            { header: 'Last login', width: 18, format: 'datetime' },
            { header: 'Employee status', width: 14 },
          ],
          rows: users.map((u) => [
            fullName(u.employee),
            u.email,
            u.employee.department.name,
            u.status,
            u.lockedUntil,
            u.lastLoginAt,
            u.employee.status,
          ]),
        };
      },
    },

    'login-history': {
      name: 'Login history',
      description: 'Logins, failures, lockouts, resets and 2FA events',
      permission: 'security.view_logins',
      params: [
        { key: 'from', label: 'From', type: 'date' },
        { key: 'to', label: 'To', type: 'date' },
        { key: 'failuresOnly', label: 'Failures only (yes/no)', type: 'text' },
      ],
      build: async (_u, p) => {
        const from = p.from
          ? new Date(p.from)
          : new Date(Date.now() - 30 * 86_400_000);
        const to = p.to ? new Date(`${p.to}T23:59:59`) : new Date();
        const rows = await this.prisma.dbRaw.loginEvent.findMany({
          where: {
            createdAt: { gte: from, lte: to },
            ...(p.failuresOnly === 'yes' && { success: false }),
          },
          orderBy: { createdAt: 'desc' },
          take: 50_000,
        });
        return {
          title: 'Login history',
          notes: [
            `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`,
          ],
          columns: [
            { header: 'When', width: 18, format: 'datetime' },
            { header: 'Email', width: 30 },
            { header: 'Event', width: 22 },
            { header: 'Success', width: 9 },
            { header: 'Reason', width: 22 },
            { header: 'IP', width: 16 },
            { header: 'Device', width: 40 },
          ],
          rows: rows.map((e) => [
            e.createdAt,
            e.email,
            e.type,
            e.success ? 'yes' : 'no',
            e.reason,
            e.ipAddress,
            e.userAgent,
          ]),
        };
      },
    },

    delegations: {
      name: 'Delegations',
      description: 'All delegations with their period, roles and decision',
      permission: 'delegation.approve',
      build: async () => {
        const rows = await this.prisma.db.delegation.findMany({
          orderBy: { start: 'desc' },
        });
        const ids = [
          ...new Set(
            rows.flatMap((d) => [
              d.fromUserId,
              d.toUserId,
              d.approvedById ?? -1,
            ]),
          ),
        ];
        const users = await this.prisma.db.user.findMany({
          where: { id: { in: ids } },
          include: { employee: true },
        });
        const roles = await this.prisma.db.role.findMany({
          where: { id: { in: rows.flatMap((d) => d.roleIds) } },
        });
        const name = (id: number | null) => {
          const u = users.find((x) => x.id === id);
          return u ? fullName(u.employee) : '';
        };
        return {
          title: 'Delegations',
          columns: [
            { header: 'From', width: 24 },
            { header: 'To', width: 24 },
            { header: 'Roles', width: 30 },
            { header: 'Start', width: 18, format: 'datetime' },
            { header: 'End', width: 18, format: 'datetime' },
            { header: 'Status', width: 12 },
            { header: 'Decided by', width: 24 },
            { header: 'Reason', width: 40 },
          ],
          rows: rows.map((d) => [
            name(d.fromUserId),
            name(d.toUserId),
            d.roleIds.length
              ? roles
                  .filter((r) => d.roleIds.includes(r.id))
                  .map((r) => r.name)
                  .join(', ')
              : 'All roles',
            d.start,
            d.end,
            d.status,
            name(d.approvedById),
            d.reason,
          ]),
        };
      },
    },

    'contracts-ending': {
      name: 'Contracts ending',
      description:
        'Contract and intern employees whose contract ends within N days',
      permission: 'employee.view',
      params: [{ key: 'days', label: 'Within (days)', type: 'number' }],
      build: async (user, p) => {
        const days = Number(p.days || 60);
        const scope = await this.access.scopeWhere<Prisma.EmployeeWhereInput>(
          user,
          'employee.view',
          {
            department: (ids) => ({ departmentId: { in: ids } }),
            ownRecords: (u) => ({ id: u.employeeId }),
          },
        );
        const rows = await this.prisma.db.employee.findMany({
          where: {
            AND: [
              scope,
              {
                status: { not: 'EXITED' },
                contractEndDate: {
                  not: null,
                  lte: new Date(Date.now() + days * 86_400_000),
                },
              },
            ],
          },
          include: { department: true, employmentType: true, supervisor: true },
          orderBy: { contractEndDate: 'asc' },
        });
        return {
          title: 'Contracts ending',
          notes: [`Ending within ${days} days (overdue included)`],
          columns: [
            { header: 'Employee no.', width: 14 },
            { header: 'Name', width: 28 },
            { header: 'Department', width: 22 },
            { header: 'Type', width: 14 },
            { header: 'Contract end', width: 13, format: 'date' },
            { header: 'Days left', width: 10 },
            { header: 'Supervisor', width: 24 },
          ],
          rows: rows.map((e) => [
            e.employeeNumber,
            fullName(e),
            e.department.name,
            e.employmentType.name,
            e.contractEndDate,
            Math.ceil((e.contractEndDate!.getTime() - Date.now()) / 86_400_000),
            e.supervisor ? fullName(e.supervisor) : '',
          ]),
        };
      },
    },

    'exit-clearances': {
      name: 'Exit clearances pending',
      description: 'Clearances not yet signed off, with their open items',
      permission: 'employee.exit',
      build: async () => {
        const rows = await this.prisma.db.exitClearance.findMany({
          where: { status: { not: 'COMPLETED' } },
          include: { items: true },
          orderBy: { createdAt: 'asc' },
        });
        const emps = await this.prisma.db.employee.findMany({
          where: { id: { in: rows.map((r) => r.employeeId) } },
          include: { department: true },
        });
        return {
          title: 'Exit clearances pending',
          columns: [
            { header: 'Employee no.', width: 14 },
            { header: 'Name', width: 28 },
            { header: 'Department', width: 22 },
            { header: 'Status', width: 14 },
            { header: 'Opened', width: 18, format: 'datetime' },
            { header: 'Open items', width: 11 },
            { header: 'Items', width: 60 },
          ],
          rows: rows.map((c) => {
            const e = emps.find((x) => x.id === c.employeeId)!;
            return [
              e.employeeNumber,
              fullName(e),
              e.department.name,
              c.status,
              c.createdAt,
              c.items.filter((i) => !i.resolved).length,
              c.items
                .map((i) => `${i.resolved ? '✓' : '•'} ${i.description}`)
                .join('\n'),
            ];
          }),
        };
      },
    },

    'import-history': {
      name: 'Import history',
      description: 'Every employee import with its result',
      permission: 'employee.import',
      build: async () => {
        const rows = await this.prisma.dbRaw.importBatch.findMany({
          orderBy: { createdAt: 'desc' },
          omit: { file: true, rows: true },
        });
        const users = await this.prisma.db.user.findMany({
          where: {
            id: {
              in: rows.flatMap((r) => [r.uploadedById, r.committedById ?? -1]),
            },
          },
          include: { employee: true },
        });
        const name = (id: number | null) => {
          const u = users.find((x) => x.id === id);
          return u ? fullName(u.employee) : '';
        };
        return {
          title: 'Import history',
          columns: [
            { header: 'Uploaded', width: 18, format: 'datetime' },
            { header: 'File', width: 30 },
            { header: 'Type', width: 10 },
            { header: 'Status', width: 12 },
            { header: 'Rows', width: 8 },
            { header: 'New', width: 8 },
            { header: 'Updated', width: 9 },
            { header: 'Errors', width: 8 },
            { header: 'Uploaded by', width: 24 },
            { header: 'Committed by', width: 24 },
            { header: 'Committed', width: 18, format: 'datetime' },
          ],
          rows: rows.map((b) => [
            b.createdAt,
            b.fileName,
            b.type,
            b.status,
            b.totalRows,
            b.createCount,
            b.updateCount,
            b.errorCount,
            name(b.uploadedById),
            name(b.committedById),
            b.committedAt,
          ]),
        };
      },
    },

    // ── B2 Store & Inventory ──
    'asset-register': {
      name: 'Asset register (for Finance)',
      description:
        'Tag, product, category, purchase price, purchase date, status and location of every asset you may see (B2 §9)',
      permission: 'asset.view',
      params: [
        {
          key: 'status',
          label: 'Status (e.g. IN_STORE; empty = all)',
          type: 'text',
        },
      ],
      build: async (user, p) => {
        const status = p.status?.trim().toUpperCase();
        const rows = await this.assets.exportRows(
          user,
          status ? { statuses: [status as never] } : {},
        );
        return {
          title: 'Asset register',
          notes: status ? [`Status: ${status}`] : undefined,
          columns: [
            { header: 'Tag', width: 18 },
            { header: 'Product code', width: 12 },
            { header: 'Product', width: 32 },
            { header: 'Category', width: 20 },
            { header: 'Owning department', width: 22 },
            { header: 'Serial number', width: 18 },
            { header: 'Brand / model', width: 22 },
            { header: 'Purchase price (TZS excl. VAT)', width: 18 },
            { header: 'Price estimated', width: 10 },
            { header: 'Purchase date', width: 13, format: 'date' },
            { header: 'Source', width: 16 },
            { header: 'Status', width: 22 },
            { header: 'Condition', width: 14 },
            { header: 'Store', width: 18 },
            { header: 'Location', width: 16 },
            { header: 'Held by', width: 24 },
            { header: 'Registration', width: 12 },
          ],
          rows: rows.map((a) => [
            a.tag,
            a.product.code,
            a.version.name,
            a.version.category.name,
            a.owningDepartment.name,
            a.serialNumber,
            [a.brand, a.model].filter(Boolean).join(' '),
            a.purchasePrice != null ? Number(a.purchasePrice) : null,
            a.priceEstimated ? 'Yes' : '',
            a.purchaseDate,
            a.source,
            a.status,
            a.condition,
            a.store?.name,
            a.location?.name,
            a.custodian
              ? `${a.custodian.employeeNumber} ${fullName(a.custodian)}`
              : null,
            a.vehicle?.registrationNumber,
          ]),
        };
      },
    },
    'stock-on-hand': {
      name: 'Stock on hand',
      description:
        'On hand, reserved, available, in quarantine, out and in transit per store and product; below-reorder flag',
      permission: 'stock.view',
      build: async (user) => {
        const rows = await this.assets.levels(user, {});
        return {
          title: 'Stock on hand',
          columns: [
            { header: 'Store', width: 18 },
            { header: 'Product code', width: 12 },
            { header: 'Product', width: 32 },
            { header: 'Category', width: 20 },
            { header: 'Owning department', width: 22 },
            { header: 'Unit', width: 8 },
            { header: 'On hand', width: 10 },
            { header: 'Reserved', width: 10 },
            { header: 'Available', width: 10 },
            { header: 'In quarantine', width: 12 },
            { header: 'Out', width: 8 },
            { header: 'In transit', width: 10 },
            { header: 'Reorder level', width: 12 },
            { header: 'Below reorder', width: 12 },
          ],
          rows: rows.map((r) => [
            r.store.name,
            r.productCode,
            r.productName,
            r.categoryName,
            r.departmentName,
            r.unit,
            r.onHand,
            r.reserved,
            r.available,
            r.quarantine,
            r.out,
            r.inTransit,
            r.reorderLevel,
            r.belowReorder ? 'Yes' : '',
          ]),
        };
      },
    },
    transfers: {
      name: 'Transfers',
      description:
        'Transfers by status, with in-transit, overdue and discrepancy flags',
      permission: 'stock.view',
      build: async (user) => {
        const ids = await this.storeIds(user);
        const rows = await this.prisma.db.transfer.findMany({
          where: ids
            ? { OR: [{ fromStoreId: { in: ids } }, { toStoreId: { in: ids } }] }
            : {},
          include: { fromStore: true, toStore: true, lines: true },
          orderBy: { createdAt: 'desc' },
        });
        const now = new Date();
        return {
          title: 'Transfers',
          columns: [
            { header: 'Number', width: 16 },
            { header: 'From', width: 18 },
            { header: 'To', width: 18 },
            { header: 'Reason', width: 14 },
            { header: 'Status', width: 14 },
            { header: 'Lines', width: 8 },
            { header: 'Dispatched', width: 16, format: 'datetime' },
            { header: 'Expected', width: 16, format: 'datetime' },
            { header: 'Received', width: 16, format: 'datetime' },
            { header: 'Overdue', width: 9 },
            { header: 'Short (units)', width: 12 },
          ],
          rows: rows.map((t) => [
            t.number,
            t.fromStore.name,
            t.toStore.name,
            t.reason,
            t.status,
            t.lines.length,
            t.dispatchedAt,
            t.expectedArrival,
            t.receivedAt,
            t.status === 'DISPATCHED' &&
            t.expectedArrival &&
            t.expectedArrival < now
              ? 'Yes'
              : '',
            t.lines.reduce(
              (n, l) =>
                n + Math.max((l.dispatchedQty ?? 0) - (l.receivedQty ?? 0), 0),
              0,
            ) || null,
          ]),
        };
      },
    },
    'count-variances': {
      name: 'Stock count variances',
      description: 'Every line with a difference between expected and counted',
      permission: 'stock.view',
      build: async (user) => {
        const ids = await this.storeIds(user);
        const counts = await this.prisma.db.stockCount.findMany({
          where: {
            status: { in: ['IN_APPROVAL', 'APPROVED', 'REJECTED'] },
            ...(ids ? { storeId: { in: ids } } : {}),
          },
          include: { lines: true },
          orderBy: { createdAt: 'desc' },
        });
        const products = await this.prisma.db.product.findMany({
          include: { currentVersion: true },
        });
        const pBy = new Map(products.map((p) => [p.id, p]));
        const stores = await this.prisma.db.store.findMany();
        const sBy = new Map(stores.map((x) => [x.id, x.name]));
        const assets = await this.prisma.db.asset.findMany({
          where: {
            id: {
              in: counts
                .flatMap((c) => c.lines.map((l) => l.assetId))
                .filter((x): x is number => !!x),
            },
          },
          select: { id: true, tag: true },
        });
        const aBy = new Map(assets.map((a) => [a.id, a.tag]));
        return {
          title: 'Stock count variances',
          columns: [
            { header: 'Count', width: 16 },
            { header: 'Store', width: 18 },
            { header: 'Status', width: 12 },
            { header: 'Product code', width: 12 },
            { header: 'Product', width: 30 },
            { header: 'Asset tag', width: 18 },
            { header: 'Batch', width: 12 },
            { header: 'Expected', width: 10 },
            { header: 'Counted', width: 10 },
            { header: 'Variance', width: 10 },
          ],
          rows: counts.flatMap((c) =>
            c.lines
              .filter((l) => l.countedQty !== l.expectedQty)
              .map((l) => [
                c.number,
                sBy.get(c.storeId),
                c.status,
                pBy.get(l.productId)?.code,
                pBy.get(l.productId)?.currentVersion?.name,
                l.assetId ? aBy.get(l.assetId) : null,
                l.batchNumber,
                l.expectedQty,
                l.countedQty,
                (l.countedQty ?? 0) - l.expectedQty,
              ]),
          ),
        };
      },
    },
    'maintenance-downtime': {
      name: 'Maintenance and downtime',
      description:
        'Tickets with source, internal / vendor repair and hours out of service (no costs, #21)',
      permission: 'asset.view',
      build: async (user) => {
        const assetRows = await this.assets.exportRows(user, {});
        const aBy = new Map(assetRows.map((a) => [a.id, a]));
        const rows = await this.prisma.db.maintenanceTicket.findMany({
          where: { assetId: { in: [...aBy.keys()] } },
          orderBy: { createdAt: 'desc' },
        });
        const now = Date.now();
        return {
          title: 'Maintenance and downtime',
          columns: [
            { header: 'Ticket', width: 16 },
            { header: 'Tag', width: 18 },
            { header: 'Product', width: 28 },
            { header: 'Source', width: 16 },
            { header: 'Status', width: 12 },
            { header: 'Repair', width: 22 },
            { header: 'Under warranty', width: 10 },
            { header: 'Opened', width: 16, format: 'datetime' },
            { header: 'Closed', width: 16, format: 'datetime' },
            { header: 'Downtime (hours)', width: 12 },
          ],
          rows: rows.map((t) => {
            const a = aBy.get(t.assetId)!;
            return [
              t.number,
              a.tag,
              a.version.name,
              t.source,
              t.status,
              t.external ? `Vendor: ${t.vendorName ?? ''}` : 'Internal',
              t.underWarranty ? 'Yes' : '',
              t.createdAt,
              t.completedAt,
              t.startedAt
                ? Math.round(
                    ((t.completedAt?.getTime() ?? now) -
                      t.startedAt.getTime()) /
                      3600_000,
                  )
                : null,
            ];
          }),
        };
      },
    },
    'adjustments-disposals': {
      name: 'Adjustments and disposals',
      description: 'Stock adjustments and asset disposals with their status',
      permission: 'stock.view',
      build: async (user) => {
        const ids = await this.storeIds(user);
        const [adjs, disposals] = await Promise.all([
          this.prisma.db.stockAdjustment.findMany({
            where: ids ? { storeId: { in: ids } } : {},
            include: { store: true, lines: true },
            orderBy: { createdAt: 'desc' },
          }),
          this.prisma.db.disposal.findMany({ orderBy: { createdAt: 'desc' } }),
        ]);
        const visible = new Set(
          (await this.assets.exportRows(user, {})).map((a) => a.id),
        );
        const assets = await this.prisma.db.asset.findMany({
          where: { id: { in: disposals.map((d) => d.assetId) } },
          include: { version: true, store: true },
        });
        const aBy = new Map(assets.map((a) => [a.id, a]));
        return {
          title: 'Adjustments and disposals',
          columns: [
            { header: 'Number', width: 16 },
            { header: 'Kind', width: 16 },
            { header: 'Store', width: 18 },
            { header: 'Status', width: 12 },
            { header: 'Detail', width: 40 },
            { header: 'Reason', width: 40 },
            { header: 'Date', width: 16, format: 'datetime' },
          ],
          rows: [
            ...adjs.map((a) => [
              a.number,
              `Adjustment: ${a.type}`,
              a.store.name,
              a.status,
              `${a.lines.length} lines, ${a.lines.filter((l) => l.asset).length} assets`,
              a.reason,
              a.createdAt,
            ]),
            ...disposals
              .filter((d) => visible.has(d.assetId))
              .map((d) => {
                const a = aBy.get(d.assetId)!;
                return [
                  d.number,
                  `Disposal: ${d.method}`,
                  a.store?.name,
                  d.status,
                  `${a.tag} ${a.version.name}`,
                  d.reason,
                  d.createdAt,
                ];
              }),
          ],
        };
      },
    },
    'assets-out': {
      name: 'Assets out and missing',
      description:
        'Assets with employees, productions, in repair, in transit, missing or lost',
      permission: 'asset.view',
      build: async (user) => {
        const rows = await this.assets.exportRows(user, {
          statuses: [
            'ASSIGNED_TO_EMPLOYEE',
            'CHECKED_OUT_TO_PRODUCTION',
            'UNDER_MAINTENANCE',
            'AT_VENDOR_FOR_REPAIR',
            'IN_TRANSIT',
            'MISSING',
            'LOST',
          ],
        });
        return {
          title: 'Assets out and missing',
          columns: [
            { header: 'Tag', width: 18 },
            { header: 'Product', width: 30 },
            { header: 'Status', width: 22 },
            { header: 'Held by', width: 26 },
            { header: 'Store', width: 18 },
            { header: 'Owning department', width: 22 },
          ],
          rows: rows.map((a) => [
            a.tag,
            a.version.name,
            a.status,
            a.custodian
              ? `${a.custodian.employeeNumber} ${fullName(a.custodian)}`
              : null,
            a.store?.name,
            a.owningDepartment.name,
          ]),
        };
      },
    },
    'warranty-expiring': {
      name: 'Warranty expiring',
      description: 'Assets whose warranty ends within N days',
      permission: 'asset.view',
      params: [
        { key: 'days', label: 'Within days (default 90)', type: 'number' },
      ],
      build: async (user, p) => {
        const days = Number(p.days) > 0 ? Number(p.days) : 90;
        const limit = new Date(Date.now() + days * 86_400_000);
        const today = new Date(Date.now() - 86_400_000);
        const rows = (await this.assets.exportRows(user, {})).filter(
          (a) =>
            a.warrantyExpiry &&
            a.warrantyExpiry >= today &&
            a.warrantyExpiry <= limit,
        );
        return {
          title: `Warranty ending within ${days} days`,
          columns: [
            { header: 'Tag', width: 18 },
            { header: 'Product', width: 30 },
            { header: 'Serial', width: 18 },
            { header: 'Warranty expiry', width: 14, format: 'date' },
            { header: 'Vendor', width: 22 },
            { header: 'Status', width: 18 },
          ],
          rows: rows.map((a) => [
            a.tag,
            a.version.name,
            a.serialNumber,
            a.warrantyExpiry,
            a.vendorRef,
            a.status,
          ]),
        };
      },
    },
    'custody-register': {
      name: 'Items in custody',
      description:
        'Items held by employees, by custodian and department, with unacknowledged, overdue-return and inspection-due flags',
      permission: 'custody.view',
      build: async (user) => {
        const s = await this.access.resolveScope(user, 'custody.view');
        const emps = s.all
          ? null
          : await this.prisma.db.employee.findMany({
              where: {
                OR: [
                  { departmentId: { in: s.departmentIds } },
                  { id: user.employeeId ?? -1 },
                ],
              },
              select: { id: true },
            });
        const rows = await this.prisma.db.custody.findMany({
          where: {
            toAt: null,
            ...(emps
              ? { custodianEmployeeId: { in: emps.map((e) => e.id) } }
              : {}),
          },
          orderBy: { fromAt: 'asc' },
        });
        const [assets, employees, handovers, inspections] = await Promise.all([
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
          }),
          this.prisma.db.assetInspection.findMany({
            where: { assetId: { in: rows.map((r) => r.assetId) } },
            orderBy: { at: 'desc' },
          }),
        ]);
        const by = <T extends { id: number }>(l: T[]) =>
          new Map(l.map((x) => [x.id, x]));
        const [aB, eB, hB] = [by(assets), by(employees), by(handovers)];
        const now = Date.now();
        return {
          title: 'Items in custody',
          columns: [
            { header: 'Department', width: 20 },
            { header: 'Employee no.', width: 12 },
            { header: 'Custodian', width: 24 },
            { header: 'Tag', width: 18 },
            { header: 'Product', width: 30 },
            { header: 'Condition', width: 14 },
            { header: 'Since', width: 12, format: 'date' },
            { header: 'Handover', width: 16 },
            { header: 'Acknowledged', width: 12 },
            { header: 'Return by', width: 12, format: 'date' },
            { header: 'Overdue', width: 9 },
            { header: 'Next inspection', width: 14, format: 'date' },
          ],
          rows: rows.map((c) => {
            const a = aB.get(c.assetId)!;
            const e = eB.get(c.custodianEmployeeId)!;
            const h = hB.get(c.handoverId);
            const months = a.version.category.inspectionMonths;
            let next: Date | null = null;
            if (months && !a.parentAssetId) {
              next = new Date(
                inspections.find((i) => i.assetId === a.id)?.at ?? c.fromAt,
              );
              next.setMonth(next.getMonth() + months);
            }
            return [
              e.department.name,
              e.employeeNumber,
              fullName(e),
              a.tag,
              a.version.name,
              a.condition,
              c.fromAt,
              h?.number,
              h?.acknowledgedAt ? 'Yes' : 'No',
              h?.expectedReturnDate,
              h?.expectedReturnDate && h.expectedReturnDate.getTime() < now
                ? 'Yes'
                : '',
              next,
            ];
          }),
        };
      },
    },
    'handover-register': {
      name: 'Handover register',
      description:
        'Every handover with source request, custodian, status and acknowledgement method',
      permission: 'handover.view',
      build: async (user) => {
        const s = await this.access.resolveScope(user, 'handover.view');
        const rows = await this.prisma.db.handover.findMany({
          where: s.all
            ? {}
            : {
                OR: [
                  { custodianDepartmentId: { in: s.departmentIds } },
                  { custodianEmployeeId: user.employeeId ?? -1 },
                ],
              },
          include: { lines: true },
          orderBy: { createdAt: 'desc' },
        });
        const [emps, stores] = await Promise.all([
          this.prisma.db.employee.findMany({
            where: { id: { in: rows.map((r) => r.custodianEmployeeId) } },
          }),
          this.prisma.db.store.findMany(),
        ]);
        const eB = new Map(emps.map((e) => [e.id, e]));
        const sB = new Map(stores.map((x) => [x.id, x.name]));
        return {
          title: 'Handover register',
          columns: [
            { header: 'Number', width: 16 },
            { header: 'Date', width: 16, format: 'datetime' },
            { header: 'Custodian', width: 24 },
            { header: 'Store', width: 18 },
            { header: 'Source', width: 18 },
            { header: 'Reference', width: 16 },
            { header: 'Items', width: 8 },
            { header: 'Status', width: 22 },
            { header: 'Acknowledged', width: 16, format: 'datetime' },
            { header: 'Method', width: 14 },
          ],
          rows: rows.map((h) => [
            h.number,
            h.createdAt,
            fullName(eB.get(h.custodianEmployeeId)!),
            sB.get(h.storeId),
            h.source,
            h.sourceRef,
            h.lines.length,
            h.status,
            h.acknowledgedAt,
            h.ackMethod,
          ]),
        };
      },
    },
    'asset-incidents': {
      name: 'Fault, damage, loss and theft reports',
      description:
        'Reports with their status and the responsibility decision (no amounts)',
      permission: 'custody.view',
      build: async () => {
        const rows = await this.prisma.db.assetReport.findMany({
          orderBy: { createdAt: 'desc' },
        });
        const [assets, emps] = await Promise.all([
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
        ]);
        const aB = new Map(assets.map((a) => [a.id, a]));
        const eB = new Map(emps.map((e) => [e.id, e]));
        return {
          title: 'Fault, damage, loss and theft reports',
          columns: [
            { header: 'Number', width: 16 },
            { header: 'Type', width: 10 },
            { header: 'Occurred', width: 16, format: 'datetime' },
            { header: 'Tag', width: 18 },
            { header: 'Product', width: 28 },
            { header: 'Custodian', width: 24 },
            { header: 'Status', width: 12 },
            { header: 'Responsibility', width: 20 },
            { header: 'Decision status', width: 14 },
            { header: 'Circumstances', width: 50 },
          ],
          rows: rows.map((r) => {
            const a = aB.get(r.assetId)!;
            const e = r.custodianEmployeeId
              ? eB.get(r.custodianEmployeeId)
              : undefined;
            return [
              r.number,
              r.type,
              r.occurredAt,
              a.tag,
              a.version.name,
              e ? fullName(e) : null,
              r.status,
              r.responsibility,
              r.responsibilityStatus,
              r.circumstances,
            ];
          }),
        };
      },
    },
    'vehicle-documents': {
      name: 'Vehicles with expiring documents',
      description:
        'Insurance and road licence expiring within N days (or expired)',
      permission: 'asset.view',
      params: [
        { key: 'days', label: 'Within days (default 60)', type: 'number' },
      ],
      build: async (user, p) => {
        const days = Number(p.days) > 0 ? Number(p.days) : 60;
        const limit = new Date(Date.now() + days * 86_400_000);
        const rows = (
          await this.assets.exportRows(user, { vehiclesOnly: true })
        ).filter(
          (a) =>
            a.vehicle &&
            ((a.vehicle.insuranceExpiry &&
              a.vehicle.insuranceExpiry <= limit) ||
              (a.vehicle.roadLicenceExpiry &&
                a.vehicle.roadLicenceExpiry <= limit)),
        );
        return {
          title: `Vehicles with documents expiring within ${days} days`,
          columns: [
            { header: 'Registration', width: 14 },
            { header: 'Tag', width: 18 },
            { header: 'Vehicle', width: 30 },
            { header: 'Insurance expiry', width: 14, format: 'date' },
            { header: 'Road licence expiry', width: 16, format: 'date' },
            { header: 'Status', width: 18 },
            { header: 'Store', width: 18 },
          ],
          rows: rows.map((a) => [
            a.vehicle!.registrationNumber,
            a.tag,
            [a.version.name, a.brand, a.model].filter(Boolean).join(' · '),
            a.vehicle!.insuranceExpiry,
            a.vehicle!.roadLicenceExpiry,
            a.status,
            a.store?.name,
          ]),
        };
      },
    },
  };

  /** Stores whose stock the user sees (null = all). */
  private async storeIds(user: CurrentUser): Promise<number[] | null> {
    const scope = await this.stores.stockScope(user);
    return scope.all ? null : scope.storeIds;
  }

  /** Reports the user may run. */
  async available(user: CurrentUser) {
    const out: {
      code: string;
      name: string;
      description: string;
      params: NonNullable<ReportDefinition['params']>;
    }[] = [];
    for (const [code, r] of Object.entries(this.reports)) {
      if (await this.access.hasAny(user, r.permission)) {
        out.push({
          code,
          name: r.name,
          description: r.description,
          params: r.params ?? [],
        });
      }
    }
    return out;
  }

  async excel(user: CurrentUser, code: string, params: ReportParams) {
    const def = this.reports[code];
    if (!def) throw new NotFoundException('errors.record_not_found');
    if (!(await this.access.hasAny(user, def.permission))) {
      throw new ForbiddenException('errors.forbidden');
    }
    const table = await def.build(user, params);
    // Exports are audited (employee.view_personal, spec §14).
    await this.audit.log({
      action: 'report.export',
      entityType: 'Report',
      entityId: code,
      after: { params, rows: table.rows.length },
    });
    return {
      fileName: `${code}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      buffer: await this.toXlsx(table, user),
    };
  }

  private async toXlsx(t: Table, user: CurrentUser): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'AzamTV Management';
    const ws = wb.addWorksheet(
      t.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ''),
    );
    ws.getCell('A1').value = t.title;
    ws.getCell('A1').font = { bold: true, size: 14 };
    const stamp = new Date().toLocaleString('en-GB', {
      timeZone: 'Africa/Dar_es_Salaam',
    });
    ws.getCell('A2').value = `Generated ${stamp} EAT by ${user.email}`;
    ws.getCell('A2').font = { color: { argb: 'FF6B7280' } };
    (t.notes ?? []).forEach((n, i) => {
      ws.getCell(`A${3 + i}`).value = n;
      ws.getCell(`A${3 + i}`).font = { color: { argb: 'FF6B7280' } };
    });
    const headerRow = 4 + (t.notes?.length ?? 0);
    const header = ws.getRow(headerRow);
    t.columns.forEach((c, i) => {
      const cell = header.getCell(i + 1);
      cell.value = c.header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1F2937' },
      };
      ws.getColumn(i + 1).width = c.width ?? 16;
      if (c.format === 'date') ws.getColumn(i + 1).numFmt = 'dd/mm/yyyy';
      if (c.format === 'datetime')
        ws.getColumn(i + 1).numFmt = 'dd/mm/yyyy hh:mm';
    });
    t.rows.forEach((r, i) => {
      const row = ws.getRow(headerRow + 1 + i);
      r.forEach((v, j) => {
        // Timestamps shown in EAT (UTC+3); Excel has no time zones.
        row.getCell(j + 1).value =
          v instanceof Date && t.columns[j].format === 'datetime'
            ? new Date(v.getTime() + 3 * 3_600_000)
            : (v ?? '');
        if (typeof v === 'string' && v.includes('\n')) {
          row.getCell(j + 1).alignment = { wrapText: true, vertical: 'top' };
        }
      });
    });
    ws.views = [{ state: 'frozen', ySplit: headerRow }];
    ws.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: headerRow, column: t.columns.length },
    };
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
