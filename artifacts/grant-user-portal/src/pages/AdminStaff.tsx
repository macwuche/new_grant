import { useEffect, useState } from 'react';
import { Check, Lock, UserCog } from 'lucide-react';
import type { Result, StaffMember, StaffRole } from '@/domain/model';
import {
  actingStaff, asStaff, can, PERMISSION_LABELS, permissionError, ROLE_LABELS, ROLE_PERMISSIONS,
  setStaffActive, setStaffRole, switchStaff, type Permission, type StaffAction,
} from '@/domain/staff';
import { useDemoStore } from '@/domain/store';
import { useStaffSession } from '@/lib/staffSession';
import { createStaffMember, listStaff, updateStaffMember, type StaffMember as ApiStaffMember } from '@workspace/api-client-react';

/** Runs a staff command as the acting member: permission check + audit entry, in one step. */
export function useStaffCommand() {
  const { run } = useDemoStore();
  return (permission: Permission, meta: StaffAction, command: (state: Parameters<typeof asStaff>[0], actor: StaffMember) => Result) =>
    run(s => asStaff(s, permission, meta, new Date(), command));
}

export function useCan() {
  const { state } = useDemoStore();
  return (permission: Permission) => can(state, permission);
}

/** Tells the acting member why controls are disabled for their role. */
export function RoleNotice({ permission }: { permission: Permission }) {
  const { state } = useDemoStore();
  const error = permissionError(state, permission);
  return error ? <p className="admin-review-hint admin-role-notice" data-testid={`notice-admin-role-${permission}`}><Lock size={11} /> {error}</p> : null;
}

const initials = (name: string) => name.split(' ').map(p => p[0]).join('').slice(0, 2);

/** Topbar control: which staff member this browser acts as. Stands in for a staff sign-in. */
export function StaffSwitcher() {
  const { state, run } = useDemoStore();
  const me = actingStaff(state);
  return <label className="admin-staff-switcher" title="Demo only: choose which staff member you act as. There is no staff sign-in yet.">
    <span className="admin-avatar" aria-hidden="true">{me ? initials(me.name) : '?'}</span>
    <span className="admin-staff-switcher-copy"><small>Acting as</small>
      <select value={me?.id ?? ''} onChange={e => run(s => switchStaff(s, e.target.value))} aria-label="Acting as staff member" data-testid="select-admin-acting-staff">
        {!me && <option value="">Choose…</option>}
        {state.staff.filter(m => m.active).map(m => <option key={m.id} value={m.id}>{m.name} · {ROLE_LABELS[m.role]}</option>)}
      </select>
    </span>
  </label>;
}

const ROLES = Object.keys(ROLE_LABELS) as StaffRole[];
const PERMISSIONS = Object.keys(PERMISSION_LABELS) as Permission[];

