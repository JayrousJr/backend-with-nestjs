import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthUser } from '@common';
import type { CurrentUser } from '@common';
import { ReportsService, type ReportParams } from './reports.service';

/** Each report checks its own permission (see ReportsService). */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  available(@AuthUser() user: CurrentUser) {
    return this.reports.available(user);
  }

  @Get(':code')
  async download(
    @AuthUser() user: CurrentUser,
    @Param('code') code: string,
    @Query() params: ReportParams,
    @Res() res: Response,
  ) {
    const { fileName, buffer } = await this.reports.excel(user, code, params);
    res
      .set({
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      })
      .send(buffer);
  }
}
