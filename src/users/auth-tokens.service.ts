import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthTokenType } from '@db';
import { PrismaService, type DbTx } from '@prisma';

export const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** Single-use activation / reset tokens; only hashes are stored. */
@Injectable()
export class AuthTokensService {
  constructor(private readonly prisma: PrismaService) {}

  /** Issue a new token, invalidating earlier unused ones of the same type. */
  async issue(
    userId: number,
    type: AuthTokenType,
    validMs: number,
    tx?: DbTx,
  ): Promise<string> {
    const db = tx ?? this.prisma.dbRaw;
    const now = new Date();
    await db.authToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: now },
    });
    const token = randomBytes(32).toString('hex');
    await db.authToken.create({
      data: {
        userId,
        type,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + validMs),
      },
    });
    return token;
  }

  /** Returns the token row if valid (unused, unexpired, right type). */
  async find(token: string, type: AuthTokenType) {
    const row = await this.prisma.dbRaw.authToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!row || row.type !== type || row.usedAt || row.expiresAt < new Date()) {
      return null;
    }
    return row;
  }

  async consume(id: number, tx?: DbTx) {
    await (tx ?? this.prisma.dbRaw).authToken.update({
      where: { id },
      data: { usedAt: new Date() },
    });
  }
}
