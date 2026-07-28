# NestJS GraphQL Template

<p align="center">
  <a target="blank">
   <img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" />
   <img src="https://images.seeklogo.com/logo-png/40/1/apollo-graphql-logo-png_seeklogo-403403.png" backgroundColor="white" width="120" alt="Nest Logo" />
</a>
</p>

A production-ready backend template with NestJS, GraphQL (Apollo, code-first), Prisma ORM, and PostgreSQL. Designed as a starting point for any backend project — clone it, wire up your modules, and start building.

## Features

- **Auth** — Register, login, JWT (access + refresh tokens), email verification, password reset/change, session management, account lockout after failed attempts
- **Users & Roles** — CRUD with RBAC, permission guards, avatar upload
- **Permissions** — Granular permission system with `@RequirePermission()` decorator
- **Mail** — BullMQ queue with SMTP (nodemailer) and Resend transports, i18n-translated templates
- **Newsletter & Campaigns** — User subscription, admin campaign management, scheduled sends
- **File Storage** — Local disk and S3/MinIO/R2 uploads with folder organization
- **Real-Time** — GraphQL subscriptions (PubSub) + Socket.IO gateway for live events
- **Visitor Tracking** — Page view tracking with daily aggregated analytics
- **i18n** — Full internationalization for errors, validation messages, and email templates
- **Security** — CSRF protection, Helmet, rate limiting, CORS
- **Pagination** — Offset pagination with filtering and ordering on all list queries
- **Error Handling** — Structured GraphQL errors with translated messages, Prisma exception filter
- **Logging** — Auth event logging, GraphQL mutation/slow-query logging, slow Prisma query warnings
- **Health Checks** — `/api/health` endpoint
- **Swagger** — Auto-generated REST API docs at `/api/docs`

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL
- Redis (for BullMQ job queues)

Both services can be started with the included compose file instead of installing them locally:

```bash
docker compose up -d   # postgres:16 on 5432, redis:7 on 6379
```

### Installation

```bash
# Clone the template
git clone <repo-url> my-project
cd my-project

# Run the setup script — it will:
#   - Remove template .git history and init a fresh repo
#   - Rename the project in package.json, configs, and Swagger
#   - Create .env from .env.example with your database name
#   - Install dependencies and generate Prisma client
#   - Create an initial commit and remove the setup script
bash setup.sh

# Then: create your database, edit .env, and run migrations
createdb your_project_db
npx prisma migrate dev
npx prisma db seed

# Start development server
pnpm start:dev
```

#### Manual setup (if you prefer)

```bash
git clone <repo-url> my-project && cd my-project
rm -rf .git && git init
# Rename "nestjs-graphql-template" in package.json, env.validation.ts, main.ts
cp .env.example .env   # edit with your config
pnpm install
npx prisma generate
npx prisma migrate dev
npx prisma db seed
pnpm start:dev
```

The app starts at `http://localhost:3000/api` with GraphQL at `http://localhost:3000/api/graphql`.

### Environment Variables

See `.env.example` for all available configuration. Key ones:

| Variable             | Description                                       | Default      |
| -------------------- | ------------------------------------------------- | ------------ |
| `DATABASE_URL`       | PostgreSQL connection string                      | **required** |
| `JWT_ACCESS_SECRET`  | JWT signing secret (min 32 chars)                 | **required** |
| `JWT_REFRESH_SECRET` | Refresh token secret (min 32 chars)               | **required** |
| `REDIS_HOST`         | Redis host for BullMQ                             | `localhost`  |
| `MAIL_MAILER`        | Mail transport (`smtp` or leave empty for Resend) | —            |
| `STORAGE_DRIVER`     | File storage (`local` or `s3`)                    | `local`      |

## Deployment (Docker)

The multi-stage `Dockerfile` produces a production image: full install → `prisma generate` → webpack bundle (via `webpack.prod.config.js`, no HMR), then a slim runtime layer with production dependencies only. Migrations run automatically on container start.

