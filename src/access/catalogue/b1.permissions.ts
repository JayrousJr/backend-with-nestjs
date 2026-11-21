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
  'internal_request.view': {
    scopes: ['ALL', 'OWN_DEPARTMENT', 'OWN_RECORDS'],
    description:
      'View internal requests (own department = requesting or owning)',
  },
  'internal_request.create': {
    scopes: ['OWN_DEPARTMENT'],
    description: 'Raise internal requests for the department or its employees',
  },
  'internal_request.submit': {
    scopes: ['OWN_DEPARTMENT'],
    description: 'Submit internal requests',
  },
  'internal_request.cancel': {
    scopes: ['OWN_DEPARTMENT'],
    description: 'Cancel internal requests before delivery',
  },
  'internal_request.accept': {
    scopes: ['ASSIGNED'],
    description: 'Accept (fully or partially) as the owning department',
  },
  'internal_request.fulfil': {
    scopes: ['OWN_DEPARTMENT'],
    description: 'Plan fulfilment (from store / purchase) for own products',
  },
  'purchase_request.view': {
    scopes: ['ALL', 'OWN_DEPARTMENT'],
    description: 'View purchase requests',
  },
  'purchase_request.create': {
    scopes: ['OWN_DEPARTMENT'],
    description: 'Raise purchase requests for own products',
  },
  'purchase_request.submit': {
    scopes: ['OWN_DEPARTMENT'],
    description: 'Submit purchase requests',
  },
  'purchase_request.cancel': {
    scopes: ['OWN_DEPARTMENT'],
    description: 'Cancel purchase requests before approval',
  },
  'purchase_request.approve': {
    scopes: ['ASSIGNED'],
    description: 'Decide purchase request steps (CEO, Procurement)',
  },
});
