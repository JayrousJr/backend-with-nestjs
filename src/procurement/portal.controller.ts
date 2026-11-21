import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@common';
import { PrismaService } from '@prisma';
import { StorageService } from '../storage/storage.service';
import { MAX_FILE_SIZE } from '../storage/storage.constants';
import { VendorAuthService, type VendorPrincipal } from './vendor-auth.service';
import { VendorGuard, Vendor } from './vendor.guard';
import { PortalService, type BidInput } from './portal.service';
import { VendorsService } from './vendors.service';

/** Vendor portal sign-in (no vendor token yet). */
@ApiTags('portal')
@Public()
@Controller('portal/auth')
export class PortalAuthController {
  constructor(private readonly auth: VendorAuthService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() b: { email: string; password: string }, @Ip() ip: string) {
    return this.auth.login(
      String(b?.email ?? ''),
      String(b?.password ?? ''),
      ip,
    );
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  setup(@Body() b: { challengeToken: string }) {
    return this.auth.beginSetup(String(b?.challengeToken ?? ''));
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  verify(
    @Body() b: { challengeToken: string; code: string },
    @Ip() ip: string,
  ) {
    return this.auth.verify(
      String(b?.challengeToken ?? ''),
      String(b?.code ?? ''),
      ip,
    );
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('activate')
  @HttpCode(HttpStatus.OK)
  async activate(@Body() b: { token: string; password: string }) {
    await this.auth.activate(String(b?.token ?? ''), String(b?.password ?? ''));
    return { ok: true };
  }

  @UseGuards(VendorGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Vendor() v: VendorPrincipal) {
    return this.auth.refresh(v);
  }

  @UseGuards(VendorGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Vendor() v: VendorPrincipal) {
    await this.auth.logout(v);
    return { ok: true };
  }
}

/** The vendor portal (own_vendor scope only). */
@ApiTags('portal')
@Public()
@UseGuards(VendorGuard)
@Controller('portal')
export class PortalController {
  constructor(
    private readonly portal: PortalService,
    private readonly vendors: VendorsService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('me')
  me(@Vendor() v: VendorPrincipal) {
    return this.portal.me(v);
  }

  @Get('tenders')
  tenders(@Vendor() v: VendorPrincipal) {
    return this.portal.tenders(v);
  }

  @Get('tenders/:id')
  tender(@Vendor() v: VendorPrincipal, @Param('id') id: string) {
    return this.portal.tenderDetail(v, id);
  }

  @Post('tenders/:id/questions')
  ask(
    @Vendor() v: VendorPrincipal,
    @Param('id') id: string,
    @Body() b: { question: string },
  ) {
    return this.portal.ask(v, id, String(b?.question ?? ''));
  }

  @Put('tenders/:id/bid')
  bid(
    @Vendor() v: VendorPrincipal,
    @Param('id') id: string,
    @Body() b: BidInput & { submit?: boolean },
  ) {
    return this.portal.saveBid(
      v,
      id,
      {
        validityDays: Number(b?.validityDays) || 0,
        fileUniqueIds: b?.fileUniqueIds ?? [],
        lines: b?.lines ?? [],
      },
      b?.submit === true,
    );
  }

  @Post('tenders/:id/withdraw')
  withdraw(@Vendor() v: VendorPrincipal, @Param('id') id: string) {
    return this.portal.withdraw(v, id);
  }

  @Get('orders')
  orders(@Vendor() v: VendorPrincipal) {
    return this.portal.orders_(v);
  }

  @Get('orders/:id')
  order(@Vendor() v: VendorPrincipal, @Param('id') id: string) {
    return this.portal.order(v, id);
  }

  @Post('orders/:id/acknowledge')
  acknowledge(@Vendor() v: VendorPrincipal, @Param('id') id: string) {
    return this.portal.acknowledge(v, id);
  }

  @Get('notifications')
  notifications(@Vendor() v: VendorPrincipal) {
    return this.portal.notificationsList(v);
  }

  @Post('notifications/read')
  @HttpCode(HttpStatus.OK)
  async read(@Vendor() v: VendorPrincipal) {
    await this.portal.markRead(v);
    return { ok: true };
  }

  // ── own users (vendor admin) ──
  @Get('users')
  users(@Vendor() v: VendorPrincipal) {
    return this.portal.users(v);
  }

  @Post('users')
  createUser(
    @Vendor() v: VendorPrincipal,
    @Body() b: { fullName: string; email: string; phone?: string },
  ) {
    if (!v.isAdmin) throw new ForbiddenException('errors.forbidden');
    return this.vendors.createUser(v.vendorId, b, false, v.email);
  }

  @Post('users/:id/active')
  @HttpCode(HttpStatus.OK)
  async active(
    @Vendor() v: VendorPrincipal,
    @Param('id') id: string,
    @Body() b: { active: boolean },
  ) {
    if (!v.isAdmin || id === v.vendorUserUniqueId)
      throw new ForbiddenException('errors.forbidden');
    await this.vendors.setUserActive(id, b?.active === true, v.vendorId);
    return { ok: true };
  }

  @Post('users/:id/reset-2fa')
  @HttpCode(HttpStatus.OK)
  async reset(@Vendor() v: VendorPrincipal, @Param('id') id: string) {
    if (!v.isAdmin) throw new ForbiddenException('errors.forbidden');
    await this.vendors.resetUser2fa(id, v.email, v.vendorId);
    return { ok: true };
  }

  @Post('users/:id/resend')
  resend(@Vendor() v: VendorPrincipal, @Param('id') id: string) {
    if (!v.isAdmin) throw new ForbiddenException('errors.forbidden');
    return this.vendors.resendActivation(id, v.vendorId);
  }

  // ── files: brochures and certificates for bids ──
  @Post('files/upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }),
  )
  async upload(
    @Vendor() v: VendorPrincipal,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const f = await this.storage.upload(file, `vendor-${v.vendorId}`);
    return { uniqueId: f.uniqueId, filename: f.filename, uri: f.uri };
  }

  /** Files the vendor may read: its own uploads and the addenda of its tenders. */
  @Get('files/:id')
  async download(@Vendor() v: VendorPrincipal, @Param('id') id: string) {
    const f = await this.prisma.db.file.findUnique({ where: { uniqueId: id } });
    if (!f) throw new ForbiddenException('errors.forbidden');
    const own = f.uri.startsWith(`vendor-${v.vendorId}/`);
    const addendum = await this.prisma.db.tenderAddendum.count({
      where: {
        fileId: f.id,
        tender: { invites: { some: { vendorId: v.vendorId } } },
      },
    });
    if (!own && !addendum) throw new ForbiddenException('errors.forbidden');
    return this.storage.getFileStream(f.uri);
  }
}
