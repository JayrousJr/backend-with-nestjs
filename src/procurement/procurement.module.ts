import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../storage/storage.module';
import { StoreModule } from '../store/store.module';
import { VendorAuthService } from './vendor-auth.service';
import { VendorsService } from './vendors.service';
import { SourcingService } from './sourcing.service';
import { OrdersService } from './orders.service';
import { ReceivingService } from './receiving.service';
import { FinanceService } from './finance.service';
import { PurchaseFileService } from './purchase-file.service';
import { PortalService } from './portal.service';
import { VendorGuard } from './vendor.guard';
import { ProcurementController } from './procurement.controller';
import { PortalAuthController, PortalController } from './portal.controller';

/** B1 §7–§11: vendors and portal, tenders, LPO, receiving, inspection, finance. */
@Global()
@Module({
  imports: [
    JwtModule.register({}),
    AuthModule,
    MailModule,
    NotificationsModule,
    StorageModule,
    StoreModule,
  ],
  controllers: [ProcurementController, PortalAuthController, PortalController],
  providers: [
    VendorAuthService,
    VendorsService,
    SourcingService,
    OrdersService,
    ReceivingService,
    FinanceService,
    PurchaseFileService,
    PortalService,
    VendorGuard,
  ],
  exports: [
    VendorsService,
    SourcingService,
    OrdersService,
    ReceivingService,
    FinanceService,
  ],
})
export class ProcurementModule {}
