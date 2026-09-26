import type { DemoState, Result, StaffMember, StaffRole } from './model';
import { fail } from './core';
import { recordAudit } from './audit';

// Staff roles and permissions (RBAC). Admin screens run every staff command
// through `asStaff`, which checks the acting member's role and appends an audit
// entry in the same step. There is still no real sign-in: the member switcher
// in /admin stands in for a staff session, so this is a demo of the rules, not
// a security boundary.

export type Permission =
  | 'applications.review' | 'applications.escalate' | 'applications.clearEscalation' | 'notes.add'
  | 'programs.manage' | 'payments.process' | 'payments.release' | 'treasury.manage'
  | 'kyc.review' | 'accounts.manage' | 'accounts.tier' | 'staff.manage' | 'security.lockdown' | 'audit.view';

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
  'payments.release': 'give the second sign-off on large payouts',
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

export const actingStaff = (state: DemoState): StaffMember | undefined => state.staff.find(m => m.id === state.actingStaffId && m.active);
export const roleCan = (role: StaffRole, permission: Permission) => ROLE_PERMISSIONS[role].includes(permission);
export const can = (state: DemoState, permission: Permission) => { const me = actingStaff(state); return !!me && roleCan(me.role, permission); };

export function permissionError(state: DemoState, permission: Permission): string | null {
  const me = actingStaff(state);
  if (!me) return 'No active staff member is selected. Choose who you are acting as.';
  return roleCan(me.role, permission) ? null : `${me.name} (${ROLE_LABELS[me.role]}) can't ${PERMISSION_LABELS[permission]}. Switch to a staff member whose role allows it.`;
}

export type StaffAction = { action: string; target: string };

/**
 * Runs a staff command as the acting member: checks the permission, passes the
 * member's name as the actor, and audits the change. `target` may be empty when
 * the command creates the record; the result's `id` is used instead.
 */
export function asStaff(state: DemoState, permission: Permission, meta: StaffAction, now: Date, command: (state: DemoState, actor: StaffMember) => Result): Result {
  const denied = permissionError(state, permission);
  if (denied) return fail(denied);
  const actor = actingStaff(state)!;
  const result = command(state, actor);
  if (!result.ok) return result;
  return { ...result, state: recordAudit(state, result.state, actor, meta.action, meta.target || result.id || '', result.message, now) };
}

/** Demo stand-in for signing in as a different staff member. */
export function switchStaff(state: DemoState, staffId: string): Result {
  const member = state.staff.find(m => m.id === staffId);
  if (!member) return fail('That staff member could not be found.');
  if (!member.active) return fail(`${member.name}'s access is disabled.`);
  return { ok: true, message: `Now acting as ${member.name} (${ROLE_LABELS[member.role]}).`, state: { ...state, actingStaffId: staffId } };
}

const activeSupers = (staff: StaffMember[]) => staff.filter(m => m.active && m.role === 'super').length;

function updateMember(state: DemoState, staffId: string, patch: Partial<StaffMember>): Result {
  const member = state.staff.find(m => m.id === staffId);
  if (!member) return fail('That staff member could not be found.');
  const staff = state.staff.map(m => m.id === staffId ? { ...m, ...patch } : m);
  if (!activeSupers(staff)) return fail('At least one active super admin must remain.');
  if (patch.active === false && staffId === state.actingStaffId) return fail("You can't disable your own access.");
  return { ok: true, id: staffId, message: '', state: { ...state, staff } };
}

export function setStaffRole(state: DemoState, staffId: string, role: StaffRole): Result {
  if (!(role in ROLE_LABELS)) return fail('Choose a valid role.');
  const member = state.staff.find(m => m.id === staffId);
  if (member?.role === role) return fail(`${member.name} is already ${ROLE_LABELS[role]}.`);
  const result = updateMember(state, staffId, { role });
  return result.ok ? { ...result, message: `${member!.name} is now ${ROLE_LABELS[role]}.` } : result;
}

export function setStaffActive(state: DemoState, staffId: string, active: boolean): Result {
  const member = state.staff.find(m => m.id === staffId);
  if (member && member.active === active) return fail(`${member.name}'s access is already ${active ? 'enabled' : 'disabled'}.`);
  const result = updateMember(state, staffId, { active });
  return result.ok ? { ...result, message: `${member!.name}'s access ${active ? 'restored' : 'disabled'}.` } : result;
}
