import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type {
  ProcurementRoute,
  PurchaseOrderStatus,
  TenderStatus,
  VendorStatus,
} from '@db';
import { AuthUser } from '@common';
import type { CurrentUser } from '@common';
import { AccessService, RequirePermission } from '@access';
import { PrismaService } from '@prisma';
import { VendorsService, type VendorInput } from './vendors.service';
import {
  SourcingService,
  type LineRef,
  type TenderInput,
} from './sourcing.service';
import {
  OrdersService,
  type AmendInput,
  type CashPurchaseInput,
} from './orders.service';
import {
  ReceivingService,
  type GrnInput,
  type InspectInput,
} from './receiving.service';
import { FinanceService, type InvoiceInput } from './finance.service';
import { PurchaseFileService, type DocSubject } from './purchase-file.service';
import { fullName } from './procurement.util';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = <T extends string>(v?: string) =>
  v ? (v.split(',').filter(Boolean) as T[]) : undefined;

/**
 * Staff procurement API (B1 §7–§11): vendors, routing, tenders, LPOs,
 * receiving, inspection, finance, purchase file. Bearer-authenticated REST.
 */
@ApiTags('procurement')
@ApiBearerAuth()
@Controller('procurement')
export class ProcurementController {
  constructor(
    private readonly vendors: VendorsService,
    private readonly sourcing: SourcingService,
    private readonly orders: OrdersService,
    private readonly receiving: ReceivingService,
    private readonly finance: FinanceService,
    private readonly file: PurchaseFileService,
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
  ) {}

  // ── vendors ──
  @RequirePermission('vendor.view')
  @Get('vendors')
  vendorList(
    @Query('search') search?: string,
    @Query('category') category?: string,
  ) {
    return this.vendors.list(search, category);
  }

  @RequirePermission('vendor.view')
  @Get('vendors/:id')
  vendor(@Param('id') id: string) {
    return this.vendors.get(id);
  }

  @RequirePermission('vendor.manage')
  @Post('vendors')
  createVendor(@AuthUser() u: CurrentUser, @Body() b: VendorInput) {
    if (!str(b?.name).trim() || !str(b?.email).includes('@'))
      throw new BadRequestException('errors.vendor_fields');
    return this.vendors.create(u, {
      ...b,
      categoryUniqueIds: b.categoryUniqueIds ?? [],
    });
  }

  @RequirePermission('vendor.manage')
  @Put('vendors/:id')
  updateVendor(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: VendorInput,
  ) {
    if (!str(b?.name).trim() || !str(b?.email).includes('@'))
      throw new BadRequestException('errors.vendor_fields');
    return this.vendors.update(u, id, {
      ...b,
      categoryUniqueIds: b.categoryUniqueIds ?? [],
    });
  }

  @RequirePermission('vendor.manage')
  @Post('vendors/:id/renew')
  renew(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.vendors.renew(u, id);
  }

  @RequirePermission('vendor.suspend')
  @Post('vendors/:id/status')
  vendorStatus(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { status: VendorStatus; reason?: string },
  ) {
    if (!['ACTIVE', 'SUSPENDED', 'BLACKLISTED'].includes(b?.status))
      throw new BadRequestException('errors.invalid_status');
    return this.vendors.setStatus(u, id, b.status, str(b.reason));
  }

  @RequirePermission('vendor.create_admin_user')
  @Post('vendors/:id/admin-user')
  adminUser(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { fullName: string; email: string; phone?: string },
  ) {
    if (!str(b?.fullName).trim() || !str(b?.email).includes('@'))
      throw new BadRequestException('errors.vendor_fields');
    return this.vendors.createAdminUser(u, id, b);
  }

  @RequirePermission('vendor.create_admin_user')
  @Post('vendor-users/:id/resend')
  resend(@Param('id') id: string) {
    return this.vendors.resendActivation(id);
  }

  @RequirePermission('vendor.manage')
  @Post('vendor-users/:id/active')
  @HttpCode(HttpStatus.OK)
  async userActive(@Param('id') id: string, @Body() b: { active: boolean }) {
    await this.vendors.setUserActive(id, b?.active === true);
    return { ok: true };
  }

