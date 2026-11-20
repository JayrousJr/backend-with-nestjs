import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';

/**
 * Shared helpers for the generated Excel templates (system templates with
 * drop-downs from current master data, header row locked, DD/MM/YYYY).
 */

export interface SheetColumn<K extends string = string> {
  key: K;
  header: string;
  required?: boolean;
  width?: number;
  /** Lists-sheet range for a drop-down. */
  list?: string;
  date?: boolean;
  /** Keep as typed (codes, serial numbers, leading zeros). */
  text?: boolean;
  integer?: boolean;
}

export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const lookupLabel = (code: string, name: string) => `${code} - ${name}`;
/** "CAM - Camera" → CAM; plain codes are accepted too. */
export const lookupCode = (v: string) => v.split(' - ')[0].trim().toUpperCase();

export function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('result' in value) return cellText(value.result);
    if ('hyperlink' in value) return String(value.hyperlink);
    return '';
  }
  return String(value).trim();
}

/** Excel date cell, DD/MM/YYYY or YYYY-MM-DD → YYYY-MM-DD (null if invalid). */
export function parseDate(raw: string): string | null {
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

/** Positive / non-negative number from a cell ("1,200" accepted). */
export function parseNumber(raw: string): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function newWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AzamTV Management';
  wb.created = new Date();
  return wb;
}

/** Hidden Lists sheet; returns a `put(title, values)` that gives a range. */
export function listsSheet(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet('Lists', { state: 'veryHidden' });
  let col = 0;
  return (title: string, values: string[]) => {
    col += 1;
    const letter = ws.getColumn(col).letter;
    ws.getCell(`${letter}1`).value = title;
    values.forEach((v, i) => (ws.getCell(`${letter}${i + 2}`).value = v));
    return `Lists!$${letter}$2:$${letter}$${Math.max(2, values.length + 1)}`;
  };
}

/** A data sheet with a styled, locked header and validated input cells. */
export async function addDataSheet(
  wb: ExcelJS.Workbook,
  name: string,
  columns: SheetColumn[],
  rows = 1000,
  prefill: Record<string, string | number>[] = [],
) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({
    header: c.required ? `${c.header} *` : c.header,
    key: c.key,
    width: c.width ?? 18,
  }));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F2937' },
  };
  header.height = 22;
  for (let r = 2; r <= rows + 1; r++) {
    const row = ws.getRow(r);
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.protection = { locked: false };
      if (c.list) {
        cell.dataValidation = {
          type: 'list',
          allowBlank: !c.required,
          formulae: [c.list],
          showErrorMessage: true,
          errorTitle: 'Choose from the list',
          error: `Pick a value for "${c.header}" from the drop-down.`,
        };
      } else if (c.date) {
        cell.numFmt = 'dd/mm/yyyy';
        cell.dataValidation = {
          type: 'date',
          operator: 'greaterThan',
          allowBlank: !c.required,
          formulae: [new Date(1950, 0, 1)],
          showErrorMessage: true,
          error: 'Enter a date (DD/MM/YYYY).',
        };
      } else if (c.integer) {
        cell.dataValidation = {
          type: 'whole',
          operator: 'greaterThanOrEqual',
          allowBlank: !c.required,
          formulae: [0],
          showErrorMessage: true,
          error: 'Enter a whole number.',
        };
      } else if (c.text) {
        cell.numFmt = '@';
      }
    });
    const values = prefill[r - 2];
    if (values)
      columns.forEach((c, i) => {
        if (values[c.key] != null) row.getCell(i + 1).value = values[c.key];
      });
  }
  await ws.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatColumns: true,
    formatRows: true,
    sort: true,
    autoFilter: true,
  });
  return ws;
}

export function addInstructions(wb: ExcelJS.Workbook, lines: string[]) {
  const ws = wb.addWorksheet('Instructions');
  ws.getColumn(1).width = 120;
  lines.forEach((line, i) => {
    const cell = ws.getCell(`A${i + 1}`);
    cell.value = line;
    if (i === 0) cell.font = { bold: true, size: 14 };
  });
  // Show instructions first.
  wb.views = [{ activeTab: wb.worksheets.length - 1 } as ExcelJS.WorkbookView];
  return ws;
}

export async function loadWorkbook(file: Buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(file as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException('errors.import_not_excel');
  }
  return wb;
}

/**
 * Read a sheet by header text (tolerates the * marker and column order).
 * Returns rows with their Excel row number; empty rows are skipped.
 */
export function readSheet<K extends string>(
  wb: ExcelJS.Workbook,
  name: string,
  columns: SheetColumn<K>[],
  opts: { optional?: boolean } = {},
): { row: number; values: Partial<Record<K, string>> }[] {
  const ws = wb.getWorksheet(name);
  if (!ws) {
    if (opts.optional) return [];
    throw new BadRequestException({
      message: 'errors.import_sheet_missing',
      args: { sheet: name },
    });
  }
  const byHeader = new Map<string, K>(
    columns.map((c) => [c.header.toLowerCase(), c.key]),
  );
  const colKey = new Map<number, K>();
  ws.getRow(1).eachCell((cell, col) => {
    const h = cellText(cell.value).replace(/\*/g, '').trim().toLowerCase();
    const key = byHeader.get(h);
    if (key) colKey.set(col, key);
  });
  const missing = columns.filter(
    (c) => c.required && ![...colKey.values()].includes(c.key),
  );
  if (missing.length) {
    throw new BadRequestException({
      message: 'errors.import_missing_columns',
      args: { columns: `${name}: ${missing.map((c) => c.header).join(', ')}` },
    });
  }
  const out: { row: number; values: Partial<Record<K, string>> }[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const values: Partial<Record<K, string>> = {};
    let any = false;
    colKey.forEach((key, col) => {
      const v = cellText(row.getCell(col).value);
      if (v) any = true;
      values[key] = v;
    });
    if (any) out.push({ row: n, values });
  });
  if (out.length > 10_000)
    throw new BadRequestException('errors.import_too_large');
  return out;
}

/**
 * Error file: the uploaded workbook with an "Errors" column on each failing
 * row. Errors carry their sheet in `column` as "Sheet › Column".
 */
export async function errorWorkbook(
  file: Buffer,
  errors: { row: number; column: string | null; message: string }[],
  defaultSheet: string,
) {
  const wb = await loadWorkbook(file);
  const bySheet = new Map<string, Map<number, string[]>>();
  for (const e of errors) {
    const [sheet, col] = e.column?.includes(' › ')
      ? e.column.split(' › ')
      : [defaultSheet, e.column];
    const rows = bySheet.get(sheet) ?? new Map<number, string[]>();
    const msg = col ? `${col}: ${e.message}` : e.message;
    rows.set(e.row, [...(rows.get(e.row) ?? []), msg]);
    bySheet.set(sheet, rows);
  }
  bySheet.forEach((rows, sheet) => {
    const ws = wb.getWorksheet(sheet);
    if (!ws) return;
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
    rows.forEach((msgs, r) => {
      const cell = ws.getRow(r).getCell(col);
      cell.value = msgs.join('; ');
      cell.font = { color: { argb: 'FFB91C1C' } };
      cell.alignment = { wrapText: true, vertical: 'top' };
    });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
