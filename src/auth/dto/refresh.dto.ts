import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { i18nValidationMessage } from 'nestjs-i18n';

export class RefreshDto {
  /**
   * Optional: browsers send the refresh token as an HttpOnly cookie, so the
   * body is only used by non-browser clients (mobile, server-to-server).
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  refreshToken?: string;
}
