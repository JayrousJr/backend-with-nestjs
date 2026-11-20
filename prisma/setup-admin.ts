import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Installation setup command: creates the FIRST System Administrator
 * (user-employee-spec.md §7 "First administrator"). Run once after
 * `prisma migrate deploy` and `prisma db seed`:
 *
 *   ADMIN_EMAIL=ict.admin@azamtv.co.tz ADMIN_EMPLOYEE_NUMBER=AZ0001 \
 *   ADMIN_FIRST_NAME=Asha ADMIN_LAST_NAME=Mushi ADMIN_GENDER=FEMALE \
 *   ADMIN_PHONE="+255 700 000 000" pnpm setup:admin
 *
 * A one-time password is printed; the administrator must change it at
 * first login. Refuses to run when an active System Administrator exists.
 */
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing ${name}`);
  return v.trim();
}

async function main() {
  const role = await prisma.role.findUnique({
    where: { name: 'System Administrator' },
  });
  if (!role) throw new Error('Run `pnpm db:seed` first (roles missing).');

  const existing = await prisma.userRole.count({
    where: { roleId: role.id, user: { status: 'ACTIVE' } },
  });
  if (existing && process.env.FORCE !== '1') {
    throw new Error(
      'An active System Administrator already exists. Use the UI (or FORCE=1).',
    );
  }

  const email = env('ADMIN_EMAIL').toLowerCase();
  const policy = await prisma.policySetting.findUnique({
    where: { code: 'SECURITY_EMAIL_DOMAINS' },
  });
  const domains =
    (policy?.parameters as { domains?: string[] } | null)?.domains ?? [];
  if (!domains.includes(email.split('@')[1])) {
    throw new Error(
      `${email} is not in the allowed domains (${domains.join(', ')}). ` +
        'Update SECURITY_EMAIL_DOMAINS in policy_settings first.',
    );
  }

  const deptCode = env('ADMIN_DEPARTMENT_CODE', 'ICT');
  const department = await prisma.department.upsert({
    where: { code: deptCode },
    update: {},
    create: { code: deptCode, name: deptCode === 'ICT' ? 'ICT' : deptCode },
  });
  const title = await prisma.jobTitle.upsert({
    where: { code: 'SYSADMIN' },
    update: {},
    create: { code: 'SYSADMIN', name: 'Systems Administrator' },
  });
  const type = await prisma.employmentType.findUniqueOrThrow({
    where: { code: 'PERMANENT' },
  });

  const employee = await prisma.employee.upsert({
    where: { employeeNumber: env('ADMIN_EMPLOYEE_NUMBER') },
    update: {},
    create: {
      employeeNumber: env('ADMIN_EMPLOYEE_NUMBER'),
      firstName: env('ADMIN_FIRST_NAME'),
      lastName: env('ADMIN_LAST_NAME'),
      gender: env('ADMIN_GENDER', 'MALE') as 'MALE' | 'FEMALE',
      companyEmail: email,
      phone: env('ADMIN_PHONE', '+255 000 000 000'),
      departmentId: department.id,
      jobTitleId: title.id,
      employmentTypeId: type.id,
      startDate: new Date(),
    },
  });

  // Random one-time password: letters + digits, satisfies the policy.
  const password = `Az${randomBytes(9).toString('base64url')}7`;
  const user = await prisma.user.upsert({
    where: { employeeId: employee.id },
    update: {
      password: await bcrypt.hash(password, 12),
      status: 'ACTIVE',
      passwordChangedAt: new Date(),
    },
    create: {
      employeeId: employee.id,
      email,
      password: await bcrypt.hash(password, 12),
      status: 'ACTIVE',
      passwordChangedAt: new Date(),
    },
  });
  const hasRole = await prisma.userRole.findFirst({
    where: { userId: user.id, roleId: role.id },
  });
  if (!hasRole) {
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  await prisma.auditLog.create({
    data: {
      action: 'setup.first_admin',
      entityType: 'User',
      entityId: user.uniqueId,
      after: { email },
    },
  });

  console.log('\nFirst administrator ready');
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}   (one-time — change it at first login)\n`);
  console.log(
    'Next: create a second administrator from the UI — the system keeps at least two holders of role.manage.',
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
