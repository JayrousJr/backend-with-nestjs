import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { Prisma } from '@db';
import { PrismaService, type DbTx } from '@prisma';
import type { CurrentUser } from '@common';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';

/** Template columns, in order. `*` marks required in the header. */
const COLUMNS = [
  {
    key: 'employeeNumber',
    header: 'Employee number',
    required: true,
    width: 16,
  },
  { key: 'firstName', header: 'First name', required: true, width: 16 },
  { key: 'middleName', header: 'Middle name', required: false, width: 16 },
  { key: 'lastName', header: 'Last name', required: true, width: 16 },
  { key: 'gender', header: 'Gender', required: true, width: 10 },
  { key: 'companyEmail', header: 'Company email', required: true, width: 30 },
  { key: 'phone', header: 'Phone', required: true, width: 18 },
  { key: 'department', header: 'Department', required: true, width: 30 },
  { key: 'jobTitle', header: 'Job title', required: true, width: 26 },
  {
    key: 'employmentType',
    header: 'Employment type',
    required: true,
    width: 18,
  },
  { key: 'startDate', header: 'Start date', required: true, width: 13 },
  {
    key: 'contractEndDate',
    header: 'Contract end date',
    required: false,
    width: 16,
  },
  {
    key: 'supervisorNumber',
    header: 'Supervisor (employee number)',
    required: false,
    width: 18,
  },
  { key: 'workLocation', header: 'Work location', required: false, width: 18 },
  {
    key: 'skills',
    header: 'Skills (comma-separated)',
    required: false,
    width: 26,
  },
  {
    key: 'qualifications',
    header: 'Qualifications (comma-separated)',
    required: false,
    width: 26,
  },
] as const;

type Key = (typeof COLUMNS)[number]['key'];
type RawRow = Partial<Record<Key, string>>;

const DATA_ROWS = 2000;
const SHEET = 'Employees';

/** A validated row, ready to write. */
export interface ImportRow {
  row: number;
  action: 'create' | 'update';
  existingId?: number;
  employeeNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  gender: 'MALE' | 'FEMALE';
  companyEmail: string;
  phone: string;
  departmentId: number;
  jobTitleId: number;
  employmentTypeId: number;
  startDate: string;
  contractEndDate: string | null;
  supervisorNumber: string | null;
  workLocation: string | null;
  skills: string[];
  qualifications: string[];
}

interface RowError {
  row: number;
  column?: string;
  message: string;
}

const lookupLabel = (code: string, name: string) => `${code} - ${name}`;
/** "CAM - Camera" → CAM; plain codes or names are accepted too. */
const lookupCode = (v: string) => v.split(' - ')[0].trim().toUpperCase();

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('richText' in value) {
      return value.richText.map((r) => r.text).join('');
    }
    if ('result' in value) return cellText(value.result);
    if ('hyperlink' in value) return String(value.hyperlink);
  }
  if (typeof value === 'object') return ''; // formula errors and other objects
  return String(value).trim();
}

