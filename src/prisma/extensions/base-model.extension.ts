import { PrismaClient } from '@db';
import { RequestContext } from '@common';
import bcrypt from 'bcrypt';

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$/;

/**
 * Models carrying the shared audit columns (isActive, isDeleted, createdById,
 * updatedById, deletedById — see BaseEntity/BaseFilterInput). Pure log/aggregate
 * tables like PageView and VisitorStat intentionally don't have these columns,
 * so this extension must only touch models in this set — otherwise Prisma
 * throws "Unknown argument" for the injected field. Keep in sync with
 * prisma/schema.prisma (models extending the audit fields).
 */
const AUDITED_MODELS = new Set([
  'Department',
  'ActingAssignment',
  'JobTitle',
  'EmploymentType',
  'Employee',
  'DriverProfile',
  'User',
  'Session',
  'Role',
  'UserGroup',
  'Delegation',
  'Notification',
  'File',
  'ProductCategory',
  'Product',
  'Store',
  'Asset',
]);

async function hashPasswordField(data: unknown): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const record = data as Record<string, unknown>;
  if (
    typeof record.password === 'string' &&
    !BCRYPT_HASH_PATTERN.test(record.password)
  ) {
    record.password = await bcrypt.hash(record.password, 12);
  }
}

export function applyBaseModelExtension(client: PrismaClient) {
  return client.$extends({
    query: {
      $allModels: {
        async findMany({ model, args, query }) {
          if (AUDITED_MODELS.has(model)) {
            args.where = { ...args.where, isDeleted: false };
          }
          return query(args);
        },
        async findFirst({ model, args, query }) {
          if (AUDITED_MODELS.has(model)) {
            args.where = { ...args.where, isDeleted: false };
          }
          return query(args);
        },
        async count({ model, args, query }) {
          if (AUDITED_MODELS.has(model)) {
            args.where = { ...args.where, isDeleted: false };
          }
          return query(args);
        },
        async create({ model, args, query }) {
          const userId = RequestContext.getUserId();
          if (userId && AUDITED_MODELS.has(model)) {
            (args.data as Record<string, unknown>).createdById = userId;
          }
          await hashPasswordField(args.data);
          return query(args);
        },
        async update({ model, args, query }) {
          const userId = RequestContext.getUserId();
          if (userId && AUDITED_MODELS.has(model)) {
            (args.data as Record<string, unknown>).updatedById = userId;
          }
          await hashPasswordField(args.data);
          return query(args);
        },
        async updateMany({ model, args, query }) {
          const userId = RequestContext.getUserId();
          if (userId && AUDITED_MODELS.has(model)) {
            (args.data as Record<string, unknown>).updatedById = userId;
          }
          await hashPasswordField(args.data);
          return query(args);
        },
      },
    },
  });
}

export type ExtendedPrismaClient = ReturnType<typeof applyBaseModelExtension>;
