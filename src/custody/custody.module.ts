import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { MailModule } from '../mail/mail.module';
import { OrgModule } from '../org/org.module';
import { StoreModule } from '../store/store.module';
import { HandoverService } from './handover.service';
import { CustodyService } from './custody.service';
import { CustodyResolver } from './custody.resolver';
import { HandoverAckController } from './custody.controller';

@Module({
  imports: [NotificationsModule, MailModule, OrgModule, StoreModule],
  controllers: [HandoverAckController],
  providers: [HandoverService, CustodyService, CustodyResolver],
  exports: [HandoverService, CustodyService],
})
export class CustodyModule {}
