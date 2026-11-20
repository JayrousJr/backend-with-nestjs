import { definePermissions } from './types';

/** B2 — Store & Inventory (store-inventory-spec.md §6.3). */
export const B2_PERMISSIONS = definePermissions('B2', {
  'store.manage': {
    scopes: ['ALL'],
    description: 'Stores, locations and stock levels (min / reorder / max)',
  },
  'stock.view': {
    scopes: ['ALL', 'OWN_DEPARTMENT', 'ASSIGNED_STORE'],
    description: 'View stock quantities and movements',
  },
  'stock.receive': {
    scopes: ['ASSIGNED_STORE'],
    description: 'Receive deliveries (main store only)',
  },
  'stock.issue': { scopes: ['ASSIGNED_STORE'], description: 'Issue stock' },
  'stock.return': {
    scopes: ['ASSIGNED_STORE'],
    description: 'Record returns to store',
  },
  'transfer.create': {
    scopes: ['ASSIGNED_STORE'],
    description: 'Request store transfers',
  },
  'transfer.dispatch': {
    scopes: ['ASSIGNED_STORE'],
    description: 'Dispatch transfers',
  },
  'transfer.receive': {
    scopes: ['ASSIGNED_STORE'],
    description: 'Confirm transfer receipts',
  },
  'transfer.approve': {
    scopes: ['ASSIGNED'],
    description: 'Decide transfer approvals',
  },
  'stock.adjust': {
    scopes: ['ASSIGNED_STORE'],
    description:
      'Raise stock adjustments (opening balance, found, donated, corrections)',
  },
  'stock_adjustment.approve': {
    scopes: ['ASSIGNED'],
    description: 'Decide stock adjustments',
  },
  'stock_count.create': {
    scopes: ['ASSIGNED_STORE'],
    description: 'Plan stock counts',
  },
  'stock_count.count': {
    scopes: ['ASSIGNED_STORE'],
    description: 'Enter counts',
  },
  'stock_count.approve': {
    scopes: ['ASSIGNED'],
    description: 'Decide count variances',
  },
  'asset.view': {
    scopes: ['ALL', 'OWN_DEPARTMENT'],
    description: 'View the asset register (own department = owning department)',
  },
  'asset.edit': {
    scopes: ['ALL', 'ASSIGNED_STORE'],
    description: 'Correct asset details (serial, brand, model, vehicle data)',
  },
  'asset.tag_print': {
    scopes: ['ALL', 'ASSIGNED_STORE'],
    description: 'Issue and print asset tags',
  },
  'disposal.propose': {
    scopes: ['OWN_DEPARTMENT', 'ASSIGNED_STORE'],
    description: 'Propose disposals',
  },
  'disposal.approve': {
    scopes: ['ASSIGNED'],
    description: 'Decide disposals',
  },
  'maintenance.create': {
    scopes: ['ALL', 'OWN_DEPARTMENT', 'ASSIGNED_STORE'],
    description: 'Open maintenance tickets',
  },
  'maintenance.update': {
    scopes: ['ALL', 'OWN_DEPARTMENT', 'ASSIGNED_STORE'],
    description: 'Work on maintenance tickets',
  },
});
