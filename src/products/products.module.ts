import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsResolver } from './products.resolver';
import { ProductImportService } from './product-import.service';
import { ProductImportController } from './products.controller';

@Module({
  controllers: [ProductImportController],
  providers: [ProductsService, ProductsResolver, ProductImportService],
  exports: [ProductsService],
})
export class ProductsModule {}
