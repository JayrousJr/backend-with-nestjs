# Production image — multi-stage, ~250MB final.
# node:22-slim (glibc) rather than alpine: bcrypt's prebuilt binaries work
# out of the box, no node-gyp toolchain needed.
#
#   docker build -t backend-template .
#   docker run --env-file .env -p 3005:3005 backend-template
#
# Migrations run automatically on container start (prisma migrate deploy).

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# ---- build: full install, prisma generate, webpack bundle ----
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm db:generate && pnpm build:prod

# ---- prod-deps: production node_modules only ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# ---- runner ----
FROM node:22-slim AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/generated ./generated
COPY package.json ./
COPY prisma ./prisma
# nestjs-i18n reads translations from disk at runtime (process.cwd()/src/i18n)
COPY src/i18n ./src/i18n

EXPOSE 3005

CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/main.js"]
