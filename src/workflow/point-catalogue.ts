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
  'transfer.approval': {
    module: 'B2',
    name: 'Store transfer',
    description:
      'Transfers between stores. No steps by default: approved on request.',
    permission: 'transfer.approve',
    defaultSteps: [],
  },
  'transfer_discrepancy.approval': {
    module: 'B2',
    name: 'Transfer discrepancy',
    description:
      'Quantities or assets dispatched but not received: approve the write-off (assets become missing)',
    permission: 'transfer.approve',
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
  'stock_count.approval': {
    module: 'B2',
    name: 'Stock count',
    description:
      'Count variances become adjustments; assets not found become missing',
    permission: 'stock_count.approve',
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
  'disposal.approval': {
    module: 'B2',
    name: 'Disposal',
    description:
      'Owning-department HOD (technical opinion), then the Disposal Committee',
    permission: 'disposal.approve',
    defaultSteps: [
      {
        code: 'hod_opinion',
        name: 'Owning department HOD',
        approverType: 'RULE',
        approver: 'HOD_OF_SUBJECT_DEPARTMENT',
        mode: 'ANY',
        allowDelegation: true,
      },
      {
        code: 'disposal_committee',
        name: 'Disposal Committee',
        approverType: 'GROUP',
        approver: 'DISPOSAL_COMMITTEE',
        mode: 'ANY',
      },
    ],
  },
  'internal_request.approval': {
    module: 'B1',
    name: 'Internal request',
    description:
      'Acceptance by the owning department (skipped when the requesting department owns the product)',
    permission: 'internal_request.accept',
    defaultSteps: [
      {
        code: 'owning_dept_acceptance',
        name: 'Owning department acceptance',
        approverType: 'RULE',
        approver: 'HOD_OF_SUBJECT_DEPARTMENT',
        mode: 'ANY',
        allowDelegation: true,
      },
    ],
  },
  'purchase_request.approval': {
    module: 'B1',
    name: 'Purchase request',
    description:
      'CEO review → Procurement review → CEO decision (no budget shown)',
    permission: 'purchase_request.approve',
    defaultSteps: [
      {
        code: 'ceo_review',
        name: 'CEO review',
        approverType: 'ROLE',
        approver: 'CEO',
        mode: 'ANY',
        allowDelegation: false,
      },
      {
        code: 'procurement_review',
        name: 'Procurement review',
        approverType: 'ROLE',
        approver: 'Procurement Officer',
        mode: 'ANY',
        allowDelegation: true,
      },
      {
        code: 'ceo_decision',
        name: 'CEO decision',
        approverType: 'ROLE',
        approver: 'CEO',
        mode: 'ANY',
        allowDelegation: false,
      },
    ],
  },
  'handover.approval': {
    module: 'B3',
    name: 'Handover',
    description:
      'Handover to a custodian. No steps by default (the request was approved).',
    defaultSteps: [],
  },
  'custody_transfer.approval': {
    module: 'B3',
    name: 'Custody transfer',
    description:
      'Moving items from one employee to another (HOD of the receiving employee)',
    permission: 'custody_transfer.approve',
    defaultSteps: [
      {
        code: 'receiving_hod',
        name: 'Receiving HOD',
        approverType: 'RULE',
        approver: 'HOD_OF_SUBJECT_DEPARTMENT',
        mode: 'ANY',
        allowDelegation: true,
      },
    ],
  },
  'asset_loss.approval': {
    module: 'B3',
    name: 'Asset loss / theft',
    description: 'Confirms a loss or theft report: the asset becomes lost',
    permission: 'asset_loss.approve',
    defaultSteps: [
      {
        code: 'owning_hod',
        name: 'Owning department HOD',
        approverType: 'RULE',
        approver: 'HOD_OF_SUBJECT_DEPARTMENT',
        mode: 'ANY',
        allowDelegation: true,
      },
      {
        code: 'store_managers',
        name: 'Store Managers',
        approverType: 'GROUP',
        approver: 'STORE_MANAGERS',
        mode: 'ANY',
      },
    ],
  },
  'asset_responsibility.approval': {
    module: 'B3',
    name: 'Responsibility decision',
    description:
      'Wear, accident, negligence or under investigation — decision and reason only, no amounts',
    permission: 'asset_responsibility.approve',
    defaultSteps: [
      {
        code: 'owning_hod',
        name: 'Owning department HOD',
        approverType: 'RULE',
        approver: 'HOD_OF_SUBJECT_DEPARTMENT',
        mode: 'ANY',
        allowDelegation: true,
      },
      {
        code: 'hr',
        name: 'HR',
        approverType: 'GROUP',
        approver: 'HR',
        mode: 'ANY',
      },
    ],
  },
  'return.approval': {
    module: 'B3',
    name: 'Return',
    description: 'Returns to a store. No steps by default.',
    defaultSteps: [],
  },
};
