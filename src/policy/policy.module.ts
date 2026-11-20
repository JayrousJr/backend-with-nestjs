import { Global, Module } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { PolicyResolver } from './policy.resolver';

@Global()
@Module({
  providers: [PolicyService, PolicyResolver],
  exports: [PolicyService],
})
export class PolicyModule {}