/** Settings panel: staff roster, role assignment (super admin only), and the permission matrix. */
export function AdminTeamSettings() {
  const { state } = useDemoStore();
  const command = useStaffCommand();
  const allowed = can(state, 'staff.manage');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const report = (result: Result) => setFlash(result.ok ? { tone: 'ok', text: result.message } : { tone: 'error', text: result.error });

  return <section className="admin-panel admin-treasury" aria-labelledby="team-title" data-testid="panel-admin-team">
    <div className="admin-panel-head"><div><h2 id="team-title"><UserCog size={16} style={{ display: 'inline', verticalAlign: '-3px' }} /> Team & roles</h2><p>Who can do what. Every action in this workspace is checked against the acting member's role and written to the audit log. Demo roster; there is no staff sign-in yet, so this shows the rules rather than enforcing them against real people.</p></div></div>
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-team-flash">{flash.text}</div>}
    <RoleNotice permission="staff.manage" />
    <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Staff member</th><th>Role</th><th>Access</th></tr></thead><tbody>{state.staff.map(m => <tr key={m.id} data-testid={`row-admin-staff-${m.id}`}>
      <td><span className="admin-table-primary">{m.name}{m.id === state.actingStaffId && <span className="admin-flag">You</span>}</span><span className="admin-table-secondary">{m.id}</span></td>
      <td><select className="admin-filter" value={m.role} disabled={!allowed} onChange={e => report(command('staff.manage', { action: 'Change staff role', target: m.id }, s => setStaffRole(s, m.id, e.target.value as StaffRole)))} aria-label={`Role for ${m.name}`} data-testid={`select-admin-staff-role-${m.id}`}>{ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></td>
      <td><button type="button" className="admin-btn" disabled={!allowed} onClick={() => report(command('staff.manage', { action: m.active ? 'Disable staff access' : 'Restore staff access', target: m.id }, s => setStaffActive(s, m.id, !m.active)))} data-testid={`button-admin-staff-active-${m.id}`}>{m.active ? 'Disable' : 'Restore'}</button> <span className={`admin-badge ${m.active ? 'active' : 'draft'}`}>{m.active ? 'Active' : 'Disabled'}</span></td>
    </tr>)}</tbody></table></div>

    <h3 className="admin-treasury-heading" style={{ marginTop: 20 }}>Permissions by role</h3>
    <div className="admin-table-wrap"><table className="admin-table admin-permission-matrix"><thead><tr><th>Permission</th>{ROLES.map(r => <th key={r}>{ROLE_LABELS[r]}</th>)}</tr></thead><tbody>{PERMISSIONS.map(p => <tr key={p}>
      <td className="admin-table-muted">{PERMISSION_LABELS[p][0]!.toUpperCase() + PERMISSION_LABELS[p].slice(1)}</td>
      {ROLES.map(r => <td key={r} aria-label={ROLE_PERMISSIONS[r].includes(p) ? 'Allowed' : 'Not allowed'}>{ROLE_PERMISSIONS[r].includes(p) ? <Check size={14} color="#4f742c" /> : <span className="admin-table-muted">—</span>}</td>)}
    </tr>)}</tbody></table></div>
  </section>;
}

/** Signed-in version of Team & roles: the real staff list from the API (super admins only). */
export function AdminTeamServer() {
  const session = useStaffSession();
  const me = session.me?.staff;
  const allowed = !!session.me?.permissions.includes('staff.manage');
  const [staff, setStaff] = useState<ApiStaffMember[] | null>(null);
  const [form, setForm] = useState<{ email: string; name: string; role: StaffRole }>({ email: '', name: '', role: 'reviewer' });
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const errorText = (err: unknown) => { const data = (err as { data?: { error?: unknown } }).data; return typeof data?.error === 'string' ? data.error : 'Something went wrong. Try again.'; };

  useEffect(() => {
    if (!allowed) return;
    listStaff().then(setStaff, err => setFlash({ tone: 'error', text: errorText(err) }));
  }, [allowed]);

  const change = async (member: ApiStaffMember, patch: { role?: StaffRole; active?: boolean }) => {
    setBusy(true);
    try {
      const updated = await updateStaffMember(member.id, patch);
      setStaff(list => list?.map(m => m.id === updated.id ? updated : m) ?? null);
      setFlash({ tone: 'ok', text: patch.role ? `${updated.name} is now ${ROLE_LABELS[updated.role]}.` : `${updated.name}'s access ${updated.active ? 'restored' : 'disabled'}.` });
      if (updated.id === me?.id) session.reloadMe();
    } catch (err) { setFlash({ tone: 'error', text: errorText(err) }); }
    setBusy(false);
  };
  const add = async () => {
    setBusy(true);
    try {
      const created = await createStaffMember({ email: form.email.trim(), name: form.name.trim(), role: form.role });
      setStaff(list => [...(list ?? []), created]);
      setForm({ email: '', name: '', role: 'reviewer' });
      setFlash({ tone: 'ok', text: `${created.name} added. They get access once they sign up with ${created.email} and confirm it.` });
    } catch (err) { setFlash({ tone: 'error', text: errorText(err) }); }
    setBusy(false);
  };

  return <section className="admin-panel admin-treasury" aria-labelledby="team-title" data-testid="panel-admin-team">
    <div className="admin-panel-head"><div><h2 id="team-title"><UserCog size={16} style={{ display: 'inline', verticalAlign: '-3px' }} /> Team & roles</h2><p>Real staff accounts. Roles are checked by the server on every request. Someone you add gets access after they sign up with that email and confirm it.</p></div></div>
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-team-flash">{flash.text}</div>}
    {!allowed ? <p className="admin-review-hint admin-role-notice"><Lock size={11} /> Only super admins can view and change staff roles.</p> : !staff ? <p className="admin-review-hint">Loading staff…</p> : <>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Staff member</th><th>Role</th><th>Access</th></tr></thead><tbody>{staff.map(m => <tr key={m.id} data-testid={`row-admin-staff-${m.id}`}>
        <td><span className="admin-table-primary">{m.name}{m.id === me?.id && <span className="admin-flag">You</span>}</span><span className="admin-table-secondary">{m.email} · {m.linked ? 'signed in before' : 'not signed in yet'}</span></td>
        <td><select className="admin-filter" value={m.role} disabled={busy} onChange={e => void change(m, { role: e.target.value as StaffRole })} aria-label={`Role for ${m.name}`} data-testid={`select-admin-staff-role-${m.id}`}>{ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></td>
        <td><button type="button" className="admin-btn" disabled={busy} onClick={() => void change(m, { active: !m.active })} data-testid={`button-admin-staff-active-${m.id}`}>{m.active ? 'Disable' : 'Restore'}</button> <span className={`admin-badge ${m.active ? 'active' : 'draft'}`}>{m.active ? 'Active' : 'Disabled'}</span></td>
      </tr>)}</tbody></table></div>
      <h3 className="admin-treasury-heading" style={{ marginTop: 18 }}>Add a staff member</h3>
      <div className="admin-form-row">
        <label className="admin-review-field"><span>Work email</span><input className="admin-input" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} data-testid="input-admin-staff-email" /></label>
        <label className="admin-review-field"><span>Name</span><input className="admin-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} data-testid="input-admin-staff-name" /></label>
      </div>
      <div className="admin-review-buttons" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <select className="admin-filter" value={form.role} onChange={e => setForm({ ...form, role: e.target.value as StaffRole })} aria-label="Role for new staff member" data-testid="select-admin-staff-new-role">{ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>
        <button type="button" className="admin-btn primary" disabled={busy || !form.email.trim() || form.name.trim().length < 2} onClick={() => void add()} data-testid="button-admin-staff-add">Add staff member</button>
      </div>
    </>}
  </section>;
}
