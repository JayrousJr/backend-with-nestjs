import { definePermissions } from './types';

/** A1 — User & Employee Management (user-employee-spec.md §14). */
export const A1_PERMISSIONS = definePermissions('A1', {
  'department.view': { scopes: ['ALL'], description: 'View departments' },
  'department.manage': {
    scopes: ['ALL'],
    description: 'Manage departments, HOD, deputy and acting HOD',
  },
  'job_title.manage': { scopes: ['ALL'], description: 'Manage job titles' },
  'employment_type.manage': {
    scopes: ['ALL'],
    description: 'Manage employment types',
  },
  'employee.view': {
    scopes: ['ALL', 'OWN_DEPARTMENT', 'OWN_RECORDS'],
    description: 'View the employee directory',
  },
  'employee.view_personal': {
    scopes: ['ALL', 'OWN_DEPARTMENT'],
    description:
      'View personal fields (phone, photo, history); exports audited',
  },
  'employee.manage': {
    scopes: ['ALL', 'OWN_DEPARTMENT'],
    description: 'Create and edit employees, change status',
  },
  'employee.import': {
    scopes: ['ALL'],
    description: 'Download template, upload and commit employee imports',
  },
  'employee.exit': {
    scopes: ['ALL'],
    description: 'Set an employee Exited and start exit clearance',
  },
  'employee.exit_clearance.approve': {
    scopes: ['ASSIGNED'],
    description: 'Sign off exit clearances',
  },
  'driver_profile.manage': {
    scopes: ['ALL'],
    description: 'Manage driver licences',
  },
  'user.view': { scopes: ['ALL'], description: 'View users' },
  'user.manage': {
    scopes: ['ALL'],
    description:
      'Create users from employees, deactivate, reactivate, unlock, resend activation',
  },
  'user.assign_role': {
    scopes: ['ALL'],
    description: 'Assign roles to users (only roles you hold, never yourself)',
  },
  'user.reset_password': {
    scopes: ['ALL'],
    description: 'Send a password reset link',
  },
  'role.view': { scopes: ['ALL'], description: 'View roles and grants' },
  'role.manage': { scopes: ['ALL'], description: 'Role builder' },
  'group.manage': { scopes: ['ALL'], description: 'Manage user groups' },
  'delegation.create': {
    scopes: ['OWN_RECORDS', 'ALL'],
    description: 'Create delegations',
  },
  'delegation.approve': { scopes: ['ALL'], description: 'Approve delegations' },
  'policy.view': {
    scopes: ['ALL'],
    description: 'View SoD and security settings',
  },
  'policy.manage': {
    scopes: ['ALL'],
    description: 'Change SoD and security settings',
  },
  'workflow.view': { scopes: ['ALL'], description: 'View approval chains' },
  'workflow.manage': { scopes: ['ALL'], description: 'Edit approval chains' },
  'workflow.activate': {
    scopes: ['ALL'],
    description: 'Activate approval chain versions',
  },
  'audit.view': {
    scopes: ['ALL', 'OWN_DEPARTMENT'],
    description: 'View the audit log',
  },
  'security.view_logins': {
    scopes: ['ALL'],
    description: 'View login history and security events',
  },
});

/** Shared services. */
export const SHARED_PERMISSIONS = definePermissions('SHARED', {
  'file.view': { scopes: ['ALL'], description: 'Browse uploaded files' },
  'file.delete': { scopes: ['ALL'], description: 'Archive uploaded files' },
});
