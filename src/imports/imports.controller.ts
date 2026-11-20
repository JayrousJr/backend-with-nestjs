import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthUser } from '@common';
import type { CurrentUser } from '@common';
import { RequirePermission } from '@access';
import {
  EmployeeImportService,
  type ImportRow,
} from './employee-import.service';

const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_BYTES = 10 * 1024 * 1024;

type Batch = Awaited<ReturnType<EmployeeImportService['get']>>;

/** Summary + errors + a preview of the first rows (never the file bytes). */
function present(b: Batch & { rows?: unknown }) {
  const rows = (b.rows ?? []) as unknown as ImportRow[];
  return {
    uniqueId: b.uniqueId,
    status: b.status,
    fileName: b.fileName,
    totalRows: b.totalRows,
    createCount: b.createCount,
    updateCount: b.updateCount,
    errorCount: b.errorCount,
    createdAt: b.createdAt,
    committedAt: b.committedAt,
    errors: b.errors.map((e) => ({
      row: e.row,
      column: e.column,
      message: e.message,
    })),
    preview: rows.slice(0, 200).map((r) => ({
      row: r.row,
      action: r.action,
      employeeNumber: r.employeeNumber,
      name: [r.firstName, r.middleName, r.lastName].filter(Boolean).join(' '),
      companyEmail: r.companyEmail,
    })),
  };
}

@ApiTags('imports')
@ApiBearerAuth()
@Controller('imports/employees')
export class ImportsController {
  constructor(private readonly employees: EmployeeImportService) {}

  @RequirePermission('employee.import')
  @Get('template')
  async template(@Res() res: Response) {
    const buf = await this.employees.template();
    res
      .set({
        'Content-Type': XLSX,
        'Content-Disposition':
          'attachment; filename="azamtv-employee-import.xlsx"',
      })
      .send(buf);
  }

  @RequirePermission('employee.import')
  @Get()
  history() {
    return this.employees.history();
  }

  @RequirePermission('employee.import')
  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async upload(
    @AuthUser() user: CurrentUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('errors.file_required');
    if (!/\.xlsx$/i.test(file.originalname)) {
      throw new BadRequestException('errors.import_not_excel');
    }
    return present(
      await this.employees.upload(user, file.originalname, file.buffer),
    );
  }

  @RequirePermission('employee.import')
  @Get(':uniqueId')
  async get(@Param('uniqueId') uniqueId: string) {
    return present(await this.employees.get(uniqueId));
  }

  @RequirePermission('employee.import')
  @Post(':uniqueId/commit')
  @HttpCode(HttpStatus.OK)
  async commit(
    @AuthUser() user: CurrentUser,
    @Param('uniqueId') uniqueId: string,
  ) {
    return present(await this.employees.commit(user, uniqueId));
  }

  @RequirePermission('employee.import')
  @Get(':uniqueId/errors')
  async errors(@Param('uniqueId') uniqueId: string, @Res() res: Response) {
    const buf = await this.employees.errorReport(uniqueId);
    res
      .set({
        'Content-Type': XLSX,
        'Content-Disposition':
          'attachment; filename="employee-import-errors.xlsx"',
      })
      .send(buf);
  }
}
