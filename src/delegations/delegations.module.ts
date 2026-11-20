import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { DelegationsService } from './delegations.service';
import { DelegationsResolver } from './delegations.resolver';

@Module({
  imports: [NotificationsModule],
  providers: [DelegationsService, DelegationsResolver],
})
export class DelegationsModule {}
