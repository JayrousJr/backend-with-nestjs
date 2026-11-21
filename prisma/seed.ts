import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import { PrismaClient } from '../generated/prisma/client';
import { syncPermissionCatalogue } from '../src/access/permission-sync';
import { syncPolicyCatalogue } from '../src/policy/policy-sync';
import { PERMISSION_CATALOGUE } from '../src/access/catalogue';
import {
  SEED_EMPLOYMENT_TYPES,
  SEED_GROUPS,
  SEED_ROLES,
} from './seed-data/roles';
import { SEED_CATEGORIES } from './seed-data/catalogue';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

/**
 * Seeds reference data every installation needs (idempotent):
 * permission catalogue, policy settings, employment types, seeded roles
 * and approval groups. Grants of existing roles are filled per module, only
 * when the role holds nothing from that module, so edits are kept.
 *
 * Outside production it also loads demo departments, employees and users.
 * Production's first administrator comes from `pnpm setup:admin`.
 */
async function main() {
  await syncPermissionCatalogue(prisma);
  await syncPolicyCatalogue(prisma);

  for (const t of SEED_EMPLOYMENT_TYPES) {
    await prisma.employmentType.upsert({
      where: { code: t.code },
      update: {},
      create: t,
    });
  }

  for (const r of SEED_ROLES) {
    const role = await prisma.role.upsert({
      where: { name: r.name },
      update: {},
      create: {
        name: r.name,
        description: r.description,
        contextType: r.contextType,
      },
      include: { grants: true },
    });
    // Fill grants per module, only for modules the role holds nothing from
    // yet, so administrator edits are kept and new modules still arrive.
    const moduleOf = (code: string) =>
      (PERMISSION_CATALOGUE as Record<string, { module: string }>)[code]
        ?.module;
    const heldModules = new Set(
      role.grants.map((g) => moduleOf(g.permissionCode)),
    );
    const missing = r.grants.filter(
      ([code]) => !heldModules.has(moduleOf(code)),
    );
    if (missing.length) {
      await prisma.roleGrant.createMany({
        data: missing.map(([permissionCode, scope]) => ({
          roleId: role.id,
          permissionCode,
          scope,
        })),
        skipDuplicates: true,
      });
    }
  }

  for (const g of SEED_GROUPS) {
    await prisma.userGroup.upsert({
      where: { code: g.code },
      update: {},
      create: g,
    });
  }

  for (const c of SEED_CATEGORIES) {
    const exists = await prisma.productCategory.findUnique({
      where: { code: c.code },
    });
    if (exists) continue;
    await prisma.productCategory.create({
      data: {
        code: c.code,
        name: c.name,
        tagPrefix: c.tagPrefix,
        inspectionMonths: ['CAM', 'AUD', 'LGT'].includes(c.code)
          ? 6
          : c.code === 'ICT'
            ? 12
            : null,
        termsOfUse:
          'I confirm I received the items listed in the condition shown. I will use them for AzamTV work only, keep them safe, report any fault, damage, loss or theft at once, and return them when asked or when I leave AzamTV.',
        criteria: {
          create: c.criteria.map((text, i) => ({ text, sortOrder: i })),
        },
      },
    });
  }

  if (process.env.NODE_ENV === 'production') {
    console.log('Reference data seeded (no demo data in production).');
    return;
  }
  await seedDemo();
  console.log('Seeding complete (with demo data).');
}

