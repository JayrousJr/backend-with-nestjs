import type { ApprovalMode, ApproverType } from '@db';
import type { PermissionCode } from '@access';

export interface DefaultStep {
  code: string;
  name: string;
  approverType: ApproverType;
  /** USER: email · GROUP: group code · ROLE: role name · RULE: rule code */
  approver: string;
  mode?: ApprovalMode;
  requiredCount?: number;
  allowDelegation?: boolean;
}

export interface ApprovalPointDefinition {
  module: string;
  name: string;
  description: string;
  /** Approvers must also hold this permission (scope `assigned`). */
  permission?: PermissionCode;
  /** Seeded chain; [] = no steps = no approval needed. */
  defaultSteps: DefaultStep[];
}

export const ASSIGNEE_RULES = {
  HOD_OF_SUBJECT_DEPARTMENT: 'HOD (or acting HOD) of the record’s department',
  HOD_OF_REQUESTER_DEPARTMENT:
    'HOD (or acting HOD) of the requester’s department',
} as const;
export type AssigneeRule = keyof typeof ASSIGNEE_RULES;

/**
 * Approval points registered in code, synced at boot like permissions.
 * Seeded chains are only applied when a point has no versions yet; after
 * that, chains are configuration (workflow.manage / workflow.activate).
 * Each module adds its points here as it is built.
 */
export const APPROVAL_POINTS: Record<string, ApprovalPointDefinition> = {
  'user.creation': {
    module: 'A1',
    name: 'User creation',
    description: 'Creating a user account from an employee',
    defaultSteps: [],
  },
  'employee.exit_clearance': {
    module: 'A1',
    name: 'Exit clearance sign-off',
    description:
      'Sign-off of an exited employee’s clearance once every item is resolved',
    permission: 'employee.exit_clearance.approve',
    defaultSteps: [
      {
        code: 'hr_signoff',
        name: 'HR sign-off',
        approverType: 'GROUP',
        approver: 'HR',
        mode: 'ANY',
      },
    ],
  },
  'product.activation': {
    module: 'B1',
    name: 'Product activation',
    description:
      'New products and new versions: owning-department HOD, then Procurement (code, item type, acquisition, VAT, duplicate check)',
    permission: 'item.approve',
    defaultSteps: [
      {
        code: 'hod_review',
        name: 'HOD review',
        approverType: 'RULE',
        approver: 'HOD_OF_SUBJECT_DEPARTMENT',
        mode: 'ANY',
        allowDelegation: true,
      },
      {
        code: 'procurement_review',
        name: 'Procurement review',
        approverType: 'ROLE',
        approver: 'Procurement Officer',
        mode: 'ANY',
        allowDelegation: true,
      },
    ],
  },
  'stock_adjustment.approval': {
    module: 'B2',
    name: 'Stock adjustment',
    description:
      'Opening balance, found / donated items, count variances and corrections',
    permission: 'stock_adjustment.approve',
    defaultSteps: [
      {
        code: 'store_managers',
        name: 'Store Managers',
        approverType: 'GROUP',
        approver: 'STORE_MANAGERS',
        mode: 'ANY',
      },
    ],
  },
};
