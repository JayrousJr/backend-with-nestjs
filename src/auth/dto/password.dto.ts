import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { i18nValidationMessage } from 'nestjs-i18n';

/** Activation (first password) and reset share the same shape. */
export class TokenPasswordDto {
  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  token: string;

  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Length(1, 128)
  password: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  currentPassword: string;

  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Length(1, 128)
  newPassword: string;
}