  @RequirePermission('vendor.reset_2fa')
  @Post('vendor-users/:id/reset-2fa')
  @HttpCode(HttpStatus.OK)
  async reset2fa(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    await this.vendors.resetUser2fa(id, u.email);
    return { ok: true };
  }

  // ── routing ──
  @RequirePermission('purchase_request.assign_route')
  @Get('queue')
  queue() {
    return this.sourcing.queue();
  }

  @RequirePermission('purchase_request.assign_route')
  @Post('routes')
  route(
    @AuthUser() u: CurrentUser,
    @Body()
    b: {
      lines: LineRef[];
      route: ProcurementRoute;
      justification?: string;
      fileUniqueId?: string;
    },
  ) {
    if (!['CASH', 'SINGLE_SOURCE', 'QUOTATION'].includes(b?.route))
      throw new BadRequestException('errors.invalid_route');
    return this.sourcing.setRoute(
      u,
      b.lines ?? [],
      b.route,
      b.justification,
      b.fileUniqueId,
    );
  }

  // ── tenders ──
  @RequirePermission('tender.view')
  @Get('tenders')
  tenders(@AuthUser() u: CurrentUser, @Query('status') status?: string) {
    return this.sourcing.list(u, list<TenderStatus>(status));
  }

  @RequirePermission('tender.view')
  @Get('tenders/:id')
  tender(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.sourcing.get(u, id);
  }

  @RequirePermission('tender.create')
  @Post('tenders')
  createTender(
    @AuthUser() u: CurrentUser,
    @Body() b: TenderInput & { lines: LineRef[]; route: ProcurementRoute },
  ) {
    if (!str(b?.title).trim())
      throw new BadRequestException('errors.title_required');
    return this.sourcing.createTender(u, b.lines ?? [], b.route, b);
  }

  @RequirePermission('tender.create')
  @Put('tenders/:id')
  updateTender(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: TenderInput,
  ) {
    if (!str(b?.title).trim())
      throw new BadRequestException('errors.title_required');
    return this.sourcing.updateTender(u, id, b);
  }

  /** Staff who may sit on committees (hold tender.evaluate). */
  @RequirePermission('tender.appoint_committee')
  @Get('committee-candidates')
  async candidates() {
    const ids = await this.access.usersWithPermission('tender.evaluate');
    const users = await this.prisma.dbRaw.user.findMany({
      where: { id: { in: ids } },
      include: { employee: { include: { department: true } } },
      orderBy: { email: 'asc' },
    });
    return users.map((x) => ({
      uniqueId: x.uniqueId,
      name: fullName(x.employee),
      email: x.email,
      department: x.employee.department.name,
    }));
  }

  @RequirePermission('tender.appoint_committee')
  @Post('tenders/:id/committee')
  committee(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { userUniqueIds: string[]; chairUniqueId?: string },
  ) {
    return this.sourcing.appointCommittee(
      u,
      id,
      b?.userUniqueIds ?? [],
      b?.chairUniqueId,
    );
  }

  @RequirePermission('tender.view')
  @Post('tenders/:id/coi')
  coi(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { noConflict: boolean; statement?: string },
  ) {
    return this.sourcing.declareCoi(
      u,
      id,
      b?.noConflict === true,
      str(b?.statement),
    );
  }

  @RequirePermission('tender.publish')
  @Post('tenders/:id/publish')
  publish(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.sourcing.publish(u, id);
  }

  @RequirePermission('tender.answer_clarification')
  @Post('clarifications/:id/answer')
  answer(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { answer: string },
  ) {
    if (!str(b?.answer).trim())
      throw new BadRequestException('errors.answer_required');
    return this.sourcing.answerClarification(u, id, b.answer);
  }

  @RequirePermission('tender.issue_addendum')
  @Post('tenders/:id/addendum')
  addendum(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { text: string; newClosingAt?: string; fileUniqueId?: string },
  ) {
    if (str(b?.text).trim().length < 5)
      throw new BadRequestException('errors.text_required');
    return this.sourcing.issueAddendum(
      u,
      id,
      b.text,
      b.newClosingAt,
      b.fileUniqueId,
    );
  }

  @RequirePermission('tender.cancel')
  @Post('tenders/:id/cancel')
  cancelTender(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { reason: string },
  ) {
    if (str(b?.reason).trim().length < 5)
      throw new BadRequestException('errors.reason_required');
    return this.sourcing.cancel(u, id, b.reason);
  }