```bash
# Single container (bring your own Postgres/Redis)
docker build -t my-api .
docker run --env-file .env -p 3005:3005 my-api

# Or the full stack in one command
docker compose -f docker-compose.prod.yml up -d --build
```

Notes:

- `prisma`, `pg`, `@prisma/adapter-pg`, and `dotenv` are production dependencies on purpose — the runtime constructs the client through the pg driver adapter and the CLI runs `migrate deploy` at boot.
- `src/i18n/` is copied into the image because nestjs-i18n reads translations from disk at runtime.
- Vite-style build-time config does not apply here: all configuration is runtime env vars (`--env-file .env`).

## Keeping your project up to date

Projects created from this template have **no automatic link back to it** — you own a divergent copy. Three ways to pull in template improvements, from manual to automated:

1. **Follow the releases.** Each [release](https://github.com/JayrousJr/backend-with-nesjs/releases) describes what changed and how to apply it to an existing project. Commits are small and conventional, so individual changes are easy to cherry-pick by hand.

2. **Template remote** (best adopted right after scaffolding, degrades as you diverge):

   ```bash
   git remote add template git@github.com:JayrousJr/backend-with-nesjs.git
   # when the template releases updates:
   git fetch template
   git merge template/main --allow-unrelated-histories
   ```

   Files you never touched merge cleanly; files you customized raise conflicts to resolve deliberately.

3. **Automated sync PRs** — install [`actions-template-sync`](https://github.com/AndreasAugustin/actions-template-sync) in your project and template changes arrive as reviewable pull requests on a schedule.

After significant divergence, most projects stop syncing wholesale and instead read the template's release diffs for ideas — that's expected and fine.

## Project Structure

```
src/
├── auth/                 # Authentication (JWT, sessions, password flows)
├── users/                # User management (CRUD, profile, avatar)
├── roles/                # Role management
├── permissions/          # Permission system (guards, decorators, constants)
├── mail/                 # Email queue (BullMQ + SMTP/Resend)
├── newsletter/           # Newsletter subscription
├── campaigns/            # Campaign management + scheduled sends
├── storage/              # File upload (local/S3 drivers)
├── health/               # Health check endpoint
├── prisma/               # Prisma service + extensions
├── config/               # App config service + env validation
├── i18n/                 # Translation files (en/, sw/)
│   ├── en/
│   │   ├── errors.json
│   │   ├── validation.json
│   │   └── mail.json
│   └── sw/               # Add more locales here
├── common/               # Shared infrastructure
│   ├── context/          # RequestContext (AsyncLocalStorage)
│   ├── decorators/       # @AuthUser(), @Public()
│   ├── dto/              # BaseFilterInput, PaginationInput, response wrappers
│   ├── entities/         # BaseEntity (GraphQL)
│   ├── filters/          # GqlHttpExceptionFilter, PrismaExceptionFilter
│   ├── guards/           # GqlThrottlerGuard
│   ├── interceptors/     # RequestContext, GqlLogging
│   ├── repositories/     # BaseRepository
│   └── resolvers/        # UserLocaleResolver (i18n)
└── main.ts               # Bootstrap (middleware, pipes, CSRF, prefix)
```

## Authentication

### REST Endpoints (`/api/auth`)

| Method | Endpoint               | Auth   | Description                         |
| ------ | ---------------------- | ------ | ----------------------------------- |
| POST   | `/register`            | Public | Register + sends verification email |
| POST   | `/verify-email`        | Public | Verify email with token             |
| POST   | `/resend-verification` | Public | Resend verification email           |
| POST   | `/login`               | Public | Returns access + refresh tokens     |
| POST   | `/refresh`             | Public | Rotate refresh token                |
| POST   | `/logout`              | Public | Revoke single session               |
| POST   | `/logout-all`          | Bearer | Revoke all sessions                 |
| POST   | `/forgot-password`     | Public | Sends password reset email          |
| POST   | `/reset-password`      | Public | Reset password with token           |
| POST   | `/change-password`     | Bearer | Change password (requires current)  |
| GET    | `/sessions`            | Bearer | List active sessions                |
| GET    | `/google`              | Public | Start Google OAuth (302 to consent) |
| GET    | `/google/callback`     | Public | OAuth callback — redirects to SPA   |

**Google OAuth** is disabled (endpoints 404) unless `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. The flow is implemented directly in `auth/google-oauth.service.ts` (no passport strategy): a state cookie guards CSRF, the callback exchanges the code and signs the user in — creating a verified account on first login — then redirects to `FRONTEND_URL/auth/callback` with tokens in the URL fragment. Replicate the service to add another provider.
| DELETE | `/sessions/:id` | Bearer | Revoke specific session |

### GraphQL Mutations

Auth is also available via GraphQL mutations: `registerUser`, `verifyEmail`, `login`, `forgotPassword`, `resetPassword`, `changePassword`.

### Account Lockout

After 5 failed login attempts, the account is locked for 15 minutes. These are configurable via `MAX_LOGIN_ATTEMPTS` and `LOCKOUT_DURATION_MS` in `auth.service.ts`.

### JWT Flow

1. Login returns `{ accessToken, refreshToken }`
2. Use `Authorization: Bearer <accessToken>` for authenticated requests
3. When access token expires, call `/refresh` with the refresh token
4. Each refresh rotates the session — old refresh token is revoked

## Security notes

Defaults that matter when you deploy this:

- **Refresh token in an HttpOnly cookie** (`SameSite` via `COOKIE_SAMESITE`, `strict` by default; set `none` + HTTPS only if the SPA is on a different registrable domain). Login/refresh return just the access token — the refresh token is never exposed to JavaScript. SameSite is also what protects the cookie-authenticated refresh/logout routes from CSRF.
- **Access tokens are short-lived** (`JWT_ACCESS_EXPIRES_IN`, 15m) and sessions are server-side and individually revocable.
- **Swagger is off in production** unless `SWAGGER_ENABLED=true` is set explicitly.
- **Uploads** are restricted to an allowlist (`storage.constants.ts`); the stored extension comes from the validated MIME type, not the filename, and SVG is excluded because it can carry script. Downloads are path-contained to the uploads root and sent as attachments unless the type is known-safe inline.
- **`TRUST_PROXY`** must be set to the number of proxy hops (nginx = 1) or client IPs in session records and rate limits will be the proxy's. It defaults to 0 — never trust `X-Forwarded-For` blindly.
- **`docker-compose.prod.yml` requires `POSTGRES_PASSWORD` and `REDIS_PASSWORD`** and refuses to start without them; Redis runs with `requirepass`, and neither datastore publishes a host port.

## Module Architecture

Every feature module follows the same structure:

```
src/my-module/
├── my-module.module.ts          # NestJS module definition
├── my-module.service.ts         # Business logic
├── my-module.resolver.ts        # GraphQL queries + mutations
├── my-module.repository.ts      # Prisma data access
├── entities/
│   └── my-entity.entity.ts      # GraphQL ObjectType
└── dto/
    ├── my-entity.types.ts        # InputTypes (Create, Update)
    ├── my-entity.filters.ts      # FilterInput, OrderInput, where/orderBy builders
    └── my-entity.responses.ts    # MutationResponse, ListResponse wrappers
```

If the module needs REST endpoints, add a controller:

```
├── my-module.controller.ts      # REST endpoints
```

## Creating a New Module

### 1. Prisma Schema

Add your model to `prisma/schema.prisma` with the standard base fields:

```prisma
model Product {
  id       Int    @id @default(autoincrement())
  uniqueId String @unique @default(uuid(7)) @map("unique_id")

  name        String
  description String?
  price       Int

  createdById Int?      @map("created_by_id")
  updatedById Int?      @map("updated_by_id")
  deletedById Int?      @map("deleted_by_id")
  isDeleted   Boolean   @default(false) @map("is_deleted")
  isActive    Boolean   @default(true) @map("is_active")
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")
  deletedAt   DateTime? @map("deleted_at")

  @@map("products")
}
```

Run the migration:

```bash
npx prisma migrate dev --name add-products
npx prisma generate
```

### 2. Entity (GraphQL ObjectType)

```typescript
// src/products/entities/product.entity.ts
import { ObjectType, Field, Int } from '@nestjs/graphql';
import { BaseEntity } from '@common';

@ObjectType()
export class ProductEntity extends BaseEntity {
  @Field(() => String)
  name?: string;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field(() => Int)
  price?: number;
}
```

`BaseEntity` already provides `uniqueId`, `isActive`, `createdAt`, `updatedAt` and hides `id`, `isDeleted`, audit fields.

### 3. DTOs (InputTypes)

```typescript
// src/products/dto/product.types.ts
import { Field, InputType, Int } from '@nestjs/graphql';
import { IsOptional, IsString, IsInt, Min } from 'class-validator';
import { i18nValidationMessage } from 'nestjs-i18n';

@InputType()
export class CreateProductInput {
  @Field(() => String)
  @IsString({ message: i18nValidationMessage('validation.isString') })
  name!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  description?: string;

  @Field(() => Int)
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(0, { message: i18nValidationMessage('validation.min') })
  price!: number;
}

@InputType()
export class UpdateProductInput {
  @Field(() => String)
  @IsString({ message: i18nValidationMessage('validation.isString') })
  uniqueId!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  name?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(0, { message: i18nValidationMessage('validation.min') })
  price?: number;
}
```

All validators use `i18nValidationMessage()` for translated error messages.

### 4. Filters & Ordering

```typescript
// src/products/dto/product.filters.ts
import { Field, InputType, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsOptional } from 'class-validator';
import { Prisma } from '@db';
import { BaseFilterInput, OrderDirection, buildBaseWhere } from '@common';
import { i18nValidationMessage } from 'nestjs-i18n';

export enum ProductOrderField {
  NAME = 'name',
  PRICE = 'price',
  CREATED_AT = 'createdAt',
}
registerEnumType(ProductOrderField, { name: 'ProductOrderField' });

@InputType()
export class ProductFilterInput extends BaseFilterInput {
  @IsOptional()
  @Field(() => String, { nullable: true })
  name?: string;
}

@InputType()
export class ProductOrderInput {
  @IsEnum(ProductOrderField, {
    message: i18nValidationMessage('validation.isEnum'),
  })
  @Field(() => ProductOrderField, {
    defaultValue: ProductOrderField.CREATED_AT,
  })
  field: ProductOrderField = ProductOrderField.CREATED_AT;

  @IsEnum(OrderDirection, {
    message: i18nValidationMessage('validation.isEnum'),
  })
  @Field(() => OrderDirection, { defaultValue: OrderDirection.DESC })
  direction: OrderDirection = OrderDirection.DESC;
}

export function buildProductWhere(
  filter?: ProductFilterInput,
): Prisma.ProductWhereInput {
  return {
    ...buildBaseWhere(filter),
    ...(filter?.name && {
      name: { contains: filter.name, mode: 'insensitive' },
    }),
  };
}

export function buildProductOrderBy(
  orderBy?: ProductOrderInput,
): Prisma.ProductOrderByWithRelationInput {
  if (!orderBy) return { createdAt: 'desc' };
  const direction = orderBy.direction === OrderDirection.ASC ? 'asc' : 'desc';
  return {
    [orderBy.field]: direction,
  } as Prisma.ProductOrderByWithRelationInput;
}
```

`BaseFilterInput` provides `uniqueId`, `isActive`, and `dateRange` filters for free.

### 5. Response Wrappers

```typescript
// src/products/dto/product.responses.ts
import { ObjectType } from '@nestjs/graphql';
import { MutationResponse, QueryListResponse } from '@common';
import { ProductEntity } from '../entities/product.entity';

@ObjectType()
export class ProductMutationResponse extends MutationResponse(ProductEntity) {}

@ObjectType()
export class ProductListResponse extends QueryListResponse(ProductEntity) {}
```

`MutationResponse` gives `{ message, data }`. `QueryListResponse` gives `{ data[], total, page, limit, totalPages, hasNextPage, hasPrevPage }`.

### 6. Repository

```typescript
// src/products/product.repository.ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@db';
import { BaseRepository } from '@common';
import { PrismaService } from '@prisma';

@Injectable()
export class ProductRepository extends BaseRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  protected get delegate() {
    return this.prisma.db.product;
  }

  async create(data: Prisma.ProductCreateInput) {
    return this.execute(this.delegate.create({ data }));
  }

  async findByUniqueId(uniqueId: string) {
    return this.execute(this.delegate.findUnique({ where: { uniqueId } }));
  }

  async findMany(args: {
    where?: Prisma.ProductWhereInput;
    orderBy?: Prisma.ProductOrderByWithRelationInput;
    skip?: number;
    take?: number;
  }) {
    return this.execute(this.delegate.findMany(args));
  }

  async count(where?: Prisma.ProductWhereInput) {
    return this.execute(this.delegate.count({ where }));
  }

  async updateByUniqueId(uniqueId: string, data: Prisma.ProductUpdateInput) {
    return this.execute(this.delegate.update({ where: { uniqueId }, data }));
  }
}
```

`BaseRepository` provides `softDelete()`, `restore()`, `activate()`, `deactivate()`, and `execute()` with Prisma error handling.

### 7. Service

```typescript
// src/products/products.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PaginationInput, offsetPaginate } from '@common';
import { ProductRepository } from './product.repository';
import { CreateProductInput, UpdateProductInput } from './dto/product.types';
import {
  ProductFilterInput,
  ProductOrderInput,
  buildProductWhere,
  buildProductOrderBy,
} from './dto/product.filters';

@Injectable()
export class ProductsService {
  constructor(private readonly products: ProductRepository) {}

  getProducts(
    filter?: ProductFilterInput,
    orderBy?: ProductOrderInput,
    pagination?: PaginationInput,
  ) {
    const where = buildProductWhere(filter);
    const order = buildProductOrderBy(orderBy);
    return offsetPaginate(
      (args) => this.products.findMany({ ...args, where, orderBy: order }),
      () => this.products.count(where),
      pagination,
    );
  }

  async getProduct(uniqueId: string) {
    const product = await this.products.findByUniqueId(uniqueId);
    if (!product) throw new NotFoundException('errors.record_not_found');
    return product;
  }

  async createProduct(input: CreateProductInput) {
    return this.products.create(input);
  }

  async updateProduct(input: UpdateProductInput) {
    const { uniqueId, ...data } = input;
    return this.products.updateByUniqueId(uniqueId, data);
  }

  async deleteProduct(uniqueId: string) {
    await this.products.softDelete(uniqueId);
  }
}
```

### 8. GraphQL Resolver

```typescript
// src/products/products.resolver.ts
import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { PERMISSIONS, RequirePermission } from '@permissions';
import { PaginationInput } from '@common';
import { ProductsService } from './products.service';
import { ProductEntity } from './entities/product.entity';
import {
  ProductListResponse,
  ProductMutationResponse,
} from './dto/product.responses';
import { CreateProductInput, UpdateProductInput } from './dto/product.types';
import { ProductFilterInput, ProductOrderInput } from './dto/product.filters';

@Resolver(() => ProductEntity)
export class ProductsResolver {
  constructor(private readonly productsService: ProductsService) {}

  @RequirePermission(PERMISSIONS.PRODUCTS.READ)
  @Query(() => ProductListResponse, { name: 'getProducts' })
  getProducts(
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
    @Args('filter', { type: () => ProductFilterInput, nullable: true })
    filter?: ProductFilterInput,
    @Args('orderBy', { type: () => ProductOrderInput, nullable: true })
    orderBy?: ProductOrderInput,
  ) {
    return this.productsService.getProducts(filter, orderBy, pagination);
  }

  @RequirePermission(PERMISSIONS.PRODUCTS.MANAGE)
  @Mutation(() => ProductMutationResponse)
  async createProduct(@Args('input') input: CreateProductInput) {
    const data = await this.productsService.createProduct(input);
    return { data, message: 'Product created successfully' };
  }

  @RequirePermission(PERMISSIONS.PRODUCTS.MANAGE)
  @Mutation(() => ProductMutationResponse)
  async updateProduct(@Args('input') input: UpdateProductInput) {
    const data = await this.productsService.updateProduct(input);
    return { data, message: 'Product updated successfully' };
  }

  @RequirePermission(PERMISSIONS.PRODUCTS.MANAGE)
  @Mutation(() => Boolean)
  async deleteProduct(
    @Args('uniqueId', { type: () => String }) uniqueId: string,
  ) {
    await this.productsService.deleteProduct(uniqueId);
    return true;
  }
}
```

### 9. REST Controller (optional)

If your module needs REST endpoints alongside GraphQL:

```typescript
// src/products/products.controller.ts
import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateProductInput } from './dto/product.types';

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  getProducts() {
    return this.productsService.getProducts();
  }

  @Get(':uniqueId')
  getProduct(@Param('uniqueId') uniqueId: string) {
    return this.productsService.getProduct(uniqueId);
  }

  @Post()
  createProduct(@Body() input: CreateProductInput) {
    return this.productsService.createProduct(input);
  }
}
```

Use `@Public()` to skip JWT auth. Use `@AuthUser()` to get the current user. REST docs appear automatically in Swagger at `/api/docs`.

### 10. Module & Registration

```typescript
// src/products/products.module.ts
import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsResolver } from './products.resolver';
import { ProductRepository } from './product.repository';

