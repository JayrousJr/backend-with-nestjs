import { definePermissions } from './types';

/**
 * B1 — Tender & Procurement. Only the Product Repository (§5) is built so
 * far; requests, tenders, LPOs and vendors add their permissions here.
 */
export const B1_PERMISSIONS = definePermissions('B1', {
  'item.view': {
    scopes: ['ALL'],
    description: 'View the Product Repository (every Active product)',
  },
  'item.create': {
    scopes: ['OWN_DEPARTMENT'],
    description: 'Create products for the department (becomes owner)',
  },
  'item.edit_draft': {
    scopes: ['OWN_DEPARTMENT'],
    description: 'Edit draft or returned products and new versions',
  },
  'item.submit': {
    scopes: ['OWN_DEPARTMENT'],
    description: 'Submit products for activation',
  },
  'item.import': {
    scopes: ['OWN_DEPARTMENT'],
    description: 'Import the department’s products from Excel (as submitted)',
  },
  'item.approve': {
    scopes: ['ASSIGNED'],
    description: 'Decide product activation steps',
  },
  'item.manage': {
    scopes: ['ALL'],
    description:
      'Activation fields (code, item type, acquisition, VAT), status, ownership transfer',
  },
  'item.merge': { scopes: ['ALL'], description: 'Merge duplicate products' },
  'item_category.manage': {
    scopes: ['ALL'],
    description: 'Product categories and their receiving-criteria library',
  },
});