  @RequirePermission('tender.confirm_opening')
  @Post('tenders/:id/confirm-opening')
  confirmOpening(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.sourcing.confirmOpening(u, id);
  }

  @RequirePermission('tender.evaluate')
  @Post('tenders/:id/override')
  override(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { bidLineId: number; compliant: boolean; reason: string },
  ) {
    return this.sourcing.overrideCompliance(
      u,
      id,
      Number(b?.bidLineId),
      b?.compliant === true,
      str(b?.reason),
    );
  }

  @RequirePermission('tender.evaluate')
  @Post('tenders/:id/winner')
  winner(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { lineNo: number; bidLineId: number | null; reason: string },
  ) {
    return this.sourcing.chooseWinner(
      u,
      id,
      Number(b?.lineNo),
      b?.bidLineId ? Number(b.bidLineId) : null,
      str(b?.reason),
    );
  }

  @RequirePermission('tender.evaluate')
  @Post('tenders/:id/evaluation-note')
  note(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { note: string },
  ) {
    return this.sourcing.saveEvaluationNote(u, id, str(b?.note));
  }

  @RequirePermission('tender.negotiate')
  @Post('tenders/:id/negotiate')
  negotiate(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body()
    b: {
      bidLineId: number;
      price?: number | null;
      days?: number | null;
      note?: string;
    },
  ) {
    return this.sourcing.negotiate(
      u,
      id,
      Number(b?.bidLineId),
      b?.price == null ? null : Number(b.price),
      b?.days == null ? null : Number(b.days),
      str(b?.note),
    );
  }

  @RequirePermission('tender.publish')
  @Post('tenders/:id/submit-award')
  submitAward(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.sourcing.submitAward(u, id);
  }

  @RequirePermission('tender.send_notifications')
  @Post('tenders/:id/letters')
  letters(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.sourcing.sendLetters(u, id);
  }

  @RequirePermission('lpo.create')
  @Post('tenders/:id/orders')
  createOrders(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.orders.createFromAward(u, id);
  }

  // ── LPOs ──
  @RequirePermission('lpo.view')
  @Get('orders')
  orderList(@AuthUser() u: CurrentUser, @Query('status') status?: string) {
    return this.orders.list(u, list<PurchaseOrderStatus>(status));
  }

  @RequirePermission('lpo.view')
  @Get('orders/:id')
  order(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.orders.get(u, id);
  }

  @RequirePermission('lpo.create')
  @Put('orders/:id')
  updateOrder(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { deliveryDate?: string; instructions?: string },
  ) {
    return this.orders.update(u, id, b ?? {});
  }

  @RequirePermission('lpo.issue')
  @Post('orders/:id/issue')
  issue(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.orders.issue(u, id);
  }

  @RequirePermission('lpo.amend')
  @Post('orders/:id/amend')
  amend(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: AmendInput,
  ) {
    return this.orders.amend(u, id, {
      ...b,
      reason: str(b?.reason),
      lines: b?.lines ?? [],
    });
  }

  @RequirePermission('lpo.cancel')
  @Post('orders/:id/cancel')
  cancelOrder(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { reason: string; reaward?: boolean },
  ) {
    return this.orders.requestCancel(
      u,
      id,
      str(b?.reason),
      b?.reaward === true,
    );
  }

  @RequirePermission('cash_purchase.record')
  @Post('cash-purchases')
  cash(@AuthUser() u: CurrentUser, @Body() b: CashPurchaseInput) {
    return this.orders.recordCash(u, {
      ...b,
      lines: b?.lines ?? [],
      receiptFileUniqueIds: b?.receiptFileUniqueIds ?? [],
    });
  }

  // ── receiving / inspection ──
  @RequirePermission('stock.receive')
  @Post('orders/:id/grn')
  receive(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: GrnInput,
  ) {
    return this.receiving.receive(u, id, { ...b, lines: b?.lines ?? [] });
  }

  @Get('grns')
  grns(@AuthUser() u: CurrentUser) {
    return this.receiving.listGrns(u);
  }

  @Get('grns/:id')
  grn(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.receiving.getGrn(u, id);
  }

