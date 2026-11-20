import { Injectable } from '@nestjs/common';
import { PrismaService } from '@prisma';
import { Session } from '@db';

@Injectable()
export class SessionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    userId: number;
    expiresAt: Date;
    absoluteExpiresAt: Date;
    userAgent?: string;
    ipAddress?: string;
  }): Promise<Session> {
    return this.prisma.db.session.create({ data });
  }

  findActiveByUniqueId(uniqueId: string): Promise<Session | null> {
    const now = new Date();
    return this.prisma.db.session.findFirst({
      where: {
        uniqueId,
        isActive: true,
        expiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
    });
  }

  async revoke(uniqueId: string): Promise<void> {
    await this.prisma.db.session.updateMany({
      where: { uniqueId, isDeleted: false },
      data: { isDeleted: true, deletedAt: new Date() },
    });
  }

  findAllActiveForUser(userId: number) {
    const now = new Date();
    return this.prisma.db.session.findMany({
      where: {
        userId,
        expiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
      select: {
        uniqueId: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  findActiveByUniqueIdAndUser(
    uniqueId: string,
    userId: number,
  ): Promise<Session | null> {
    return this.prisma.db.session.findFirst({
      where: { uniqueId, userId, expiresAt: { gt: new Date() } },
    });
  }

  async revokeAllForUser(userId: number, exceptUniqueId?: string) {
    await this.prisma.db.session.updateMany({
      where: {
        userId,
        isDeleted: false,
        ...(exceptUniqueId && { uniqueId: { not: exceptUniqueId } }),
      },
      data: { isDeleted: true, deletedAt: new Date() },
    });
  }
}
