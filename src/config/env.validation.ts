import Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  PORT: Joi.number().default(3005),
  API_PREFIX: Joi.string().default('api'),
  APP_URL: Joi.string().default('http://localhost:3005'),

  DATABASE_URL: Joi.string().required(),

  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().optional().allow(''),

  MAIL_MAILER: Joi.string().optional().allow(''),
  SMTP_HOST: Joi.string().optional().allow(''),
  SMTP_PORT: Joi.string().optional().allow(''),
  SMTP_USER: Joi.string().optional().allow(''),
  SMTP_PASSWORD: Joi.string().optional().allow(''),
  SMTP_FROM: Joi.string().optional().allow(''),
  SMTP_ENCRYPTION: Joi.string().optional().allow(''),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  CORS_ORIGINS: Joi.string().default('http://localhost:3005'),
  // Where OAuth callbacks land the user back in the SPA
  FRONTEND_URL: Joi.string().default('http://localhost:5173'),
  // Absolute URL advertised in robots.txt. Defaults to <FRONTEND_URL>/sitemap.xml
  // (proxy it there via nginx); set it to the API's own URL instead if you
  // serve the sitemap from this host and verify both in Search Console.
  SITEMAP_URL: Joi.string().optional().allow(''),

  // Google OAuth — sign-in is disabled unless both are set
  GOOGLE_CLIENT_ID: Joi.string().optional().allow(''),
  GOOGLE_CLIENT_SECRET: Joi.string().optional().allow(''),
  GOOGLE_CALLBACK_URL: Joi.string().default(
    'http://localhost:3005/api/auth/google/callback',
  ),
  THROTTLE_TTL: Joi.number().default(60000),
  THROTTLE_LIMIT: Joi.number().default(100),

  KAFKA_BROKERS: Joi.string().default('localhost:9092'),
  KAFKA_GROUP_ID: Joi.string().default('nestjs-graphql-template'),

  ENABLE_MULTI_TENANCY: Joi.boolean().default(false),
  // Unset means "enabled outside production" — see AppConfigService.
  SWAGGER_ENABLED: Joi.boolean().optional(),
  // Number of trusted reverse-proxy hops in front of the app (0 = none).
  TRUST_PROXY: Joi.number().min(0).default(0),
  // 'strict' unless the SPA is on a different registrable domain than the
  // API, which needs 'none' (and HTTPS).
  COOKIE_SAMESITE: Joi.string()
    .valid('strict', 'lax', 'none')
    .default('strict'),

  // Data retention (days). 0 disables that purge entirely.
  RETENTION_SOFT_DELETED_DAYS: Joi.number().min(0).default(30),
  RETENTION_PAGE_VIEWS_DAYS: Joi.number().min(0).default(90),

  MPESA_CONSUMER_KEY: Joi.string().optional().allow(''),
  MPESA_CONSUMER_SECRET: Joi.string().optional().allow(''),
  MPESA_SHORTCODE: Joi.string().optional().allow(''),
  MPESA_PASSKEY: Joi.string().optional().allow(''),
  MPESA_CALLBACK_URL: Joi.string().optional().allow(''),
  MPESA_ENV: Joi.string().valid('sandbox', 'production').default('sandbox'),

  CRDB_API_KEY: Joi.string().optional().allow(''),
  CRDB_BASE_URL: Joi.string().optional().allow(''),

  RESEND_API_KEY: Joi.string().optional().allow(''),
  MAIL_FROM: Joi.string().optional().allow(''),

  AFRICAS_TALKING_API_KEY: Joi.string().optional().allow(''),
  AFRICAS_TALKING_USERNAME: Joi.string().optional().allow(''),

  FCM_PROJECT_ID: Joi.string().optional().allow(''),
  FCM_PRIVATE_KEY: Joi.string().optional().allow(''),
  FCM_CLIENT_EMAIL: Joi.string().optional().allow(''),

  STORAGE_DRIVER: Joi.string().valid('local', 's3').default('local'),
  AWS_REGION: Joi.string().optional().allow(''),
  AWS_ACCESS_KEY_ID: Joi.string().optional().allow(''),
  AWS_SECRET_ACCESS_KEY: Joi.string().optional().allow(''),
  AWS_S3_BUCKET: Joi.string().optional().allow(''),
  AWS_S3_ENDPOINT: Joi.string().optional().allow(''),

  SENTRY_DSN: Joi.string().optional().allow(''),
});
