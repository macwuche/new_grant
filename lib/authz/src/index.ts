// Staff roles and permissions, shared by the API (which enforces them) and the
// portal (which uses them to show or disable controls). One list, one source.

export type StaffRole = 'super' | 'reviewer' | 'finance' | 'compliance' | 'support';

export type Permission =
  | 'applications.review' | 'applications.escalate' | 'applications.clearEscalation' | 'notes.add'
  | 'programs.manage' | 'payments.process' | 'payments.release' | 'treasury.manage'
  | 'kyc.review' | 'accounts.manage' | 'accounts.tier' | 'staff.manage' | 'security.lockdown' | 'audit.view';

export const STAFF_ROLES: StaffRole[] = ['super', 'reviewer', 'finance', 'compliance', 'support'];

export const ROLE_LABELS: Record<StaffRole, string> = {
  super: 'Super admin', reviewer: 'Grant reviewer', finance: 'Finance admin', compliance: 'Compliance & risk', support: 'Support agent',
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  'applications.review': 'review and decide applications',
  'applications.escalate': 'escalate applications to security',
  'applications.clearEscalation': 'clear security escalations',
  'notes.add': 'add internal notes',
  'programs.manage': 'manage grant programs',
  'payments.process': 'process deposits and payouts',
  'payments.release': 'give the second sign-off on large payouts and deposits',
  'treasury.manage': 'change money settings',
  'kyc.review': 'review identity checks',
  'accounts.manage': 'lock accounts and force credential resets',
  'accounts.tier': 'change account tiers',
  'staff.manage': 'assign staff roles',
  'security.lockdown': 'start or end a system lockdown',
  'audit.view': 'view the audit log',
};

export const ROLE_PERMISSIONS: Record<StaffRole, Permission[]> = {
  super: Object.keys(PERMISSION_LABELS) as Permission[],
  reviewer: ['applications.review', 'applications.escalate', 'notes.add'],
  finance: ['payments.process', 'treasury.manage', 'notes.add'],
  compliance: ['applications.escalate', 'applications.clearEscalation', 'notes.add', 'payments.release', 'kyc.review', 'accounts.manage', 'accounts.tier', 'audit.view'],
  support: [],
};

export const isStaffRole = (value: unknown): value is StaffRole => typeof value === 'string' && (STAFF_ROLES as string[]).includes(value);
export const roleCan = (role: StaffRole, permission: Permission) => ROLE_PERMISSIONS[role].includes(permission);

export type StaffLike = { id: string; role: StaffRole; active: boolean; name: string };
export type StaffPatch = { role?: StaffRole; active?: boolean };

/**
 * Checks a role or access change to one staff member. Returns an error message,
 * or null if allowed. Rules: the member must exist, the role must be valid, at
 * least one active super admin must remain, and nobody disables their own access.
 */
export function staffChangeError(staff: StaffLike[], targetId: string, patch: StaffPatch, actorId: string): string | null {
  const member = staff.find(m => m.id === targetId);
  if (!member) return 'That staff member could not be found.';
  if (patch.role !== undefined && !isStaffRole(patch.role)) return 'Choose a valid role.';
  if (patch.role !== undefined && patch.role === member.role && patch.active === undefined) return `${member.name} is already ${ROLE_LABELS[member.role]}.`;
  if (patch.active !== undefined && patch.active === member.active && patch.role === undefined) return `${member.name}'s access is already ${member.active ? 'enabled' : 'disabled'}.`;
  if (patch.active === false && targetId === actorId) return "You can't disable your own access.";
  const after = staff.map(m => m.id === targetId ? { ...m, ...patch } : m);
  if (!after.some(m => m.active && m.role === 'super')) return 'At least one active super admin must remain.';
  return null;
}