@Module({
  providers: [ProductsResolver, ProductsService, ProductRepository],
  exports: [ProductsService],
})
export class ProductsModule {}
```

Register in `src/app.module.ts`:

```typescript
import { ProductsModule } from './products/products.module';

@Module({
  imports: [
    // ... existing modules
    ProductsModule,
  ],
})
export class AppModule {}
```

### 11. Permissions

Add to `src/permissions/permission.constants.ts`:

```typescript
export const PERMISSIONS = {
  // ... existing
  PRODUCTS: {
    READ: 'products.read',
    MANAGE: 'products.manage',
  },
} as const;
```

Permissions are auto-seeded from `ALL_PERMISSIONS` during `prisma db seed`.

## File Uploads

Files are uploaded via REST and referenced in GraphQL mutations by `uniqueId`.

```bash
# Upload with folder organization
curl -X POST http://localhost:3000/api/files/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@photo.jpg" \
  -F "folder=images/profiles"

# Bulk upload (max 10)
curl -X POST http://localhost:3000/api/files/upload-many \
  -H "Authorization: Bearer <token>" \
  -F "files=@img1.jpg" -F "files=@img2.png" \
  -F "folder=images/gallery"
```

To attach files to a model, add a `fileId` FK to your Prisma model and resolve the `uniqueId` in your service (see `User.avatarId` for an example).

## Real-Time (WebSockets & Subscriptions)

The template includes two real-time channels via the global `EventsModule`:

### GraphQL Subscriptions

Built on `graphql-ws`. Any module can publish events via `PubSubService`:

```typescript
// In any service:
constructor(private readonly pubsub: PubSubService) {}

