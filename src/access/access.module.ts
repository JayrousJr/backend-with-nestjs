import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service';
import { AccessIntegrityService } from './access-integrity.service';
import { PermissionSyncService } from './permission-sync.service';
import { RolesService } from './roles.service';
import { GroupsService } from './groups.service';
import { UserRolesService } from './user-roles.service';
import { AccessResolver } from './access.resolver';

@Global()
@Module({
  providers: [
    AccessService,
    AccessIntegrityService,
    PermissionSyncService,
    RolesService,
    GroupsService,
    UserRolesService,
    AccessResolver,
  ],
  exports: [AccessService, AccessIntegrityService, UserRolesService],
})
export class AccessModule {}