/** Demo organisation for local development only. */
async function seedDemo() {
  const domain = 'azamtv.co.tz';
  const departments: [string, string, string?][] = [
    ['MGT', 'Management'],
    ['PROD', 'Production'],
    ['CAM', 'Camera', 'PROD'],
    ['SND', 'Sound', 'PROD'],
    ['ENG', 'Engineering'],
    ['ICT', 'ICT'],
    ['TRN', 'Transport'],
    ['STORE', 'Store/Administration'],
    ['PROC', 'Procurement'],
    ['FIN', 'Finance'],
    ['HR', 'Human Resources'],
  ];
  const deptId = new Map<string, number>();
  for (const [code, name, parent] of departments) {
    const d = await prisma.department.upsert({
      where: { code },
      update: {},
      create: { code, name, parentId: parent ? deptId.get(parent) : null },
    });
    deptId.set(code, d.id);
  }

  const titles = [
    ['SYSADMIN', 'Systems Administrator'],
    ['HR_OFFICER', 'HR Officer'],
    ['HOD', 'Head of Department'],
    ['CAM_OP', 'Camera Operator'],
    ['DRIVER', 'Driver'],
    ['PROC_OFFICER', 'Procurement Officer'],
    ['STOREKEEPER', 'Storekeeper'],
    ['STORE_MGR', 'Store Manager'],
    ['CEO', 'Chief Executive Officer'],
  ];
  const titleId = new Map<string, number>();
  for (const [code, name] of titles) {
    const t = await prisma.jobTitle.upsert({
      where: { code },
      update: {},
      create: { code, name },
    });
    titleId.set(code, t.id);
  }
  const permanent = await prisma.employmentType.findUniqueOrThrow({
    where: { code: 'PERMANENT' },
  });

  const password = await bcrypt.hash('Dev-Passw0rd-2026', 12);
  const people = [
    {
      number: 'AZ0001',
      first: 'Asha',
      last: 'Mushi',
      gender: 'FEMALE',
      email: `sysadmin@${domain}`,
      dept: 'ICT',
      title: 'SYSADMIN',
      roles: ['System Administrator', 'Staff'],
      user: true,
    },
    {
      number: 'AZ0002',
      first: 'Juma',
      last: 'Mrisho',
      gender: 'MALE',
      email: `ict.admin2@${domain}`,
      dept: 'ICT',
      title: 'SYSADMIN',
      roles: ['System Administrator', 'Staff'],
      user: true,
    },
    {
      number: 'AZ0003',
      first: 'Neema',
      last: 'Kweka',
      gender: 'FEMALE',
      email: `hr@${domain}`,
      dept: 'HR',
      title: 'HR_OFFICER',
      roles: ['HR Officer', 'Staff'],
      user: true,
    },
    {
      number: 'AZ0004',
      first: 'Baraka',
      last: 'Mollel',
      gender: 'MALE',
      email: `hod.camera@${domain}`,
      dept: 'CAM',
      title: 'HOD',
      roles: ['Head of Department', 'Staff'],
      user: true,
      hodOf: 'CAM',
    },
    {
      number: 'AZ0005',
      first: 'Rehema',
      last: 'Said',
      gender: 'FEMALE',
      email: `camera.op@${domain}`,
      dept: 'CAM',
      title: 'CAM_OP',
      roles: ['Staff'],
      user: true,
    },
    {
      number: 'AZ0006',
      first: 'Hamisi',
      last: 'Bakari',
      gender: 'MALE',
      email: `driver1@${domain}`,
      dept: 'TRN',
      title: 'DRIVER',
      roles: [],
      user: false,
    },
    {
      number: 'AZ0007',
      first: 'Upendo',
      last: 'Lyimo',
      gender: 'FEMALE',
      email: `procurement@${domain}`,
      dept: 'PROC',
      title: 'PROC_OFFICER',
      roles: ['Procurement Officer', 'Staff'],
      user: true,
    },
    {
      number: 'AZ0008',
      first: 'Salum',
      last: 'Hassan',
      gender: 'MALE',
      email: `storekeeper@${domain}`,
      dept: 'STORE',
      title: 'STOREKEEPER',
      roles: ['Staff'],
      user: true,
      store: 'MAIN',
    },
    {
      number: 'AZ0009',
      first: 'Grace',
      last: 'Mbwambo',
      gender: 'FEMALE',
      email: `store.studio@${domain}`,
      dept: 'STORE',
      title: 'STOREKEEPER',
      roles: ['Staff'],
      user: true,
      store: 'STUDIO',
    },
    {
      number: 'AZ0010',
      first: 'Daudi',
      last: 'Mtei',
      gender: 'MALE',
      email: `store.manager@${domain}`,
      dept: 'STORE',
      title: 'STORE_MGR',
      roles: ['Store Manager', 'Head of Department', 'Staff'],
      user: true,
      hodOf: 'STORE',
      groups: ['STORE_MANAGERS', 'DISPOSAL_COMMITTEE'],
      counts: ['MAIN', 'STUDIO'],
    },
    {
      number: 'AZ0011',
      first: 'Zuberi',
      last: 'Kassim',
      gender: 'MALE',
      email: `ceo@${domain}`,
      dept: 'MGT',
      title: 'CEO',
      roles: ['CEO', 'Staff'],
      user: true,
      hodOf: 'MGT',
    },
  ] as const;

  // Demo stores (real stores and storekeepers are AzamTV setup data).
  const storeId = new Map<string, number>();
  for (const [code, name, type, address] of [
    ['MAIN', 'Main Store', 'MAIN', 'Tabata, Dar es Salaam'],
    ['STUDIO', 'Studio Store', 'SUB', 'Mikocheni Studios, Dar es Salaam'],
  ] as const) {
    let store = await prisma.store.findUnique({ where: { code } });
    if (!store) {
      store = await prisma.store.create({
        data: {
          code,
          name,
          type,
          address,
          managingDepartmentId: deptId.get('STORE')!,
          locations: {
            create: [
              { code: 'TRANSIT', name: 'In transit', kind: 'IN_TRANSIT' },
              ...(type === 'MAIN'
                ? ([
                    {
                      code: 'RECEIVING',
                      name: 'Receiving / Quarantine',
                      kind: 'RECEIVING',
                    },
                    { code: 'REJECTED', name: 'Rejected', kind: 'REJECTED' },
                  ] as const)
                : []),
              { code: 'A', name: 'Section A', kind: 'GENERAL' },
              { code: 'B', name: 'Section B', kind: 'GENERAL' },
            ],
          },
        },
      });
    }
    storeId.set(code, store.id);
  }
  const storekeeper = await prisma.role.findUniqueOrThrow({
    where: { name: 'Storekeeper' },
  });

  for (const p of people) {
    const e = await prisma.employee.upsert({
      where: { employeeNumber: p.number },
      update: {},
      create: {
        employeeNumber: p.number,
        firstName: p.first,
        lastName: p.last,
        gender: p.gender,
        companyEmail: p.email,
        phone: '+255 700 000 000',
        departmentId: deptId.get(p.dept)!,
        jobTitleId: titleId.get(p.title)!,
        employmentTypeId: permanent.id,
        startDate: new Date('2020-01-01'),
      },
    });
    if ('hodOf' in p) {
      await prisma.department.update({
        where: { id: deptId.get(p.hodOf)! },
        data: { headEmployeeId: e.id },
      });
    }
    if (!p.user) continue;
    const u = await prisma.user.upsert({
      where: { employeeId: e.id },
      update: {},
      create: {
        employeeId: e.id,
        email: p.email,
        password,
        status: 'ACTIVE',
        passwordChangedAt: new Date(),
      },
    });
    for (const roleName of p.roles) {
      const role = await prisma.role.findUniqueOrThrow({
        where: { name: roleName },
      });
      const exists = await prisma.userRole.findFirst({
        where: { userId: u.id, roleId: role.id },
      });
      if (!exists) {
        await prisma.userRole.create({
          data: { userId: u.id, roleId: role.id },
        });
      }
    }
    if ('store' in p) {
      const contextId = storeId.get(p.store)!;
      const exists = await prisma.userRole.findFirst({
        where: { userId: u.id, roleId: storekeeper.id, contextId },
      });
      if (!exists) {
        await prisma.userRole.create({
          data: {
            userId: u.id,
            roleId: storekeeper.id,
            contextType: 'STORE',
            contextId,
          },
        });
      }
    }
    for (const code of 'counts' in p ? p.counts : []) {
      const counter = await prisma.role.findUniqueOrThrow({
        where: { name: 'Stock Counter' },
      });
      const contextId = storeId.get(code)!;
      const exists = await prisma.userRole.findFirst({
        where: { userId: u.id, roleId: counter.id, contextId },
      });
      if (!exists) {
        await prisma.userRole.create({
          data: {
            userId: u.id,
            roleId: counter.id,
            contextType: 'STORE',
            contextId,
          },
        });
      }
    }
    for (const code of 'groups' in p ? p.groups : []) {
      const group = await prisma.userGroup.findUniqueOrThrow({
        where: { code },
      });
      await prisma.userGroupMember.upsert({
        where: { groupId_userId: { groupId: group.id, userId: u.id } },
        update: {},
        create: { groupId: group.id, userId: u.id },
      });
    }
  }
  console.log(
    `Demo users (password Dev-Passw0rd-2026): ${people
      .filter((p) => p.user)
      .map((p) => p.email)
      .join(', ')}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
