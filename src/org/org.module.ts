import { Module } from '@nestjs/common';
import { DepartmentsService } from './departments.service';
import { LookupsService } from './lookups.service';
import { OrgResolver } from './org.resolver';

@Module({
  providers: [DepartmentsService, LookupsService, OrgResolver],
  exports: [DepartmentsService],
})
export class OrgModule {}
