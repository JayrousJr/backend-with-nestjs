import { Module } from '@nestjs/common';
import { StoresService } from './stores.service';
import { LedgerService } from './ledger.service';
import { AssetsService } from './assets.service';
import { AdjustmentsService } from './adjustments.service';
import { OpeningBalanceImportService } from './opening-balance-import.service';
import { StoreResolver } from './store.resolver';
import { OpeningBalanceController } from './store.controller';

@Module({
  controllers: [OpeningBalanceController],
  providers: [
    StoresService,
    LedgerService,
    AssetsService,
    AdjustmentsService,
    OpeningBalanceImportService,
    StoreResolver,
  ],
  exports: [StoresService, LedgerService, AssetsService],
})
export class StoreModule {}
