import { PERMISSION_LABELS, ROLE_LABELS, roleCan, staffChangeError, type Permission, type StaffPatch } from '@workspace/authz';
import type { DemoState, Result, StaffMember, StaffRole } from './model';
import { fail } from './core';
import { recordAudit } from './audit';

// Staff roles and permissions (RBAC). Admin screens run every staff command
// through `asStaff`, which checks the acting member's role and appends an audit
// entry in the same step. There is still no real sign-in: the member switcher
// in /admin stands in for a staff session, so this is a demo of the rules, not
// a security boundary.

export { PERMISSION_LABELS, ROLE_LABELS, ROLE_PERMISSIONS, roleCan, type Permission } from '@workspace/authz';

export const actingStaff = (state: DemoState): StaffMember | undefined => state.staff.find(m => m.id === state.actingStaffId && m.active);
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

/**
 * Makes the signed-in staff member (from the server) the acting member in this
 * browser's demo store, adding them to its staff list with their real role.
 */
export function adoptSessionStaff(state: DemoState, member: { id: string; name: string; role: StaffRole }): Result {
  const existing = state.staff.find(m => m.id === member.id);
  if (existing && existing.name === member.name && existing.role === member.role && existing.active && state.actingStaffId === member.id) return { ok: true, message: '', state };
  const staff = existing ? state.staff.map(m => m.id === member.id ? { ...m, ...member, active: true } : m) : [...state.staff, { ...member, active: true }];
  return { ok: true, message: `Signed in as ${member.name}.`, state: { ...state, staff, actingStaffId: member.id } };
}

/** Demo stand-in for signing in as a different staff member. */
export function switchStaff(state: DemoState, staffId: string): Result {
  const member = state.staff.find(m => m.id === staffId);
  if (!member) return fail('That staff member could not be found.');
  if (!member.active) return fail(`${member.name}'s access is disabled.`);
  return { ok: true, message: `Now acting as ${member.name} (${ROLE_LABELS[member.role]}).`, state: { ...state, actingStaffId: staffId } };
}

function updateMember(state: DemoState, staffId: string, patch: StaffPatch, message: (member: StaffMember) => string): Result {
  const error = staffChangeError(state.staff, staffId, patch, state.actingStaffId);
  if (error) return fail(error);
  const member = state.staff.find(m => m.id === staffId)!;
  return { ok: true, id: staffId, message: message(member), state: { ...state, staff: state.staff.map(m => m.id === staffId ? { ...m, ...patch } : m) } };
}

export const setStaffRole = (state: DemoState, staffId: string, role: StaffRole): Result =>
  updateMember(state, staffId, { role }, m => `${m.name} is now ${ROLE_LABELS[role]}.`);

export const setStaffActive = (state: DemoState, staffId: string, active: boolean): Result =>
  updateMember(state, staffId, { active }, m => `${m.name}'s access ${active ? 'restored' : 'disabled'}.`);
