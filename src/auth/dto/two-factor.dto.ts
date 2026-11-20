import { IsString, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const CODE = /^\s*\d{3}\s?\d{3}\s*$/;

export class ChallengeDto {
  @ApiProperty()
  @IsString()
  challengeToken: string;
}

export class ChallengeCodeDto extends ChallengeDto {
  @ApiProperty({ example: '123456' })
  @Matches(CODE)
  code: string;
}

export class TwoFactorCodeDto {
  @ApiProperty({ example: '123456' })
  @Matches(CODE)
  code: string;
}

export class DisableTwoFactorDto extends TwoFactorCodeDto {
  @ApiProperty()
  @IsString()
  @Length(1, 128)
  password: string;
}
