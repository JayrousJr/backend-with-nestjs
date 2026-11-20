import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AppConfigService } from '@config';
import { AuthUser, Public } from '@common';
import type { CurrentUser } from '@common';
import { AuthService, AuthTokens } from './auth.service';
import type { SessionMetadata } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ChangePasswordDto, TokenPasswordDto } from './dto/password.dto';
import {
  ChallengeCodeDto,
  ChallengeDto,
  DisableTwoFactorDto,
  TwoFactorCodeDto,
} from './dto/two-factor.dto';
import { TwoFactorService } from './two-factor.service';

const REFRESH_COOKIE = 'refresh_token';

function meta(req: Request): SessionMetadata {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

/**
 * Staff authentication (A1 §7). No self-registration: users are created
 * from employees and activate through an emailed link.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  /** Refresh token lives in an HttpOnly, SameSite cookie scoped to /auth. */
  private cookieOptions(expires?: Date): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: this.config.cookieSameSite,
      path: `/${this.config.apiPrefix}/auth`,
      ...(expires && { expires }),
    };
  }

  private issue(res: Response, tokens: AuthTokens) {
    res.cookie(
      REFRESH_COOKIE,
      tokens.refreshToken,
      this.cookieOptions(tokens.refreshExpiresAt),
    );
    return { accessToken: tokens.accessToken };
  }

  private readRefresh(req: Request, dto?: RefreshDto) {
    const cookies = req.cookies as Record<string, string> | undefined;
    return cookies?.[REFRESH_COOKIE] ?? dto?.refreshToken;
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto, meta(req));
    // With 2FA the password step returns a challenge, never a session.
    if (result.challenge) return { twoFactor: result.challenge };
    return this.issue(res, result.tokens);
  }

  // ── two-factor ───────────────────────────────────────────────────────────

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  async verifyTwoFactor(
    @Body() dto: ChallengeCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.issue(
      res,
      await this.auth.verifyTwoFactor(dto.challengeToken, dto.code, meta(req)),
    );
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('2fa/email-code')
  @HttpCode(HttpStatus.NO_CONTENT)
  sendTwoFactorEmail(@Body() dto: ChallengeDto, @Req() req: Request) {
    return this.auth.sendTwoFactorEmail(dto.challengeToken, meta(req));
  }

  /** Enrolment during login (a role requires 2FA). */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('2fa/challenge-setup')
  @HttpCode(HttpStatus.OK)
  challengeSetup(@Body() dto: ChallengeDto) {
    return this.auth.challengeSetup(dto.challengeToken);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('2fa/challenge-enable')
  @HttpCode(HttpStatus.OK)
  async challengeEnable(
    @Body() dto: ChallengeCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.issue(
      res,
      await this.auth.challengeEnable(dto.challengeToken, dto.code, meta(req)),
    );
  }

  /** Signed-in user: status, voluntary enrolment, switch off. */
  @Get('2fa')
  @ApiBearerAuth()
  twoFactorStatus(@AuthUser() user: CurrentUser) {
    return this.twoFactor.status(user.id);
  }

  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  twoFactorSetup(@AuthUser() user: CurrentUser) {
    return this.twoFactor.beginSetup(user.id);
  }

  @Post('2fa/enable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  twoFactorEnable(
    @AuthUser() user: CurrentUser,
    @Body() dto: TwoFactorCodeDto,
  ) {
    return this.twoFactor.confirmSetup(user.id, dto.code);
  }

  @Post('2fa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  twoFactorDisable(
    @AuthUser() user: CurrentUser,
    @Body() dto: DisableTwoFactorDto,
  ) {
    return this.twoFactor.disable(user, dto.password, dto.code);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto?: RefreshDto,
  ) {
    const token = this.readRefresh(req, dto);
    if (!token) throw new UnauthorizedException('errors.invalid_refresh_token');
    return this.issue(res, await this.auth.refresh(token, meta(req)));
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto?: RefreshDto,
  ) {
    const token = this.readRefresh(req, dto);
    if (token) await this.auth.logout(token);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  async logoutAll(
    @AuthUser() user: CurrentUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logoutAll(user.id);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('activate')
  @HttpCode(HttpStatus.NO_CONTENT)
  activate(@Body() dto: TokenPasswordDto, @Req() req: Request) {
    return this.auth.activate(dto.token, dto.password, meta(req));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.auth.forgotPassword(dto.email, meta(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  resetPassword(@Body() dto: TokenPasswordDto, @Req() req: Request) {
    return this.auth.resetPassword(dto.token, dto.password, meta(req));
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  changePassword(
    @AuthUser() user: CurrentUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    return this.auth.changePassword(
      user.uniqueId,
      dto.currentPassword,
      dto.newPassword,
      user.sessionId,
      meta(req),
    );
  }

  @Get('sessions')
  @ApiBearerAuth()
  sessions(@AuthUser() user: CurrentUser) {
    return this.auth.getSessions(user.id);
  }

  @Delete('sessions/:uniqueId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  revokeSession(
    @AuthUser() user: CurrentUser,
    @Param('uniqueId') uniqueId: string,
  ) {
    return this.auth.revokeSession(user.id, uniqueId);
  }
}
