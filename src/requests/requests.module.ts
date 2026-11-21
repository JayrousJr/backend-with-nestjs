import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { RequestsService } from './requests.service';
import { RequestsResolver } from './requests.resolver';

/** Global: the store (issues) and handover record deliveries against requests. */
@Global()
@Module({
  imports: [NotificationsModule],
  providers: [RequestsService, RequestsResolver],
  exports: [RequestsService],
})
export class RequestsModule {}
