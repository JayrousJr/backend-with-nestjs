import { definePermissions } from './types';

/** B3 — Product Handover & Asset Custody (product-handover-spec.md §11.3). */
export const B3_PERMISSIONS = definePermissions('B3', {
  'handover.view': {
    scopes: ['ALL', 'OWN_DEPARTMENT', 'OWN_RECORDS'],
    description: 'View handovers',
  },
  'handover.prepare': {
    scopes: ['ASSIGNED_STORE'],
    description: 'Prepare and issue handovers',
  },
  'handover.acknowledge': {
    scopes: ['OWN_RECORDS'],
    description:
      'Acknowledge own handovers (also by email link / counter code)',
  },
  'handover.cancel': {
    scopes: ['ASSIGNED_STORE'],
    description: 'Cancel handovers before acknowledgement',
  },
  'custody.view': {
    scopes: ['ALL', 'OWN_DEPARTMENT', 'OWN_RECORDS'],
    description:
      'View who holds what (own department = custodian’s department)',
  },
  'custody_transfer.request': {
    scopes: ['OWN_DEPARTMENT'],
    description: 'Request custody transfers between employees',
  },
  'custody_transfer.approve': {
    scopes: ['ASSIGNED'],
    description: 'Decide custody transfers',
  },
  'return.request': {
    scopes: ['OWN_DEPARTMENT', 'OWN_RECORDS'],
    description: 'Request returns',
  },
  'return.receive': {
    scopes: ['ASSIGNED_STORE'],
    description: 'Receive returns into a store',
  },
  'asset_inspection.perform': {
    scopes: ['OWN_DEPARTMENT', 'ASSIGNED_STORE'],
    description: 'Record condition inspections',
  },
  'asset_report.create': {
    scopes: ['OWN_RECORDS', 'OWN_DEPARTMENT', 'ASSIGNED_STORE'],
    description: 'Report fault, damage, loss or theft',
  },
  'asset_loss.approve': {
    scopes: ['ASSIGNED'],
    description: 'Decide loss / theft reports',
  },
  'asset_responsibility.approve': {
    scopes: ['ASSIGNED'],
    description: 'Decide responsibility for damage or loss',
  },
  'custody.recall': {
    scopes: ['ASSIGNED_STORE', 'OWN_DEPARTMENT'],
    description: 'Recall items from custodians',
  },
});
