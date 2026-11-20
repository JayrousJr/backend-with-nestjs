import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { UsersService } from './users.service';
import { UsersResolver } from './users.resolver';
import { AuthTokensService } from './auth-tokens.service';

@Module({
  imports: [MailModule],
  providers: [UsersResolver, UsersService, AuthTokensService],
  exports: [UsersService, AuthTokensService],
})
export class UsersModule {}
