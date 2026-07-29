import { BaseRepository } from '@common';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@prisma';
import { Prisma } from '@db';

@Injectable()
export class RedirectRepository extends BaseRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  protected get delegate() {
    return this.prisma.db.redirect;
  }

  async upsert(fromPath: string, toPath: string, statusCode = 301) {
    return this.execute(
      this.delegate.upsert({
        where: { fromPath },
        update: { toPath, statusCode, isDeleted: false, deletedAt: null },
        create: { fromPath, toPath, statusCode },
      }),
    );
  }

  async findByPath(fromPath: string) {
    return this.execute(this.delegate.findFirst({ where: { fromPath } }));
  }

  async recordHit(id: number) {
    // dbRaw: a plain counter bump shouldn't stamp updatedBy/updatedAt.
    return this.prisma.dbRaw.redirect.update({
      where: { id },
      data: { hitCount: { increment: 1 } },
    });
  }

  async findMany(args: {
    where?: Prisma.RedirectWhereInput;
    skip?: number;
    take?: number;
  }) {
    return this.execute(
      this.delegate.findMany({ ...args, orderBy: { createdAt: 'desc' } }),
    );
  }

  async count(where?: Prisma.RedirectWhereInput) {
    return this.execute(this.delegate.count({ where }));
  }
}
