import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { CacheModule } from '@nestjs/cache-manager';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { join } from 'path';
import {
  AcceptLanguageResolver,
  HeaderResolver,
  I18nModule,
} from 'nestjs-i18n';
import {
  AppConfigModule,
  AppConfigService,
  envValidationSchema,
} from '@config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from '@prisma';
import {
  GqlHttpExceptionFilter,
  GqlLoggingInterceptor,
  GqlThrottlerGuard,
  PrismaExceptionFilter,
  RequestContextInterceptor,
  UserLocaleResolver,
} from '@common';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PermissionsModule, PermissionsGuard } from '@permissions';
import { NewsletterModule } from './newsletter/newsletter.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { StorageModule } from './storage/storage.module';
import { EventsModule } from './events/events.module';
import { VisitorsModule } from './visitors/visitors.module';
import { RetentionModule } from './retention/retention.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ContentModule } from './content/content.module';
import { SeoModule } from './seo/seo.module';
import { LocaleResolver } from '@common/resolvers/locale.resolver';
import { I18nSuccessInterceptor } from '@common/interceptors/i18n-success.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: true },
      expandVariables: true,
    }),

    AppConfigModule,

    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [config.throttle],
      }),
    }),

    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        connection: config.redis,
      }),
    }),

    CacheModule.register({ isGlobal: true }),

    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        path: `/${config.apiPrefix}/graphql`,
        autoSchemaFile: true,
        playground: false,
        introspection: !config.isProduction,
        includeStacktraceInErrorResponses: !config.isProduction,
        plugins: config.isProduction
          ? []
          : [ApolloServerPluginLandingPageLocalDefault()],
        subscriptions: {
          'graphql-ws': {
            path: `/${config.apiPrefix}/graphql`,
          },
        },
      }),
    }),

    I18nModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        fallbackLanguage: 'en',
        loaderOptions: {
          path: join(process.cwd(), 'src', 'i18n'),
          watch: config.isDevelopment,
        },
      }),
      resolvers: [
        UserLocaleResolver,
        { use: HeaderResolver, options: ['x-lang'] },
        AcceptLanguageResolver,
      ],
      inject: [AppConfigService],
      imports: [AppConfigModule],
    }),

    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),

    PrismaModule,
    PermissionsModule,
    AuthModule,
    UsersModule,
    RolesModule,
    HealthModule,
    NewsletterModule,
    CampaignsModule,
    StorageModule,
    EventsModule,
    VisitorsModule,
    RetentionModule,
    NotificationsModule,
    ContentModule,
    SeoModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    LocaleResolver,
    { provide: APP_GUARD, useClass: GqlThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: GqlLoggingInterceptor },
    { provide: APP_FILTER, useClass: GqlHttpExceptionFilter },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
    {
      provide: APP_INTERCEPTOR,
      useClass: I18nSuccessInterceptor,
    },
  ],
})
export class AppModule {}
