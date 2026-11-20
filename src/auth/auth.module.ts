import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthResolver } from './auth.resolver';
import { SessionsRepository } from './session.repository';
import { PasswordPolicyService } from './password-policy.service';
import { TwoFactorService } from './two-factor.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UsersModule } from '../users/users.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [JwtModule.register({}), PassportModule, UsersModule, MailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthResolver,
    SessionsRepository,
    PasswordPolicyService,
    TwoFactorService,
    JwtStrategy,
  ],
  exports: [TwoFactorService],
})
export class AuthModule {}
