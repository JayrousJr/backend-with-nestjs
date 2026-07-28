import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  get port(): number {
    return this.config.get<number>('PORT', 3005);
  }

  get nodeEnv(): string {
    return this.config.get<string>('NODE_ENV', 'development');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === 'development';
  }

  get apiPrefix(): string {
    return this.config.get<string>('API_PREFIX', 'api');
  }

  get appUrl(): string {
    return this.config.get<string>('APP_URL', 'http://localhost:3005');
  }

  get frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL', 'http://localhost:5173');
  }

  get databaseUrl(): string {
    return this.config.getOrThrow<string>('DATABASE_URL');
  }

  get redis() {
    return {
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: this.config.get<number>('REDIS_PORT', 6379),
      password: this.config.get<string>('REDIS_PASSWORD') || undefined,
    };
  }

  get jwtAccess() {
    return {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m'),
    };
  }

  get jwtRefresh() {
    return {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'),
    };
  }

  get googleOauth() {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID') || undefined;
    const clientSecret =
      this.config.get<string>('GOOGLE_CLIENT_SECRET') || undefined;
    return {
      enabled: Boolean(clientId && clientSecret),
      clientId,
      clientSecret,
      callbackUrl: this.config.get<string>(
        'GOOGLE_CALLBACK_URL',
        'http://localhost:3005/api/auth/google/callback',
      ),
    };
  }

  get corsOrigins(): string[] {
    return this.config
      .get<string>('CORS_ORIGINS', 'http://localhost:3005')
      .split(',')
      .map((o) => o.trim());
  }

  get throttle() {
    return {
      ttl: this.config.get<number>('THROTTLE_TTL', 60000),
      limit: this.config.get<number>('THROTTLE_LIMIT', 100),
    };
  }

  get kafka() {
    return {
      brokers: this.config
        .get<string>('KAFKA_BROKERS', 'localhost:9092')
        .split(',')
        .map((b) => b.trim()),
      groupId: this.config.get<string>(
        'KAFKA_GROUP_ID',
        'nestjs-graphql-template',
      ),
    };
  }

  get multiTenancyEnabled(): boolean {
    return this.config.get<boolean>('ENABLE_MULTI_TENANCY', false);
  }

  get swaggerEnabled(): boolean {
    // Publishing every route, DTO and auth scheme is a production information
    // leak, so docs are off there unless explicitly switched on.
    return this.config.get<boolean>('SWAGGER_ENABLED') ?? !this.isProduction;
  }

  get cookieSameSite(): 'strict' | 'lax' | 'none' {
    return this.config.get<'strict' | 'lax' | 'none'>(
      'COOKIE_SAMESITE',
      'strict',
    );
  }

  /** Trusted proxy hops; needed for correct client IPs behind nginx. */
  get trustProxy(): number {
    return this.config.get<number>('TRUST_PROXY', 0);
  }

  /** Data retention windows in days — 0 disables that purge entirely. */
  get retention() {
    return {
      softDeletedDays: this.config.get<number>(
        'RETENTION_SOFT_DELETED_DAYS',
        30,
      ),
      pageViewDays: this.config.get<number>('RETENTION_PAGE_VIEWS_DAYS', 90),
    };
  }

  get mpesa() {
    return {
      consumerKey: this.config.get<string>('MPESA_CONSUMER_KEY', ''),
      consumerSecret: this.config.get<string>('MPESA_CONSUMER_SECRET', ''),
      shortcode: this.config.get<string>('MPESA_SHORTCODE', ''),
      passkey: this.config.get<string>('MPESA_PASSKEY', ''),
      callbackUrl: this.config.get<string>('MPESA_CALLBACK_URL', ''),
      env: this.config.get<string>('MPESA_ENV', 'sandbox') as
        | 'sandbox'
        | 'production',
    };
  }

  get crdb() {
    return {
      apiKey: this.config.get<string>('CRDB_API_KEY', ''),
      baseUrl: this.config.get<string>('CRDB_BASE_URL', ''),
    };
  }

  get resend() {
    return {
      apiKey: this.config.get<string>('RESEND_API_KEY', ''),
      from: this.config.get<string>('MAIL_FROM', ''),
    };
  }

  get africasTalking() {
    return {
      apiKey: this.config.get<string>('AFRICAS_TALKING_API_KEY', ''),
      username: this.config.get<string>('AFRICAS_TALKING_USERNAME', ''),
    };
  }

  get firebase() {
    return {
      projectId: this.config.get<string>('FCM_PROJECT_ID', ''),
      privateKey: this.config.get<string>('FCM_PRIVATE_KEY', ''),
      clientEmail: this.config.get<string>('FCM_CLIENT_EMAIL', ''),
    };
  }

  get storage() {
    return {
      driver: this.config.get<string>('STORAGE_DRIVER', 'local') as
        | 'local'
        | 's3',
      region: this.config.get<string>('AWS_REGION', ''),
      accessKeyId: this.config.get<string>('AWS_ACCESS_KEY_ID', ''),
      secretAccessKey: this.config.get<string>('AWS_SECRET_ACCESS_KEY', ''),
      bucket: this.config.get<string>('AWS_S3_BUCKET', ''),
      endpoint: this.config.get<string>('AWS_S3_ENDPOINT', ''),
    };
  }

  get sentryDsn(): string {
    return this.config.get<string>('SENTRY_DSN', '');
  }

  get mail() {
    return {
      mailer: this.config.get<string>('MAIL_MAILER'),
      host: this.config.get<string>('SMTP_HOST'),
      port: this.config.get<string>('SMTP_PORT'),
      user: this.config.get<string>('SMTP_USER'),
      password: this.config.get<string>('SMTP_PASSWORD'),
      from: this.config.get<string>('SMTP_FROM'),
      encryption: this.config.get<string>('SMTP_ENCRYPTION'),
    };
  }
}
