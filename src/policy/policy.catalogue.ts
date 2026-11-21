/**
 * Policy settings: separation-of-duties rules and security settings. Like
 * permissions, they are defined in code and synced to `policy_settings` at
 * boot; administrators change `enabled` and `parameters`, never the codes.
 * Values here are the AzamTV go-live values (user-employee-spec.md §7, §9).
 */
export interface PolicyDefinition {
  category: 'SOD' | 'SECURITY' | 'PROCUREMENT';
  description: string;
  enabled: boolean;
  parameters?: Record<string, unknown>;
}

export const POLICY_CATALOGUE = {
  // ── Separation of duties (A1) ────────────────────────────────────────────
  SOD_DELEGATE_SELF: {
    category: 'SOD',
    description: 'Nobody approves their own delegation',
    enabled: true,
  },
  SOD_ROLE_SELF_GRANT: {
    category: 'SOD',
    description: 'Nobody grants roles or permissions to themselves',
    enabled: true,
  },
  SOD_GRANT_ONLY_HELD: {
    category: 'SOD',
    description:
      'You can only grant or assign permissions you hold yourself (spec §6.7)',
    enabled: true,
  },
  SOD_ADMIN_PROCUREMENT: {
    category: 'SOD',
    description: 'Administrators hold no procurement action permissions',
    enabled: true,
  },
  SOD_EXIT_SELF_CLEAR: {
    category: 'SOD',
    description: 'Nobody signs off their own exit clearance',
    enabled: true,
  },

  // ── Separation of duties (B1 Product Repository, B2 Store) ─────────────
  SOD_PRODUCT_SELF_APPROVE: {
    category: 'SOD',
    description: 'The author of a product cannot approve its activation',
    enabled: true,
  },
  SOD_TRANSFER_SELF_RECEIVE: {
    category: 'SOD',
    description: 'The dispatcher of a transfer cannot confirm its receipt',
    enabled: true,
  },
  SOD_COUNT_CUSTODIAN: {
    category: 'SOD',
    description:
      "A store's storekeeper cannot be the only counter in its count",
    enabled: true,
  },
  SOD_DISPOSAL_REQUESTER: {
    category: 'SOD',
    description: 'The proposer of a disposal cannot give its final approval',
    enabled: true,
  },
  // ── Separation of duties (B1 sourcing, tender spec §12 + access-control §5) ──
  SOD_REVIEW_TENDER: {
    category: 'SOD',
    description:
      'Whoever did the procurement review of a request cannot create its tender',
    enabled: true,
  },
  SOD_TENDER_COMMITTEE: {
    category: 'SOD',
    description:
      'The officer who created or published a tender is not on its committee',
    enabled: true,
  },
  SOD_COMMITTEE_COI: {
    category: 'SOD',
    description:
      'A committee member cannot act before declaring no conflict of interest',
    enabled: true,
  },
  SOD_AWARD_COMMITTEE: {
    category: 'SOD',
    description:
      'The final award approver (CEO) cannot sit on that tender’s committee',
    enabled: true,
  },
  SOD_RECEIVE_INSPECT: {
    category: 'SOD',
    description: 'Whoever recorded the GRN cannot inspect the same delivery',
    enabled: true,
  },
  SOD_REQUEST_INSPECT: {
    category: 'SOD',
    description: 'The requester cannot inspect their own request’s items',
    enabled: true,
  },
  SOD_LPO_RECEIVE: {
    category: 'SOD',
    description: 'Whoever issued the LPO cannot record its GRN',
    enabled: true,
  },
  SOD_INVOICE_PAYMENT: {
    category: 'SOD',
    description: 'Whoever registered the invoice cannot approve its payment',
    enabled: true,
  },
  // ── Procurement policies (requirements §3.9; tender spec §2, §14) ──
  PROC_CASH_THRESHOLD: {
    category: 'PROCUREMENT',
    description:
      'Cash purchase threshold (TZS): lines below it may be bought for cash. AzamTV to set.',
    enabled: true,
    parameters: { amount: 500000 },
  },
  PROC_MIN_QUOTATIONS: {
    category: 'PROCUREMENT',
    description:
      'Minimum number of quotations per item (disabled: one compliant quotation can win)',
    enabled: false,
    parameters: { count: 3 },
  },
  PROC_OPENING_CONFIRMATIONS: {
    category: 'PROCUREMENT',
    description: 'Committee confirmations needed to open sealed bids',
    enabled: true,
    parameters: { count: 2 },
  },
  PROC_CLARIFICATIONS: {
    category: 'PROCUREMENT',
    description:
      'Clarification deadline before closing (hours) and closing extension after an addendum (days)',
    enabled: true,
    parameters: { deadlineHours: 48, addendumExtensionDays: 3 },
  },
  PROC_BID_VALIDITY: {
    category: 'PROCUREMENT',
    description: 'Minimum bid validity (days)',
    enabled: true,
    parameters: { days: 90 },
  },
  PROC_VENDOR_VALIDITY: {
    category: 'PROCUREMENT',
    description:
      'Vendor registration validity (years); renewal reminder (days before)',
    enabled: true,
    parameters: { years: 2, reminderDays: 30 },
  },
  PROC_STANDSTILL: {
    category: 'PROCUREMENT',
    description:
      'Standstill period (days) between award notification and LPO issue (public-sector rule, off)',
    enabled: false,
    parameters: { days: 7 },
  },
  SOD_HANDOVER_SELF: {
    category: 'SOD',
    description: 'A storekeeper cannot hand over an item to themselves',
    enabled: true,
  },
  SOD_RETURN_SELF: {
    category: 'SOD',
    description: 'A storekeeper cannot receive the return of an item they hold',
    enabled: true,
  },
  SOD_LOSS_SELF_APPROVE: {
    category: 'SOD',
    description:
      'The custodian cannot approve the loss report or responsibility decision about their own item',
    enabled: true,
  },
  SOD_ADJUST_SELF_APPROVE: {
    category: 'SOD',
    description: 'The creator of a stock adjustment cannot approve it',
    enabled: true,
  },

  // ── Security settings ────────────────────────────────────────────────────
  SECURITY_EMAIL_DOMAINS: {
    category: 'SECURITY',
    description: 'Allowed company email domain(s) for employees and users',
    enabled: true,
    // Placeholder until AzamTV confirms its domain(s) (setup data).
    parameters: { domains: ['azamtv.co.tz'] },
  },
  SECURITY_PASSWORD_POLICY: {
    category: 'SECURITY',
    description:
      'Password rules: minimum length, letter + number, not common, not name/email, history; optional expiry',
    enabled: true,
    parameters: { minLength: 10, historyCount: 5, expiryDays: null },
  },
  SECURITY_LOCKOUT: {
    category: 'SECURITY',
    description: 'Lock the account after repeated failed logins',
    enabled: true,
    parameters: { maxAttempts: 5, lockMinutes: 15 },
  },
  SECURITY_ACTIVATION_LINK: {
    category: 'SECURITY',
    description: 'Validity of the account activation link (single use)',
    enabled: true,
    parameters: { validHours: 24 },
  },
  SECURITY_RESET_LINK: {
    category: 'SECURITY',
    description: 'Validity of the self-service password reset link',
    enabled: true,
    parameters: { validMinutes: 30 },
  },
  SECURITY_SESSIONS: {
    category: 'SECURITY',
    description: 'Session idle timeout and absolute lifetime',
    enabled: true,
    parameters: { idleMinutes: 30, absoluteHours: 12 },
  },
  SECURITY_TWO_FACTOR: {
    category: 'SECURITY',
    description:
      'Two-factor authentication: mandatory for these roles, optional for others',
    enabled: true,
    parameters: {
      requiredRoles: [
        'System Administrator',
        'CEO',
        'Procurement Officer',
        'Store Manager',
        'Production Manager',
      ],
    },
  },
} satisfies Record<string, PolicyDefinition>;

export type PolicyCode = keyof typeof POLICY_CATALOGUE;
export type SodCode = {
  [K in PolicyCode]: K extends `SOD_${string}` ? K : never;
}[PolicyCode];
