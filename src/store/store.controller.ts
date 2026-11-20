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
import { OpeningBalanceImportService } from './opening-balance-import.service';

const MAX_BYTES = 10 * 1024 * 1024;
type Batch = Awaited<ReturnType<OpeningBalanceImportService['get']>>;

@ApiTags('imports')
@ApiBearerAuth()
@Controller('imports/opening-balance')
export class OpeningBalanceController {
  constructor(private readonly service: OpeningBalanceImportService) {}

  private async present(b: Batch) {
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
      preview: await this.service.preview(b.rows),
    };
  }

  @RequirePermission('stock.adjust')
  @Get('template')
  async template(
    @AuthUser() user: CurrentUser,
    @Res() res: Response,
    @Query('storeUniqueId') storeUniqueId: string,
  ) {
    if (!storeUniqueId) throw new BadRequestException('errors.store_required');
    const { file, store } = await this.service.template(user, storeUniqueId);
    res
      .set({
        'Content-Type': XLSX_MIME,
        'Content-Disposition': `attachment; filename="azamtv-opening-balance-${store.code.toLowerCase()}.xlsx"`,
      })
      .send(file);
  }

  @RequirePermission('stock.adjust')
  @Get()
  history(
    @AuthUser() user: CurrentUser,
    @Query('storeUniqueId') storeUniqueId?: string,
  ) {
    return this.service.history(user, storeUniqueId || undefined);
  }

  @RequirePermission('stock.adjust')
  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async upload(
    @AuthUser() user: CurrentUser,
    @Body('storeUniqueId') storeUniqueId: string,
    @Body('reason') reason?: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('errors.file_required');
    if (!storeUniqueId) throw new BadRequestException('errors.store_required');
    if (!/\.xlsx$/i.test(file.originalname))
      throw new BadRequestException('errors.import_not_excel');
    return this.present(
      await this.service.upload(
        user,
        storeUniqueId,
        file.originalname,
        file.buffer,
        reason,
      ),
    );
  }

  @RequirePermission('stock.adjust')
  @Get(':uniqueId')
  async get(
    @AuthUser() user: CurrentUser,
    @Param('uniqueId') uniqueId: string,
  ) {
    return this.present(await this.service.get(uniqueId, user));
  }

  @RequirePermission('stock.adjust')
  @Post(':uniqueId/commit')
  @HttpCode(HttpStatus.OK)
  async commit(
    @AuthUser() user: CurrentUser,
    @Param('uniqueId') uniqueId: string,
  ) {
    const { batch, adjustmentUniqueId } = await this.service.commit(
      user,
      uniqueId,
    );
    return { ...(await this.present(batch)), adjustmentUniqueId };
  }

  @RequirePermission('stock.adjust')
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
          'attachment; filename="opening-balance-errors.xlsx"',
      })
      .send(buf);
  }
}
