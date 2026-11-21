import { Module } from '@nestjs/common';
import { OrgModule } from '../org/org.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StoresService } from './stores.service';
import { LedgerService } from './ledger.service';
import { AssetsService } from './assets.service';
import { AdjustmentsService } from './adjustments.service';
import { OpeningBalanceImportService } from './opening-balance-import.service';
import { StoreResolver } from './store.resolver';
import { TransfersService } from './transfers.service';
import { IssuesService } from './issues.service';
import { ReorderService } from './reorder.service';
import { CountsService } from './counts.service';
import { MaintenanceService } from './maintenance.service';
import { DisposalsService } from './disposals.service';
import { StoreOpsResolver } from './store-ops.resolver';
import { OpeningBalanceController } from './store.controller';

@Module({
  imports: [OrgModule, NotificationsModule],
  controllers: [OpeningBalanceController],
  providers: [
    StoresService,
    LedgerService,
    AssetsService,
    AdjustmentsService,
    OpeningBalanceImportService,
    TransfersService,
    IssuesService,
    ReorderService,
    CountsService,
    MaintenanceService,
    DisposalsService,
    StoreResolver,
    StoreOpsResolver,
  ],
  exports: [
    StoresService,
    LedgerService,
    AssetsService,
    ReorderService,
    MaintenanceService,
  ],
})
export class StoreModule {}
