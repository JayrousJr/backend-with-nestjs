declare const module: any;
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { doubleCsrf } from 'csrf-csrf';
import type { Request, Response, NextFunction } from 'express';
import { I18nValidationPipe } from 'nestjs-i18n';
import { AppModule } from './app.module';
import { AppConfigService } from '@config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(AppConfigService);

  // Behind a reverse proxy, req.ip is the proxy unless Express is told how
  // many hops to trust. Session records and IP rate limits depend on this;
  // trusting blindly would let clients spoof X-Forwarded-For.
  if (config.trustProxy > 0) {
    app.set('trust proxy', config.trustProxy);
  }

  app.use(
    helmet({
      contentSecurityPolicy: config.isProduction
        ? undefined
        : {
            directives: {
              defaultSrc: [
                `'self'`,
                'apollo-server-landing-page.cdn.apollographql.com',
              ],
              scriptSrc: [
                `'self'`,
                `https: 'unsafe-inline'`,
                'apollo-server-landing-page.cdn.apollographql.com',
              ],
              manifestSrc: [
                `'self'`,
                'apollo-server-landing-page.cdn.apollographql.com',
              ],
              frameSrc: [`'self'`, 'sandbox.embed.apollographql.com'],
              imgSrc: [
                `'self'`,
                'data:',
                'apollo-server-landing-page.cdn.apollographql.com',
              ],
            },
          },
    }),
  );
  app.use(compression());
  app.use(cookieParser());

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
  });

  const { doubleCsrfProtection } = doubleCsrf({
    getSecret: () => config.jwtAccess.secret,
    // ties each CSRF token to the request's bearer token or cookie session
    getSessionIdentifier: (req) =>
      req.headers.authorization ?? req.cookies?.refresh_token ?? '',
    cookieName: '__Host-psifi.x-csrf-token',
    cookieOptions: {
      secure: config.isProduction,
      sameSite: 'strict',
    },
  });
  // GraphQL is Bearer-only (no cookie-based auth), so CSRF doesn't apply there
  // — and would otherwise block tools like Apollo Sandbox. Bearer-authenticated
  // requests elsewhere also can't be replayed by a malicious site (an attacker
  // can't read/set the Authorization header), so CSRF only applies to requests
  // authenticated via cookies (e.g. session/refresh flows).
  // /auth/* is exempt because its credentials are never ambient: they arrive
  // as body fields or a Bearer header. The one exception is the refresh-token
  // cookie used by refresh/logout — SameSite (see COOKIE_SAMESITE, 'strict' by
  // default) is what stops a malicious site from riding along with it, since
  // the browser simply won't attach the cookie to a cross-site request.
  // Note: req.path is relative to the '/api' mount point below, so these
  // correspond to the full '/api/graphql' and '/api/auth/*'.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (
      req.path === '/graphql' ||
      req.path.startsWith('/auth/') ||
      req.headers.authorization?.startsWith('Bearer ')
    ) {
      return next();
    }
    return doubleCsrfProtection(req, res, (err?: unknown) => {
      if (err) {
        return res.status(403).json({
          statusCode: 403,
          message: 'Invalid CSRF token',
          code: 'FORBIDDEN',
        });
      }
      next();
    });
  });

  app.useGlobalPipes(
    new I18nValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.setGlobalPrefix(config.apiPrefix);

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('NestJS GraphQL Template')
        .setVersion('1.0')
        .addBearerAuth()
        .addApiKey(
          { type: 'apiKey', in: 'header', name: 'x-api-key' },
          'api-key',
        )
        .build(),
    );
    SwaggerModule.setup(`${config.apiPrefix}/docs`, app, document);
  }

  app.enableShutdownHooks();

  const serverUrl = process.env.SERVER_URL ?? 3000;
  const port = process.env.PORT ?? 3000;
  const url =
    process.env.NODE_ENV === 'development'
      ? `localhost:${port}`
      : `${serverUrl}:${port}`;
  await app.listen(port);
  console.log(`Application is Running at: http://${url}/api`);
  console.log(`GraphQL is available at: http://${url}/api/graphql`);

  if (module.hot) {
    module.hot.accept();
    module.hot.dispose(() => app.close());
  }
}

void bootstrap();