this.pubsub.publish('notification', {
  onNotification: {
    type: 'campaign',
    title: 'Campaign sent',
    body: 'Your campaign reached 150 subscribers',
    resourceId: campaign.uniqueId,
  },
});
```

Client subscribes in GraphQL:

```graphql
subscription {
  onNotification {
    type
    title
    body
    resourceId
  }
}
```

To add a new subscription, add a `@Subscription()` method in any resolver:

```typescript
@Subscription(() => MyEventType)
onMyEvent() {
  return this.pubsub.asyncIterator('myEvent');
}
```

### Socket.IO Gateway

A WebSocket gateway at `/ws` for raw real-time features (presence, typing indicators, live updates). Any module can inject `EventsGateway`:

```typescript
// In any service:
constructor(private readonly events: EventsGateway) {}

// Send to a specific user (all their connected devices)
this.events.emitToUser(userId, 'profile:updated', { avatar: newUrl });

// Broadcast to everyone
this.events.broadcast('system:maintenance', { startsAt: '...' });

// Check presence
this.events.isUserOnline(userId);
this.events.getOnlineUserCount();
```

Client connection (JavaScript):

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000/ws', {
  auth: { token: 'your-jwt-access-token' },
});

socket.on('profile:updated', (data) => console.log(data));
socket.on('system:maintenance', (data) => showBanner(data));
```

