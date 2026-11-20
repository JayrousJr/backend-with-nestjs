import type { RoleContextType, Scope } from '../../generated/prisma/client';

type Grant = [permission: string, scope: Scope];

export interface SeedRole {
  name: string;
  description: string;
  contextType?: RoleContextType;
  grants: Grant[];
}

/**
 * Seeded example roles (editable after go-live). Each module adds its own
 * grants to these roles when it is built; the seed fills a role's grants
 * per module, only when the role holds nothing from that module yet.
 */
export const SEED_ROLES: SeedRole[] = [
  {
    name: 'System Administrator',
    description:
      'Users, roles, groups, settings and audit. Holds no procurement actions (SOD_ADMIN_PROCUREMENT).',
    grants: [
      ['department.view', 'ALL'],
      ['job_title.manage', 'ALL'],
      ['employment_type.manage', 'ALL'],
      ['employee.view', 'ALL'],
      ['user.view', 'ALL'],
      ['user.manage', 'ALL'],
      ['user.assign_role', 'ALL'],
      ['user.reset_password', 'ALL'],
      ['role.view', 'ALL'],
      ['role.manage', 'ALL'],
      ['group.manage', 'ALL'],
      ['delegation.create', 'ALL'],
      ['delegation.approve', 'ALL'],
      ['policy.view', 'ALL'],
      ['policy.manage', 'ALL'],
      ['workflow.view', 'ALL'],
      ['workflow.manage', 'ALL'],
      ['workflow.activate', 'ALL'],
      ['audit.view', 'ALL'],
      ['security.view_logins', 'ALL'],
      ['file.view', 'ALL'],
    ],
  },
  {
    name: 'HR Officer',
    description:
      'Departments, job titles, employee records, imports, exits and exit clearance.',
    grants: [
      ['department.view', 'ALL'],
      ['department.manage', 'ALL'],
      ['job_title.manage', 'ALL'],
      ['employment_type.manage', 'ALL'],
      ['employee.view', 'ALL'],
      ['employee.view_personal', 'ALL'],
      ['employee.manage', 'ALL'],
      ['employee.import', 'ALL'],
      ['employee.exit', 'ALL'],
      ['employee.exit_clearance.approve', 'ASSIGNED'],
      ['delegation.create', 'OWN_RECORDS'],
    ],
  },
  {
    name: 'Head of Department',
    description:
      'HOD rights over the own department. The HOD is set on the department; this role gives the permissions.',
    grants: [
      ['department.view', 'ALL'],
      ['employee.view', 'OWN_DEPARTMENT'],
      ['employee.view_personal', 'OWN_DEPARTMENT'],
      ['delegation.create', 'OWN_RECORDS'],
      ['audit.view', 'OWN_DEPARTMENT'],
      ['item.view', 'ALL'],
      ['item.create', 'OWN_DEPARTMENT'],
      ['item.edit_draft', 'OWN_DEPARTMENT'],
      ['item.submit', 'OWN_DEPARTMENT'],
      ['item.import', 'OWN_DEPARTMENT'],
      ['item.approve', 'ASSIGNED'],
      ['stock.view', 'OWN_DEPARTMENT'],
      ['asset.view', 'OWN_DEPARTMENT'],
    ],
  },
  {
    name: 'Staff',
    description: 'Every staff user: own profile and own delegations.',
    grants: [
      ['employee.view', 'OWN_RECORDS'],
      ['delegation.create', 'OWN_RECORDS'],
      ['item.view', 'ALL'],
    ],
  },
  {
    name: 'Transport Officer',
    description: 'Driver profiles (licences); transport module grants follow.',
    grants: [
      ['employee.view', 'ALL'],
      ['driver_profile.manage', 'ALL'],
    ],
  },
  // Roles whose permissions arrive with later modules. Created now so
  // groups and users can be set up during go-live preparation.
  { name: 'CEO', description: 'Approver (B1). 2FA mandatory.', grants: [] },
  {
    name: 'Procurement Officer',
    description: 'Procurement (B1). 2FA mandatory.',
    grants: [
      ['item.view', 'ALL'],
      ['item.approve', 'ASSIGNED'],
      ['item.manage', 'ALL'],
      ['item.merge', 'ALL'],
      ['item_category.manage', 'ALL'],
      ['stock.view', 'ALL'],
      ['asset.view', 'ALL'],
    ],
  },
  {
    name: 'Storekeeper',
    description: 'Store operations (B2), assigned per store.',
    contextType: 'STORE',
    grants: [
      ['item.view', 'ALL'],
      ['stock.view', 'ASSIGNED_STORE'],
      ['stock.receive', 'ASSIGNED_STORE'],
      ['stock.issue', 'ASSIGNED_STORE'],
      ['stock.return', 'ASSIGNED_STORE'],
      ['stock.adjust', 'ASSIGNED_STORE'],
      ['transfer.create', 'ASSIGNED_STORE'],
      ['transfer.dispatch', 'ASSIGNED_STORE'],
      ['transfer.receive', 'ASSIGNED_STORE'],
      ['stock_count.create', 'ASSIGNED_STORE'],
      ['stock_count.count', 'ASSIGNED_STORE'],
      ['asset.edit', 'ASSIGNED_STORE'],
      ['asset.tag_print', 'ASSIGNED_STORE'],
      ['disposal.propose', 'ASSIGNED_STORE'],
      ['maintenance.create', 'ASSIGNED_STORE'],
    ],
  },
  {
    name: 'Store Manager',
    description: 'Store approvals (B2).',
    grants: [
      ['item.view', 'ALL'],
      ['store.manage', 'ALL'],
      ['stock.view', 'ALL'],
      ['asset.view', 'ALL'],
      ['asset.edit', 'ALL'],
      ['asset.tag_print', 'ALL'],
      ['stock_adjustment.approve', 'ASSIGNED'],
      ['stock_count.approve', 'ASSIGNED'],
      ['transfer.approve', 'ASSIGNED'],
    ],
  },
  {
    name: 'Committee Member',
    description: 'Tender committees (B1).',
    grants: [],
  },
  {
    name: 'Inspector',
    description: 'Receiving inspection (B1), per inspecting department.',
    contextType: 'DEPARTMENT',
    grants: [],
  },
  { name: 'Finance', description: 'Invoices and payments (B1).', grants: [] },
  {
    name: 'Product Author',
    description: 'Department products (B1).',
    grants: [
      ['item.view', 'ALL'],
      ['item.create', 'OWN_DEPARTMENT'],
      ['item.edit_draft', 'OWN_DEPARTMENT'],
      ['item.submit', 'OWN_DEPARTMENT'],
      ['item.import', 'OWN_DEPARTMENT'],
    ],
  },
  { name: 'Producer', description: 'Production requests (01).', grants: [] },
  {
    name: 'Production Manager',
    description: 'Production approvals (01–15).',
    grants: [],
  },
];

/** Groups named in the specs as approvers (members supplied by AzamTV). */
export const SEED_GROUPS = [
  {
    code: 'HR',
    name: 'HR',
    description: 'Exit clearance, responsibility decisions',
  },
  {
    code: 'STORE_MANAGERS',
    name: 'Store Managers',
    description:
      'Stock adjustments, counts, transfer discrepancies, asset loss',
  },
  {
    code: 'DISPOSAL_COMMITTEE',
    name: 'Disposal Committee',
    description: 'Final disposal approval',
  },
  {
    code: 'PRODUCTION_MANAGER',
    name: 'Production Manager',
    description: 'Production approval points',
  },
  {
    code: 'TRANSPORT_OFFICERS',
    name: 'Transport Officers',
    description: 'Transport requests',
  },
];

export const SEED_EMPLOYMENT_TYPES = [
  { code: 'PERMANENT', name: 'Permanent', requiresEndDate: false },
  { code: 'CONTRACT', name: 'Contract', requiresEndDate: true },
  { code: 'INTERN', name: 'Intern', requiresEndDate: true },
];