/** Excel date cell, DD/MM/YYYY (AzamTV format) or YYYY-MM-DD → YYYY-MM-DD. */
function parseDate(raw: string): string | null {
  if (!raw) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  let y: number, m: number, d: number;
  if (iso) [y, m, d] = [+iso[1], +iso[2], +iso[3]];
  else if (dmy) [d, m, y] = [+dmy[1], +dmy[2], +dmy[3]];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

const list = (s?: string) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

@Injectable()
export class EmployeeImportService {
  private readonly logger = new Logger(EmployeeImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  // ── template ─────────────────────────────────────────────────────────────

  /**
   * Generated from current master data: drop-downs for departments, job
   * titles, employment types and gender; protected header row.
   */
  async template(): Promise<Buffer> {
    const [departments, jobTitles, types] = await Promise.all([
      this.prisma.db.department.findMany({
        where: { isActive: true },
        orderBy: { code: 'asc' },
      }),
      this.prisma.db.jobTitle.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.db.employmentType.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'AzamTV Management';
    wb.created = new Date();

    const ws = wb.addWorksheet(SHEET, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = COLUMNS.map((c) => ({
      header: c.required ? `${c.header} *` : c.header,
      key: c.key,
      width: c.width,
    }));
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F2937' },
    };
    header.height = 22;

    // Lists live on a hidden sheet referenced by the validations.
    const lists = wb.addWorksheet('Lists', { state: 'veryHidden' });
    const put = (col: string, title: string, values: string[]) => {
      lists.getCell(`${col}1`).value = title;
      values.forEach((v, i) => (lists.getCell(`${col}${i + 2}`).value = v));
      return `Lists!$${col}$2:$${col}$${Math.max(2, values.length + 1)}`;
    };
    const ranges: Partial<Record<Key, string>> = {
      department: put(
        'A',
        'Departments',
        departments.map((d) => lookupLabel(d.code, d.name)),
      ),
      jobTitle: put(
        'B',
        'Job titles',
        jobTitles.map((j) => lookupLabel(j.code, j.name)),
      ),
      employmentType: put(
        'C',
        'Employment types',
        types.map((t) => lookupLabel(t.code, t.name)),
      ),
      gender: put('D', 'Gender', ['Female', 'Male']),
    };

    for (let r = 2; r <= DATA_ROWS + 1; r++) {
      const row = ws.getRow(r);
      COLUMNS.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        cell.protection = { locked: false };
        const range = ranges[c.key];
        if (range) {
          cell.dataValidation = {
            type: 'list',
            allowBlank: !c.required,
            formulae: [range],
            showErrorMessage: true,
            errorTitle: 'Choose from the list',
            error: `Pick a ${c.header.toLowerCase()} from the drop-down.`,
          };
        }
        if (c.key === 'startDate' || c.key === 'contractEndDate') {
          cell.numFmt = 'dd/mm/yyyy';
          cell.dataValidation = {
            type: 'date',
            operator: 'greaterThan',
            allowBlank: !c.required,
            formulae: [new Date(1950, 0, 1)],
            showErrorMessage: true,
            error: 'Enter a date (DD/MM/YYYY).',
          };
        }
        if (
          c.key === 'employeeNumber' ||
          c.key === 'phone' ||
          c.key === 'supervisorNumber'
        ) {
          cell.numFmt = '@'; // keep leading zeros / plus signs as typed
        }
      });
    }
    // Header cells stay locked; data cells are unlocked above.
    await ws.protect('', {
      selectLockedCells: true,
      selectUnlockedCells: true,
      formatColumns: true,
      formatRows: true,
      sort: true,
      autoFilter: true,
    });

    const help = wb.addWorksheet('Instructions');
    help.getColumn(1).width = 110;
    [
      'AzamTV — employee import',
      '',
      '• Fill one employee per row on the "Employees" sheet. Columns marked * are required.',
      '• Use the drop-downs for department, job title, employment type and gender (generated from the current lists).',
      '• Company email must use an allowed AzamTV domain and be unique.',
      '• Dates as DD/MM/YYYY. Contract and intern types need a contract end date.',
      '• Supervisor = the employee number of someone already in the system or in this file.',
      '• Re-importing updates employees with the same employee number; it never deletes or exits anyone.',
      '• If any row has an error, nothing is saved. Download the error file, fix the rows and upload again.',
    ].forEach((line, i) => {
      const cell = help.getCell(`A${i + 1}`);
      cell.value = line;
      if (i === 0) cell.font = { bold: true, size: 14 };
    });

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ── parse & validate ─────────────────────────────────────────────────────

  private async readRows(
    file: Buffer,
  ): Promise<{ raw: RawRow[]; rowNumbers: number[] }> {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException('errors.import_not_excel');
    }
    const ws = wb.getWorksheet(SHEET) ?? wb.worksheets[0];
    if (!ws) throw new BadRequestException('errors.import_no_sheet');

    // Map header text → column key (tolerates the * marker and order).
    const byHeader = new Map<string, Key>(
      COLUMNS.map((c) => [c.header.toLowerCase(), c.key]),
    );
    const colKey = new Map<number, Key>();
    ws.getRow(1).eachCell((cell, col) => {
      const h = cellText(cell.value).replace(/\*/g, '').trim().toLowerCase();
      const key = byHeader.get(h);
      if (key) colKey.set(col, key);
    });
    const missing = COLUMNS.filter(
      (c) => c.required && ![...colKey.values()].includes(c.key),
    );
    if (missing.length) {
      throw new BadRequestException({
        message: 'errors.import_missing_columns',
        args: { columns: missing.map((c) => c.header).join(', ') },
      });
    }

    const raw: RawRow[] = [];
    const rowNumbers: number[] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const r: RawRow = {};
      let any = false;
      colKey.forEach((key, col) => {
        const v = cellText(row.getCell(col).value);
        if (v) any = true;
        r[key] = v;
      });
      if (any) {
        raw.push(r);
        rowNumbers.push(n);
      }
    });
    if (!raw.length) throw new BadRequestException('errors.import_empty');
    if (raw.length > DATA_ROWS * 5) {
      throw new BadRequestException('errors.import_too_large');
    }
    return { raw, rowNumbers };
  }

  /** Validate every row against master data. Never writes. */
  async validate(file: Buffer, tx?: DbTx) {
    const db = tx ?? this.prisma.db;
    const { raw, rowNumbers } = await this.readRows(file);
    const [departments, jobTitles, types, domains] = await Promise.all([
      db.department.findMany({ where: { isActive: true, isDeleted: false } }),
      db.jobTitle.findMany({ where: { isActive: true, isDeleted: false } }),
      db.employmentType.findMany({
        where: { isActive: true, isDeleted: false },
      }),
      this.policy.allowedEmailDomains(),
    ]);
    const findLookup = <T extends { code: string; name: string }>(
      items: T[],
      v: string,
    ) =>
      items.find((x) => x.code === lookupCode(v)) ??
      items.find((x) => x.name.toLowerCase() === v.trim().toLowerCase());

    const numbers = raw.map((r) => (r.employeeNumber ?? '').trim());
    const emails = raw.map((r) => (r.companyEmail ?? '').trim().toLowerCase());
    const existing = await db.employee.findMany({
      where: {
        OR: [
          { employeeNumber: { in: numbers.filter(Boolean) } },
          { companyEmail: { in: emails.filter(Boolean) } },
        ],
      },
      select: { id: true, employeeNumber: true, companyEmail: true },
    });
    const supervisorsInDb = new Set(
      (
        await db.employee.findMany({
          where: {
            employeeNumber: {
              in: raw.map((r) => r.supervisorNumber ?? '').filter(Boolean),
            },
          },
          select: { employeeNumber: true },
        })
      ).map((e) => e.employeeNumber),
    );

    const errors: RowError[] = [];
    const rows: ImportRow[] = [];
    const seenNumbers = new Map<string, number>();
    const seenEmails = new Map<string, number>();

    raw.forEach((r, i) => {
      const rowNo = rowNumbers[i];
      const err = (column: Key | undefined, message: string) =>
        errors.push({
          row: rowNo,
          column: column && COLUMNS.find((c) => c.key === column)?.header,
          message,
        });

      for (const c of COLUMNS) {
        if (c.required && !(r[c.key] ?? '').trim()) err(c.key, 'Required');
      }

      const number = (r.employeeNumber ?? '').trim();
      if (number && !/^[A-Za-z0-9/_-]{1,30}$/.test(number)) {
        err('employeeNumber', 'Letters, numbers, / _ - only (max 30)');
      }
      if (number) {
        const first = seenNumbers.get(number);
        if (first) err('employeeNumber', `Duplicate of row ${first}`);
        else seenNumbers.set(number, rowNo);
      }

      const email = (r.companyEmail ?? '').trim().toLowerCase();
      if (email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          err('companyEmail', 'Not a valid email');
        } else if (!domains.includes(email.split('@')[1])) {
          err('companyEmail', `Domain must be one of: ${domains.join(', ')}`);
        }
        const first = seenEmails.get(email);
        if (first) err('companyEmail', `Duplicate of row ${first}`);
        else seenEmails.set(email, rowNo);
        const owner = existing.find((e) => e.companyEmail === email);
        if (owner && owner.employeeNumber !== number) {
          err(
            'companyEmail',
            `Already used by employee ${owner.employeeNumber}`,
          );
        }
      }

      const phone = (r.phone ?? '').trim();
      if (phone && !/^\+?[0-9 ]{9,16}$/.test(phone)) {
        err('phone', 'Use a phone number like +255 700 000 000');
      }

      const genderRaw = (r.gender ?? '').trim().toUpperCase();
      const gender =
        genderRaw === 'MALE' || genderRaw === 'M'
          ? 'MALE'
          : genderRaw === 'FEMALE' || genderRaw === 'F'
            ? 'FEMALE'
            : null;
      if (genderRaw && !gender) err('gender', 'Female or Male');

      const dept = r.department
        ? findLookup(departments, r.department)
        : undefined;
      if (r.department && !dept) err('department', 'Unknown department');
      const title = r.jobTitle ? findLookup(jobTitles, r.jobTitle) : undefined;
      if (r.jobTitle && !title) err('jobTitle', 'Unknown job title');
      const type = r.employmentType
        ? findLookup(types, r.employmentType)
        : undefined;
      if (r.employmentType && !type)
        err('employmentType', 'Unknown employment type');

      const start = parseDate(r.startDate ?? '');
      if (r.startDate && !start) err('startDate', 'Use DD/MM/YYYY');
      const end = parseDate(r.contractEndDate ?? '');
      if (r.contractEndDate && !end) err('contractEndDate', 'Use DD/MM/YYYY');
      if (type?.requiresEndDate && !r.contractEndDate) {
        err('contractEndDate', `Required for ${type.name}`);
      }
      if (start && end && end < start) {
        err('contractEndDate', 'Must be after the start date');
      }

      const sup = (r.supervisorNumber ?? '').trim();
      if (sup) {
        if (sup === number)
          err('supervisorNumber', 'Cannot supervise themselves');
        else if (!supervisorsInDb.has(sup) && !numbers.includes(sup)) {
          err('supervisorNumber', 'No employee with this number');
        }
      }

      if (dept && title && type && start && gender && number && email) {
        const match = existing.find((e) => e.employeeNumber === number);
        rows.push({
          row: rowNo,
          action: match ? 'update' : 'create',
          existingId: match?.id,
          employeeNumber: number,
          firstName: (r.firstName ?? '').trim(),
          middleName: (r.middleName ?? '').trim() || null,
          lastName: (r.lastName ?? '').trim(),
          gender,
          companyEmail: email,
          phone,
          departmentId: dept.id,
          jobTitleId: title.id,
          employmentTypeId: type.id,
          startDate: start,
          contractEndDate: end,
          supervisorNumber: sup || null,
          workLocation: (r.workLocation ?? '').trim() || null,
          skills: list(r.skills),
          qualifications: list(r.qualifications),
        });
      }
    });

    return { rows, errors, totalRows: raw.length };
  }

  // ── pipeline ─────────────────────────────────────────────────────────────

  /** Upload: validate every row and keep the file; nothing is applied yet. */
  async upload(actor: CurrentUser, fileName: string, file: Buffer) {
    const { rows, errors, totalRows } = await this.validate(file);
    const batch = await this.prisma.dbRaw.importBatch.create({
      data: {
        type: 'EMPLOYEE',
        status: errors.length ? 'FAILED' : 'VALIDATED',
        fileName: fileName.slice(0, 200),
        file: new Uint8Array(file),
        totalRows,
        createCount: rows.filter((r) => r.action === 'create').length,
        updateCount: rows.filter((r) => r.action === 'update').length,
        errorCount: errors.length,
        rows: rows as unknown as Prisma.InputJsonValue,
        uploadedById: actor.id,
        errors: { create: errors },
      },
      include: { errors: { orderBy: [{ row: 'asc' }, { id: 'asc' }] } },
    });
    await this.audit.log({
      action: 'employee.import_upload',
      entityType: 'ImportBatch',
      entityId: batch.uniqueId,
      after: {
        fileName: batch.fileName,
        status: batch.status,
        totalRows,
        errors: errors.length,
      },
    });
    return batch;
  }

  /**
   * Commit in one transaction, upsert by employee number. Re-validates the
   * stored file inside the transaction so nothing changed since the preview
   * can slip through. Imports never delete or exit employees.
   */
  async commit(actor: CurrentUser, uniqueId: string) {
    const batch = await this.prisma.dbRaw.importBatch.findUnique({
      where: { uniqueId },
    });
    if (!batch || batch.type !== 'EMPLOYEE') {
      throw new NotFoundException('errors.record_not_found');
    }
    if (batch.status !== 'VALIDATED') {
      throw new BadRequestException('errors.import_not_committable');
    }

    const result = await this.prisma.db.$transaction(
      async (tx) => {
        const { rows, errors } = await this.validate(
          Buffer.from(batch.file),
          tx,
        );
        if (errors.length) {
          throw new BadRequestException('errors.import_changed');
        }
        const now = new Date();
        const ids = new Map<string, number>();
        const before = new Map(
          (
            await tx.employee.findMany({
              where: { id: { in: rows.flatMap((r) => r.existingId ?? []) } },
              include: {
                department: true,
                jobTitle: true,
                employmentType: true,
                supervisor: true,
              },
            })
          ).map((e) => [e.id, e]),
        );

        for (const r of rows) {
          const data = {
            firstName: r.firstName,
            middleName: r.middleName,
            lastName: r.lastName,
            gender: r.gender,
            companyEmail: r.companyEmail,
            phone: r.phone,
            departmentId: r.departmentId,
            jobTitleId: r.jobTitleId,
            employmentTypeId: r.employmentTypeId,
            contractEndDate: r.contractEndDate
              ? new Date(r.contractEndDate)
              : null,
            ...(r.workLocation && { workLocation: r.workLocation }),
            ...(r.skills.length && { skills: r.skills }),
            ...(r.qualifications.length && {
              qualifications: r.qualifications,
            }),
          };
          if (r.existingId) {
            await tx.employee.update({
              where: { id: r.existingId },
              data: { ...data, updatedById: actor.id },
            });
            ids.set(r.employeeNumber, r.existingId);
            // The login email follows the company email.
            await tx.user.updateMany({
              where: { employeeId: r.existingId },
              data: { email: r.companyEmail },
            });
          } else {
            const created = await tx.employee.create({
              data: {
                ...data,
                employeeNumber: r.employeeNumber,
                startDate: new Date(r.startDate),
                createdById: actor.id,
              },
            });
            ids.set(r.employeeNumber, created.id);
          }
        }

        // Supervisors second: they may be rows of this same file.
        for (const r of rows) {
          if (!r.supervisorNumber) continue;
          let supId = ids.get(r.supervisorNumber);
          if (!supId) {
            supId = (
              await tx.employee.findUniqueOrThrow({
                where: { employeeNumber: r.supervisorNumber },
              })
            ).id;
          }
          await tx.employee.update({
            where: { id: ids.get(r.employeeNumber)! },
            data: { supervisorId: supId },
          });
        }

        // History for tracked changes on updated employees.
        const after = await tx.employee.findMany({
          where: { id: { in: [...before.keys()] } },
          include: {
            department: true,
            jobTitle: true,
            employmentType: true,
            supervisor: true,
          },
        });
        const reason = `Import ${batch.fileName}`;
        const history: Prisma.EmployeeHistoryCreateManyInput[] = [];
        for (const a of after) {
          const b = before.get(a.id)!;
          const name = (e: typeof a.supervisor) =>
            e ? `${e.firstName} ${e.lastName}` : null;
          const pairs: [string, string | null, string | null][] = [
            ['department', b.department.name, a.department.name],
            ['jobTitle', b.jobTitle.name, a.jobTitle.name],
            ['employmentType', b.employmentType.name, a.employmentType.name],
            ['supervisor', name(b.supervisor), name(a.supervisor)],
            ['companyEmail', b.companyEmail, a.companyEmail],
          ];
          for (const [field, oldValue, newValue] of pairs) {
            if (oldValue !== newValue) {
              history.push({
                employeeId: a.id,
                field,
                oldValue,
                newValue,
                effectiveDate: now,
                changedById: actor.id,
                reason,
              });
            }
          }
        }
        if (history.length)
          await tx.employeeHistory.createMany({ data: history });

        await tx.importBatch.update({
          where: { id: batch.id },
          data: {
            status: 'COMMITTED',
            committedById: actor.id,
            committedAt: now,
            createCount: rows.filter((r) => r.action === 'create').length,
            updateCount: rows.filter((r) => r.action === 'update').length,
          },
        });
        await this.audit.log(
          {
            action: 'employee.import_commit',
            entityType: 'ImportBatch',
            entityId: batch.uniqueId,
            after: {
              created: rows
                .filter((r) => r.action === 'create')
                .map((r) => r.employeeNumber),
              updated: rows
                .filter((r) => r.action === 'update')
                .map((r) => r.employeeNumber),
            },
          },
          tx,
        );
        return rows;
      },
      { timeout: 120_000 },
    );

    this.logger.log(`Import ${uniqueId} committed: ${result.length} rows`);
    return this.prisma.dbRaw.importBatch.findUniqueOrThrow({
      where: { uniqueId },
      include: { errors: true },
    });
  }

  /** The uploaded file with an "Errors" column added to each failing row. */
  async errorReport(uniqueId: string): Promise<Buffer> {
    const batch = await this.prisma.dbRaw.importBatch.findUnique({
      where: { uniqueId },
      include: { errors: true },
    });
    if (!batch) throw new NotFoundException('errors.record_not_found');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(batch.file) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet(SHEET) ?? wb.worksheets[0];
    ws.unprotect();
    const col = ws.actualColumnCount + 1;
    const head = ws.getRow(1).getCell(col);
    head.value = 'Errors';
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFB91C1C' },
    };
    ws.getColumn(col).width = 60;
    const byRow = new Map<number, string[]>();
    for (const e of batch.errors) {
      const msg = e.column ? `${e.column}: ${e.message}` : e.message;
      byRow.set(e.row, [...(byRow.get(e.row) ?? []), msg]);
    }
    byRow.forEach((msgs, row) => {
      const cell = ws.getRow(row).getCell(col);
      cell.value = msgs.join('; ');
      cell.font = { color: { argb: 'FFB91C1C' } };
      cell.alignment = { wrapText: true, vertical: 'top' };
    });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async history(limit = 50) {
    const rows = await this.prisma.dbRaw.importBatch.findMany({
      where: { type: 'EMPLOYEE' },
      orderBy: { createdAt: 'desc' },
      take: limit,
      omit: { file: true, rows: true },
    });
    const userIds = [
      ...new Set(
        rows.flatMap((r) => [r.uploadedById, r.committedById ?? []]).flat(),
      ),
    ] as number[];
    const users = await this.prisma.dbRaw.user.findMany({
      where: { id: { in: userIds } },
      include: { employee: true },
    });
    const name = new Map(
      users.map((u) => [
        u.id,
        `${u.employee.firstName} ${u.employee.lastName}`,
      ]),
    );
    return rows.map((r) => ({
      ...r,
      uploadedBy: name.get(r.uploadedById) ?? null,
      committedBy: r.committedById ? (name.get(r.committedById) ?? null) : null,
    }));
  }

  async get(uniqueId: string) {
    const b = await this.prisma.dbRaw.importBatch.findUnique({
      where: { uniqueId },
      omit: { file: true },
      include: { errors: { orderBy: [{ row: 'asc' }, { id: 'asc' }] } },
    });
    if (!b) throw new NotFoundException('errors.record_not_found');
    return b;
  }
}
