import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ApprovalMode, ApproverType, Prisma } from '@db';
import { PrismaService } from '@prisma';
import type { CurrentUser } from '@common';
import { AuditService } from '../audit/audit.service';
import { APPROVAL_POINTS, ASSIGNEE_RULES } from './point-catalogue';

export interface StepInput {
  code: string;
  name: string;
  approverType: ApproverType;
  /** USER / GROUP / ROLE uniqueId. */
  approverUniqueId?: string;
  /** RULE code. */
  rule?: string;
  mode: ApprovalMode;
  requiredCount?: number;
  allowDelegation: boolean;
  /** JSON {path, op, value} or empty. */
  condition?: string;
  slaHours?: number;
}

const VERSION_INCLUDE = {
  steps: { orderBy: { order: 'asc' } },
} as const satisfies Prisma.ApprovalChainVersionInclude;

type VersionRow = Prisma.ApprovalChainVersionGetPayload<{
  include: typeof VERSION_INCLUDE;
}>;

/** Configuring approval chains: draft → activate (workflow.manage/activate). */
@Injectable()
export class ChainsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async labels(versions: VersionRow[]) {
    const steps = versions.flatMap((v) => v.steps);
    const [users, groups, roles] = await Promise.all([
      this.prisma.db.user.findMany({
        where: { id: { in: steps.flatMap((s) => s.approverUserId ?? []) } },
        include: { employee: true },
      }),
      this.prisma.db.userGroup.findMany({
        where: { id: { in: steps.flatMap((s) => s.approverGroupId ?? []) } },
      }),
      this.prisma.db.role.findMany({
        where: { id: { in: steps.flatMap((s) => s.approverRoleId ?? []) } },
      }),
    ]);
    return (s: VersionRow['steps'][number]) => {
      switch (s.approverType) {
        case 'USER': {
          const u = users.find((x) => x.id === s.approverUserId);
          return {
            uniqueId: u?.uniqueId ?? null,
            label: u
              ? `${u.employee.firstName} ${u.employee.lastName}`
              : '(missing user)',
          };
        }
        case 'GROUP': {
          const g = groups.find((x) => x.id === s.approverGroupId);
          return {
            uniqueId: g?.uniqueId ?? null,
            label: g ? `Group: ${g.name}` : '(missing group)',
          };
        }
        case 'ROLE': {
          const r = roles.find((x) => x.id === s.approverRoleId);
          return {
            uniqueId: r?.uniqueId ?? null,
            label: r ? `Role: ${r.name}` : '(missing role)',
          };
        }
        default:
          return {
            uniqueId: null,
            label:
              ASSIGNEE_RULES[s.rule as keyof typeof ASSIGNEE_RULES] ??
              s.rule ??
              '',
          };
      }
    };
  }

  private async presentVersions(versions: VersionRow[]) {
    const label = await this.labels(versions);
    return versions.map((v) => ({
      uniqueId: v.uniqueId,
      version: v.version,
      status: v.status,
      activatedAt: v.activatedAt,
      createdAt: v.createdAt,
      steps: v.steps.map((s) => ({
        order: s.order,
        code: s.code,
        name: s.name,
        approverType: s.approverType,
        approverUniqueId: label(s).uniqueId,
        approverLabel: label(s).label,
        rule: s.rule,
        mode: s.mode,
        requiredCount: s.requiredCount,
        allowDelegation: s.allowDelegation,
        condition: s.condition == null ? null : JSON.stringify(s.condition),
        slaHours: s.slaHours,
      })),
    }));
  }

  async points() {
    const rows = await this.prisma.db.approvalPoint.findMany({
      orderBy: [{ module: 'asc' }, { code: 'asc' }],
      include: {
        activeVersion: { include: VERSION_INCLUDE },
        versions: { where: { status: 'DRAFT' }, select: { id: true } },
        _count: { select: { requests: { where: { status: 'PENDING' } } } },
      },
    });
    return Promise.all(
      rows.map(async (p) => ({
        code: p.code,
        module: p.module,
        name: p.name,
        description: p.description,
        registered: p.code in APPROVAL_POINTS,
        activeVersion: p.activeVersion
          ? (await this.presentVersions([p.activeVersion]))[0]
          : null,
        hasDraft: p.versions.length > 0,
        pendingRequests: p._count.requests,
      })),
    );
  }

  async point(code: string) {
    const p = await this.prisma.db.approvalPoint.findUnique({
      where: { code },
      include: {
        versions: { include: VERSION_INCLUDE, orderBy: { version: 'desc' } },
      },
    });
    if (!p) throw new NotFoundException('errors.record_not_found');
    return {
      code: p.code,
      module: p.module,
      name: p.name,
      description: p.description,
      versions: await this.presentVersions(p.versions),
    };
  }

  private async stepData(steps: StepInput[]) {
    const out: Omit<Prisma.ApprovalStepCreateManyInput, 'versionId'>[] = [];
    const codes = new Set<string>();
    for (const [i, s] of steps.entries()) {
      if (codes.has(s.code))
        throw new BadRequestException('errors.step_code_duplicate');
      codes.add(s.code);
      const ref: Partial<Prisma.ApprovalStepCreateManyInput> = {};
      const db = this.prisma.db;
      if (s.approverType === 'USER') {
        const u = await db.user.findFirst({
          where: { uniqueId: s.approverUniqueId ?? '' },
        });
        if (!u) throw new BadRequestException('errors.step_approver_missing');
        ref.approverUserId = u.id;
      } else if (s.approverType === 'GROUP') {
        const g = await db.userGroup.findFirst({
          where: { uniqueId: s.approverUniqueId ?? '' },
        });
        if (!g) throw new BadRequestException('errors.step_approver_missing');
        ref.approverGroupId = g.id;
      } else if (s.approverType === 'ROLE') {
        const r = await db.role.findFirst({
          where: { uniqueId: s.approverUniqueId ?? '' },
        });
        if (!r) throw new BadRequestException('errors.step_approver_missing');
        ref.approverRoleId = r.id;
      } else {
        if (!s.rule || !(s.rule in ASSIGNEE_RULES)) {
          throw new BadRequestException('errors.step_approver_missing');
        }
        ref.rule = s.rule;
      }
      let condition: Prisma.InputJsonValue | undefined;
      if (s.condition?.trim()) {
        try {
          const c = JSON.parse(s.condition) as { path?: unknown; op?: unknown };
          if (
            typeof c.path !== 'string' ||
            !['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'].includes(
              String(c.op),
            )
          ) {
            throw new Error();
          }
          condition = c as Prisma.InputJsonValue;
        } catch {
          throw new BadRequestException('errors.step_condition_invalid');
        }
      }
      if (s.mode === 'N_OF_M' && (!s.requiredCount || s.requiredCount < 1)) {
        throw new BadRequestException('errors.step_required_count');
      }
      out.push({
        order: i + 1,
        code: s.code.trim(),
        name: s.name.trim(),
        approverType: s.approverType,
        ...ref,
        mode: s.mode,
        requiredCount: s.mode === 'N_OF_M' ? s.requiredCount! : 1,
        allowDelegation: s.allowDelegation,
        condition,
        slaHours: s.slaHours ?? null,
      });
    }
    return out;
  }

  /** Create or replace the point's draft version. */
  async saveDraft(actor: CurrentUser, code: string, steps: StepInput[]) {
    const p = await this.prisma.db.approvalPoint.findUnique({
      where: { code },
      include: { versions: true },
    });
    if (!p) throw new NotFoundException('errors.record_not_found');
    const data = await this.stepData(steps);
    const draft = p.versions.find((v) => v.status === 'DRAFT');
    await this.prisma.db.$transaction(async (tx) => {
      let versionId: number;
      if (draft) {
        await tx.approvalStep.deleteMany({ where: { versionId: draft.id } });
        versionId = draft.id;
      } else {
        const max = Math.max(0, ...p.versions.map((v) => v.version));
        versionId = (
          await tx.approvalChainVersion.create({
            data: { pointId: p.id, version: max + 1, createdById: actor.id },
          })
        ).id;
      }
      await tx.approvalStep.createMany({
        data: data.map((d) => ({ ...d, versionId })),
      });
      await this.audit.log(
        {
          action: 'workflow.save_draft',
          entityType: 'ApprovalPoint',
          entityId: code,
          after: data,
        },
        tx,
      );
    });
    return this.point(code);
  }

  async discardDraft(actor: CurrentUser, code: string) {
    const draft = await this.prisma.db.approvalChainVersion.findFirst({
      where: { point: { code }, status: 'DRAFT' },
    });
    if (draft) {
      await this.prisma.db.approvalChainVersion.delete({
        where: { id: draft.id },
      });
      await this.audit.log({
        action: 'workflow.discard_draft',
        entityType: 'ApprovalPoint',
        entityId: code,
      });
    }
    return this.point(code);
  }

  /** New requests use the activated version; running ones keep theirs. */
  async activate(actor: CurrentUser, code: string, versionUniqueId: string) {
    const v = await this.prisma.db.approvalChainVersion.findFirst({
      where: { uniqueId: versionUniqueId, point: { code } },
    });
    if (!v) throw new NotFoundException('errors.record_not_found');
    if (v.status !== 'DRAFT')
      throw new BadRequestException('errors.version_not_draft');
    await this.prisma.db.$transaction(async (tx) => {
      await tx.approvalChainVersion.updateMany({
        where: { pointId: v.pointId, status: 'ACTIVE' },
        data: { status: 'RETIRED' },
      });
      await tx.approvalChainVersion.update({
        where: { id: v.id },
        data: {
          status: 'ACTIVE',
          activatedById: actor.id,
          activatedAt: new Date(),
        },
      });
      await tx.approvalPoint.update({
        where: { id: v.pointId },
        data: { activeVersionId: v.id },
      });
      await this.audit.log(
        {
          action: 'workflow.activate',
          entityType: 'ApprovalPoint',
          entityId: code,
          after: { version: v.version },
        },
        tx,
      );
    });
    return this.point(code);
  }
}
