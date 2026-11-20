import { Module } from '@nestjs/common';
import { ExitClearanceService } from './exit-clearance.service';
import { ExitClearanceResolver } from './exit-clearance.resolver';

@Module({
  providers: [ExitClearanceService, ExitClearanceResolver],
  exports: [ExitClearanceService],
})
export class ExitClearanceModule {}
