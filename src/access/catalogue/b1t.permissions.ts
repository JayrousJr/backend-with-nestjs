import { definePermissions } from './types';

/**
 * B1 §7–§11 — vendors, tenders, LPO, receiving, inspection, finance
 * (tender-module-spec.md §12; tender/access-control.md §3.2–§3.7).
 * Budget and vendor-rating permissions are removed; SAP is out of scope.
 */
export const B1T_PERMISSIONS = definePermissions('B1T', {
  'vendor.view': { scopes: ['ALL'], description: 'View vendors' },
  'vendor.manage': {
    scopes: ['ALL'],
    description: 'Register vendors, categories, renew registration',
  },
  'vendor.suspend': {
    scopes: ['ALL'],
    description: 'Suspend, blacklist or reactivate vendors',
  },
  'vendor.create_admin_user': {
    scopes: ['ALL'],
    description: 'Create a vendor’s first portal user (vendor admin)',
  },
  'vendor.reset_2fa': {
    scopes: ['ALL'],
    description: 'Reset a vendor user’s authenticator (audited)',
  },
  'purchase_request.assign_route': {
    scopes: ['ALL'],
    description: 'Purchasing: set cash / single source / quotation per line',
  },
  'single_source.approve': {
    scopes: ['ASSIGNED'],
    description: 'Decide single-source justifications (CEO)',
  },
  'tender.view': {
    scopes: ['ALL', 'ASSIGNED'],
    description: 'View tenders (assigned = committee member)',
  },
  'tender.create': {
    scopes: ['ALL'],
    description: 'Create tenders from approved request lines',
  },
  'tender.publish': { scopes: ['ALL'], description: 'Publish tenders' },
  'tender.cancel': { scopes: ['ALL'], description: 'Cancel tenders' },
  'tender.answer_clarification': {
    scopes: ['ALL'],
    description: 'Answer vendor clarification questions',
  },
  'tender.issue_addendum': {
    scopes: ['ALL'],
    description: 'Issue addenda (may extend the closing time)',
  },
  'tender.appoint_committee': {
    scopes: ['ALL'],
    description: 'Appoint the evaluation committee of a tender',
  },
  'tender.confirm_opening': {
    scopes: ['ASSIGNED'],
    description: 'Committee member confirms bid opening (quorum)',
  },
  'tender.view_bids': {
    scopes: ['ASSIGNED', 'ALL'],
    description: 'View bids, only after opening',
  },
  'tender.negotiate': {
    scopes: ['ALL'],
    description: 'Record negotiated price / delivery with a vendor',
  },
  'tender.evaluate': {
    scopes: ['ASSIGNED'],
    description:
      'Review the evaluation, override compliance or choose a winner with reason',
  },
  'tender.approve_award': {
    scopes: ['ASSIGNED'],
    description: 'Award approval tasks (committee, CEO)',
  },
  'tender.send_notifications': {
    scopes: ['ALL'],
    description: 'Send award and regret letters',
  },
  'lpo.view': {
    scopes: ['ALL', 'OWN_DEPARTMENT'],
    description: 'View LPOs (own department = owning department of a line)',
  },
  'lpo.create': {
    scopes: ['ALL'],
    description: 'Create LPOs from awards',
  },
  'lpo.issue': {
    scopes: ['ALL'],
    description: 'Send LPOs for issue (purchase_order.issue)',
  },
  'lpo.approve': {
    scopes: ['ASSIGNED'],
    description: 'Decide LPO issue, amendment and cancellation steps',
  },
  'lpo.amend': { scopes: ['ALL'], description: 'Propose LPO amendments' },
  'lpo.cancel': {
    scopes: ['ALL'],
    description: 'Request LPO cancellation (with reason)',
  },
  'lpo.reaward': {
    scopes: ['ALL'],
    description: 'Re-award to the next-ranked compliant vendor',
  },
  'cash_purchase.record': {
    scopes: ['ALL'],
    description: 'Record cash purchases with receipts',
  },
  'grn.view': {
    scopes: ['ALL', 'ASSIGNED_STORE'],
    description: 'View goods received notes',
  },
  'inspection.view': {
    scopes: ['ALL', 'OWN_DEPARTMENT', 'ASSIGNED'],
    description: 'View receiving inspections',
  },
  'inspection.perform': {
    scopes: ['OWN_DEPARTMENT', 'ASSIGNED'],
    description: 'Inspect received goods against the receiving criteria',
  },
  'inspection.assign': {
    scopes: ['OWN_DEPARTMENT'],
    description: 'Assign an inspector in the department',
  },
  'invoice.view': { scopes: ['ALL'], description: 'View invoices' },
  'invoice.register': {
    scopes: ['ALL'],
    description: 'Register vendor invoices (three-way match shown)',
  },
  'payment_request.approve': {
    scopes: ['ASSIGNED'],
    description: 'Approve payment of a matched invoice',
  },
  'payment.record': {
    scopes: ['ALL'],
    description: 'Record payments manually and close the purchase',
  },
  'purchase_file.view': {
    scopes: ['ALL', 'OWN_DEPARTMENT'],
    description: 'Purchase file: full timeline and documents',
  },
  'procurement_document.upload': {
    scopes: ['ALL'],
    description: 'Upload documents to purchase records',
  },
});
