import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
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
import { XLSX_MIME } from '../imports/excel';
import { ProductImportService } from './product-import.service';

const MAX_BYTES = 10 * 1024 * 1024;

type Batch = Awaited<ReturnType<ProductImportService['get']>>;

@ApiTags('imports')
@ApiBearerAuth()
@Controller('imports/products')
export class ProductImportController {
  constructor(private readonly service: ProductImportService) {}

  private present(b: Batch) {
    return {
      uniqueId: b.uniqueId,
      status: b.status,
      fileName: b.fileName,
      totalRows: b.totalRows,
      createCount: b.createCount,
      errorCount: b.errorCount,
      createdAt: b.createdAt,
      committedAt: b.committedAt,
      errors: b.errors.map((e) => ({
        row: e.row,
        column: e.column,
        message: e.message,
      })),
      preview: this.service.preview(b.rows),
    };
  }

  @RequirePermission('item.import')
  @Get('template')
  async template(
    @AuthUser() user: CurrentUser,
    @Res() res: Response,
    @Query('departmentUniqueId') departmentUniqueId?: string,
  ) {
    const { file, department } = await this.service.template(
      user,
      departmentUniqueId,
    );
    res
      .set({
        'Content-Type': XLSX_MIME,
        'Content-Disposition': `attachment; filename="azamtv-products-${department.code.toLowerCase()}.xlsx"`,
      })
      .send(file);
  }

  @RequirePermission('item.import')
  @Get()
  history(@AuthUser() user: CurrentUser) {
    return this.service.history(user);
  }

  @RequirePermission('item.import')
  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async upload(
    @AuthUser() user: CurrentUser,
    @Body('departmentUniqueId') departmentUniqueId?: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('errors.file_required');
    if (!/\.xlsx$/i.test(file.originalname)) {
      throw new BadRequestException('errors.import_not_excel');
    }
    const batch = await this.service.upload(
      user,
      file.originalname,
      file.buffer,
      departmentUniqueId || undefined,
    );
    return this.present(batch);
  }

  @RequirePermission('item.import')
  @Get(':uniqueId')
  async get(
    @AuthUser() user: CurrentUser,
    @Param('uniqueId') uniqueId: string,
  ) {
    return this.present(await this.service.get(uniqueId, user));
  }

  @RequirePermission('item.import')
  @Post(':uniqueId/commit')
  @HttpCode(HttpStatus.OK)
  async commit(
    @AuthUser() user: CurrentUser,
    @Param('uniqueId') uniqueId: string,
  ) {
    return this.present(await this.service.commit(user, uniqueId));
  }

  @RequirePermission('item.import')
  @Get(':uniqueId/errors')
  async errors(
    @AuthUser() user: CurrentUser,
    @Param('uniqueId') uniqueId: string,
    @Res() res: Response,
  ) {
    const buf = await this.service.errorReport(user, uniqueId);
    res
      .set({
        'Content-Type': XLSX_MIME,
        'Content-Disposition':
          'attachment; filename="product-import-errors.xlsx"',
      })
      .send(buf);
  }
}