Authentication is handled via the JWT token in the handshake — unauthenticated connections are rejected.

## Visitor Tracking

Track page views and aggregate visitor statistics. The frontend sends a tracking event on every route change.

### Track a page view (public, no auth required)

```graphql
mutation {
  trackPageView(
    input: {
      path: "/dashboard"
      sessionId: "uuid-from-localstorage"
      referrer: "https://google.com"
    }
  ) {
    id
    path
    createdAt
  }
}
```

The `sessionId` is a UUID generated by the frontend and stored in `localStorage` — it groups anonymous page views from the same browser. If the user is logged in (JWT present), the page view is automatically linked to their account. IP is hashed for privacy.

### Query raw page views (admin, `analytics.read`)

```graphql
query {
  getPageViews(
    filter: { path: "/dashboard", from: "2026-06-01", to: "2026-06-19" }
    pagination: { page: 1, limit: 20 }
  ) {
    data {
      path
      sessionId
      userAgent
      country
      userId
      createdAt
    }
    total
    totalPages
  }
}
```

### Query aggregated stats (admin, `analytics.read`)

```graphql
query {
  getVisitorStats(filter: { from: "2026-06-01" }) {
    data {
      date
      path
      viewCount
      uniqueVisitorCount
    }
    total
  }
}
```

