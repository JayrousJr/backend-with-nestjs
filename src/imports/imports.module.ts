import { Module } from '@nestjs/common';
import { EmployeeImportService } from './employee-import.service';
import { ImportsController } from './imports.controller';

@Module({
  providers: [EmployeeImportService],
  controllers: [ImportsController],
})
export class ImportsModule {}
