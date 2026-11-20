import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrgModule } from '../org/org.module';
import { WorkflowService } from './workflow.service';
import { ChainsService } from './chains.service';
import { WorkflowResolver } from './workflow.resolver';

@Global()
@Module({
  imports: [NotificationsModule, OrgModule],
  providers: [WorkflowService, ChainsService, WorkflowResolver],
  exports: [WorkflowService],
})
export class WorkflowModule {}