A daily cron job runs at midnight to aggregate yesterday's raw page views into `VisitorStat` summary rows (total views + unique visitors per path per day).

## i18n

Translation files live in `src/i18n/{locale}/`. Three namespaces:

- `errors.json` — error messages (used in exception filters)
- `validation.json` — validation constraint messages (used in DTOs)
- `mail.json` — email template strings

Locale resolution priority: user's `preferredLocale` > `x-lang` header > `Accept-Language` header > `'en'`.

To add a new locale, create a new directory (e.g., `src/i18n/fr/`) with the three JSON files.

## Existing Modules

| Module        | Type           | Description                                                |
| ------------- | -------------- | ---------------------------------------------------------- |
| `auth`        | REST + GraphQL | JWT auth, email verification, password flows, sessions     |
| `users`       | GraphQL        | User CRUD, profile, avatar, role/permission assignment     |
| `roles`       | GraphQL        | Role CRUD with permission management                       |
| `permissions` | GraphQL        | Permission listing, guards, decorators                     |
| `newsletter`  | GraphQL        | User newsletter subscription (opt-in/out)                  |
| `campaigns`   | GraphQL        | Admin campaign CRUD, immediate + scheduled sends           |
| `storage`     | REST + GraphQL | File upload (local/S3), download, metadata queries         |
| `events`      | WebSocket      | GraphQL subscriptions (PubSub) + Socket.IO gateway         |
| `visitors`    | GraphQL        | Page view tracking, daily aggregated stats, analytics cron |
| `mail`        | Internal       | BullMQ email queue, SMTP/Resend, i18n templates            |
| `health`      | REST           | Health check at `/api/health`                              |