  @Get('inspections')
  inspections(
    @AuthUser() u: CurrentUser,
    @Query('open') open?: string,
    @Query('grn') grn?: string,
  ) {
    return this.receiving.listInspections(u, open === 'true', grn);
  }

  @Get('inspections/:id')
  inspection(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.receiving.getInspection(u, id);
  }

  /** Inspectors of the inspecting department (Inspector role + HOD). */
  @Get('inspections/:id/inspectors')
  async inspectors(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    const i = await this.receiving.getInspection(u, id);
    const ins = await this.prisma.db.goodsInspection.findUniqueOrThrow({
      where: { uniqueId: i.uniqueId },
    });
    const dept = await this.prisma.db.department.findUniqueOrThrow({
      where: { id: ins.departmentId },
    });
    const roles = await this.prisma.db.userRole.findMany({
      where: {
        contextType: 'DEPARTMENT',
        contextId: dept.id,
        role: { grants: { some: { permissionCode: 'inspection.perform' } } },
        user: { status: 'ACTIVE' },
      },
      select: { userId: true },
    });
    const users = await this.prisma.dbRaw.user.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { id: { in: roles.map((r) => r.userId) } },
          ...(dept.headEmployeeId ? [{ employeeId: dept.headEmployeeId }] : []),
        ],
      },
      include: { employee: true },
    });
    return users.map((x) => ({
      uniqueId: x.uniqueId,
      name: fullName(x.employee),
      email: x.email,
    }));
  }

  @Post('inspections/:id/assign')
  assign(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { userUniqueId: string },
  ) {
    return this.receiving.assign(u, id, str(b?.userUniqueId));
  }

  @Post('inspections/:id/inspect')
  inspect(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: InspectInput,
  ) {
    return this.receiving.inspect(u, id, {
      ...b,
      results: b?.results ?? [],
      passedQty: Number(b?.passedQty) || 0,
    });
  }

  @Post('inspections/:id/return-to-vendor')
  returnToVendor(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: { note?: string },
  ) {
    return this.receiving.returnToVendor(u, id, str(b?.note));
  }

  // ── finance ──
  @RequirePermission('invoice.view')
  @Get('invoices')
  invoices(@AuthUser() u: CurrentUser) {
    return this.finance.list(u);
  }

  @RequirePermission('invoice.view')
  @Get('invoices/:id')
  invoice(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.finance.get(u, id);
  }

  @RequirePermission('invoice.register')
  @Post('orders/:id/invoices')
  registerInvoice(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: InvoiceInput,
  ) {
    if (!str(b?.vendorInvoiceNo).trim() || !b?.invoiceDate)
      throw new BadRequestException('errors.invoice_fields');
    return this.finance.register(u, id, {
      ...b,
      amountInclVat: Number(b.amountInclVat),
      vatAmount: Number(b.vatAmount),
    });
  }

  @RequirePermission('invoice.register')
  @Post('invoices/:id/request-payment')
  requestPayment(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.finance.requestPayment(u, id);
  }

  @RequirePermission('payment.record')
  @Post('invoices/:id/payment')
  payment(
    @AuthUser() u: CurrentUser,
    @Param('id') id: string,
    @Body()
    b: {
      reference: string;
      paidAt: string;
      amount: number;
      fileUniqueIds?: string[];
    },
  ) {
    return this.finance.recordPayment(u, id, {
      reference: str(b?.reference),
      paidAt: str(b?.paidAt),
      amount: Number(b?.amount),
      fileUniqueIds: b?.fileUniqueIds ?? [],
    });
  }

  // ── purchase file / documents ──
  @RequirePermission('purchase_file.view')
  @Get('purchase-file/:id')
  purchaseFile(@AuthUser() u: CurrentUser, @Param('id') id: string) {
    return this.file.forRequest(u, id);
  }

  @Get('documents/:type/:id')
  documents(@Param('type') type: DocSubject, @Param('id') id: string) {
    return this.file.documentsOf(type, id);
  }

  @RequirePermission('procurement_document.upload')
  @Post('documents/:type/:id')
  attach(
    @AuthUser() u: CurrentUser,
    @Param('type') type: DocSubject,
    @Param('id') id: string,
    @Body() b: { docType: string; fileUniqueId: string },
  ) {
    return this.file.attach(u, type, id, str(b?.docType), str(b?.fileUniqueId));
  }
}
