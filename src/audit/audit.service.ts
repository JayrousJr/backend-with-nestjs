import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@db';
import { PrismaService, type DbTx } from '@prisma';
import { RequestContext } from '@common';

/** Fields never written to the audit log. */
const REDACTED_KEYS = new Set([
  'password',
  'twoFactorSecret',
  'tokenHash',
  'hash',
]);

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
  /** "by X on behalf of Y" when acting under a delegation. */
  onBehalfOfUserId?: number | null;
}

function sanitize(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (key, v: unknown) => {
      if (REDACTED_KEYS.has(key)) return undefined;
      if (typeof v === 'bigint') return v.toString();
      return v;
    }),
  ) as Prisma.InputJsonValue;
}

/**
 * Append-only audit log: who, when, action, record, before/after, IP,
 * on-behalf-of. Kept forever. Failures are logged but never block the
 * business action — except they are loud, because a missing audit entry
 * is a compliance problem.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry, tx?: DbTx): Promise<void> {
    const user = RequestContext.getUser();
    const client = tx ?? this.prisma.dbRaw;
    try {
      await client.auditLog.create({
        data: {
          actorUserId: user?.id,
          actorDepartmentId: user?.departmentId,
          onBehalfOfUserId:
            entry.onBehalfOfUserId ?? RequestContext.getOnBehalfOf(),
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId == null ? undefined : String(entry.entityId),
          before: sanitize(entry.before),
          after: sanitize(entry.after),
          ipAddress: RequestContext.getIpAddress(),
          requestId: RequestContext.getRequestId(),
        },
      });
    } catch (error) {
      this.logger.error(
        `AUDIT WRITE FAILED for ${entry.action} ${entry.entityType}#${entry.entityId}: ${error}`,
      );
      if (tx) throw error;
    }
  }
}
