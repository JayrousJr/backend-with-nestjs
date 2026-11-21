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
  /** {path, op, value} on the request context; false = step skipped. */
  condition?: { path: string; op: string; value: unknown };
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
  TENDER_COMMITTEE: 'Members of the tender’s evaluation committee',
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
  'single_source.justification': {
    module: 'B1T',
    name: 'Single-source justification',
    description: 'CEO approves buying from the single designated vendor',
    permission: 'single_source.approve',
    defaultSteps: [
      {
        code: 'ceo_approval',
        name: 'CEO approval',
        approverType: 'ROLE',
        approver: 'CEO',
        allowDelegation: false,
      },
    ],
  },
  'tender.award_approval': {
    module: 'B1T',
    name: 'Tender award',
    description:
      'All committee members (conflict-of-interest declared) → CEO final approval (always runs)',
    permission: 'tender.approve_award',
    defaultSteps: [
      {
        code: 'committee_approval',
        name: 'Committee approval',
        approverType: 'RULE',
        approver: 'TENDER_COMMITTEE',
        mode: 'ALL',
        allowDelegation: false,
      },
      {
        code: 'ceo_final_approval',
        name: 'CEO final approval',
        approverType: 'ROLE',
        approver: 'CEO',
        allowDelegation: false,
      },
    ],
  },
  'purchase_order.issue': {
    module: 'B1T',
    name: 'LPO issue',
    description: 'Procurement Officer issues the LPO to the vendor',
    permission: 'lpo.approve',
    defaultSteps: [
      {
        code: 'purchasing_review',
        name: 'Purchasing review',
        approverType: 'ROLE',
        approver: 'Procurement Officer',
      },
    ],
  },
  'purchase_order.amendment': {
    module: 'B1T',
    name: 'LPO amendment',
    description:
      'Procurement Officer → CEO only when the total value increases',
    permission: 'lpo.approve',
    defaultSteps: [
      {
        code: 'procurement_review',
        name: 'Procurement review',
        approverType: 'ROLE',
        approver: 'Procurement Officer',
      },
      {
        code: 'ceo_approval',
        name: 'CEO approval (value increase)',
        approverType: 'ROLE',
        approver: 'CEO',
        allowDelegation: false,
        condition: { path: 'increasesValue', op: 'eq', value: true },
      },
    ],
  },
  'purchase_order.cancellation': {
    module: 'B1T',
    name: 'LPO cancellation',
    description: 'CEO approves cancelling an LPO (reason mandatory)',
    permission: 'lpo.approve',
    defaultSteps: [
      {
        code: 'ceo_approval',
        name: 'CEO approval',
        approverType: 'ROLE',
        approver: 'CEO',
        allowDelegation: false,
      },
    ],
  },
  'payment_request.approval': {
    module: 'B1T',
    name: 'Payment',
    description: 'Finance approves paying a matched invoice (manual payment)',
    permission: 'payment_request.approve',
    defaultSteps: [
      {
        code: 'finance_approval',
        name: 'Finance approval',
        approverType: 'ROLE',
        approver: 'Finance',
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
