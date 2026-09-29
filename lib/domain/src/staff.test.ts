import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result } from './model';
import * as A from './audit';
import * as S from './staff';
import * as Rv from './review';
import * as T from './treasury';
import { createSeedState } from './seed';

const now = new Date('2026-09-25T12:00:00Z');
let s: DemoState;
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  s = result.state;
  return result;
}
const as = (staffId: string) => accept(S.switchStaff(s, staffId));
const version = (id: string) => s.applications.find(a => a.id === id)!.updatedAt;

beforeEach(() => { s = createSeedState(); });

describe('roles and permissions', () => {
  it('starts as the super admin, who can do everything', () => {
    expect(S.actingStaff(s)?.role).toBe('super');
    for (const p of Object.keys(S.PERMISSION_LABELS) as S.Permission[]) expect(S.can(s, p)).toBe(true);
  });

  it('keeps review, finance, and compliance duties apart', () => {
    as('STF-2'); // reviewer
    expect(S.can(s, 'applications.review')).toBe(true);
    expect(S.can(s, 'payments.process')).toBe(false);
    as('STF-3'); // finance
    expect(S.can(s, 'payments.process')).toBe(true);
    expect(S.can(s, 'applications.review')).toBe(false);
    expect(S.can(s, 'payments.release')).toBe(false);
    as('STF-4'); // compliance
    expect(S.can(s, 'payments.release')).toBe(true);
    expect(S.can(s, 'kyc.review')).toBe(true);
    expect(S.can(s, 'treasury.manage')).toBe(false);
  });

  it('gives support agents read-only access', () => {
    as('STF-5');
    expect(S.ROLE_PERMISSIONS.support).toEqual([]);
    const result = S.asStaff(s, 'applications.review', { action: 'Start review', target: 'APP-2050' }, now, (st, actor) => Rv.startReview(st, 'APP-2050', version('APP-2050'), actor.name, now));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Support agent.*can't review/);
  });

  it('refuses disabled or unknown staff', () => {
    expect(S.switchStaff(s, 'STF-99').ok).toBe(false);
    accept(S.setStaffActive(s, 'STF-2', false));
    expect(S.switchStaff(s, 'STF-2').ok).toBe(false);
  });

  it('always keeps an active super admin and never disables yourself', () => {
    expect(S.setStaffRole(s, 'STF-1', 'finance').ok).toBe(false);
    expect(S.setStaffActive(s, 'STF-1', false).ok).toBe(false);
    accept(S.setStaffRole(s, 'STF-4', 'super'));
    as('STF-4');
    accept(S.setStaffRole(s, 'STF-1', 'finance'));
    expect(S.setStaffActive(s, 'STF-4', false).ok).toBe(false);
  });
});

describe('signed-in staff', () => {
  it('becomes the acting member with their server role, and is updated in place', () => {
    accept(S.adoptSessionStaff(s, { id: 'b7c1e2d4-0000-4000-8000-000000000001', name: 'Dana Real', role: 'finance' }));
    expect(S.actingStaff(s)).toMatchObject({ name: 'Dana Real', role: 'finance', active: true });
    expect(S.can(s, 'payments.process')).toBe(true);
    expect(S.can(s, 'staff.manage')).toBe(false);
    const count = s.staff.length;
    accept(S.adoptSessionStaff(s, { id: 'b7c1e2d4-0000-4000-8000-000000000001', name: 'Dana Real', role: 'super' }));
    expect(s.staff.length).toBe(count);
    expect(S.can(s, 'staff.manage')).toBe(true);
    const same = S.adoptSessionStaff(s, { id: 'b7c1e2d4-0000-4000-8000-000000000001', name: 'Dana Real', role: 'super' });
    expect(same.ok && same.state).toBe(s);
  });
});

describe('audit log', () => {
  it('records who did what, to which record, with the field changes and risk score', () => {
    as('STF-2');
    accept(S.asStaff(s, 'applications.review', { action: 'Start review', target: 'APP-2050' }, now, (st, actor) => Rv.startReview(st, 'APP-2050', version('APP-2050'), actor.name, now)));
    const entry = s.audit.at(-1)!;
    expect(entry).toMatchObject({ staffId: 'STF-2', staffName: 'Avery Taylor', role: 'reviewer', action: 'Start review', target: 'APP-2050', applicantId: 'APL-1045' });
    expect(entry.changes).toEqual(expect.arrayContaining([{ field: 'status', before: 'Submitted', after: 'Under review' }, { field: 'reviewer', before: '—', after: 'Avery Taylor' }]));
    expect(typeof entry.riskScore).toBe('number');
  });

  it('flattens nested settings into readable field paths', () => {
    const { updatedAt: _u, changeLog: _c, ...input } = s.treasury;
    const { channels: _ch, ...rest } = input;
    const next = { ...rest, applicationFee: 5 };
    accept(S.asStaff(s, 'treasury.manage', { action: 'Update money settings', target: 'treasury' }, now, (st, actor) => T.updateTreasury(st, st.treasury.updatedAt, next, actor.name, now)));
    expect(s.audit.at(-1)!.changes).toEqual([{ field: 'applicationFee', before: '0', after: '5' }]);
    expect(s.audit.at(-1)!.applicantId).toBeNull();
  });

  it('does not log refused or failed actions', () => {
    as('STF-5');
    S.asStaff(s, 'applications.review', { action: 'x', target: 'APP-2050' }, now, st => ({ ok: true, message: '', state: st }));
    as('STF-2');
    S.asStaff(s, 'applications.review', { action: 'x', target: 'APP-2050' }, now, () => ({ ok: false, error: 'nope' }));
    expect(s.audit).toEqual([]);
  });

  it('filters by person, action, text, and date, newest first', () => {
    const log = (at: string, staff: string, action: string) => {
      as(staff);
      accept(S.asStaff(s, 'notes.add', { action, target: 'APP-2051' }, new Date(at), (st, actor) => Rv.addInternalNote(st, 'APP-2051', action, actor.name, new Date(at))));
    };
    log('2026-09-20T10:00:00Z', 'STF-2', 'Add note');
    log('2026-09-22T10:00:00Z', 'STF-4', 'Add note');
    log('2026-09-24T10:00:00Z', 'STF-4', 'Other');
    expect(A.filterAudit(s).map(e => e.action)).toEqual(['Other', 'Add note', 'Add note']);
    expect(A.filterAudit(s, { staffId: 'STF-4', action: 'Add note' })).toHaveLength(1);
    expect(A.filterAudit(s, { from: '2026-09-21', to: '2026-09-23' })).toHaveLength(1);
    expect(A.filterAudit(s, { query: 'avery' })).toHaveLength(1);
  });

  it('exports CSV and JSON with the spec columns', () => {
    as('STF-2');
    accept(S.asStaff(s, 'notes.add', { action: 'Add note', target: 'APP-2051' }, now, (st, actor) => Rv.addInternalNote(st, 'APP-2051', 'Quote "confirmed"', actor.name, now)));
    const csv = A.auditToCsv(s.audit);
    expect(csv.split('\n')[1]).toBe('id,timestamp,admin_id,admin_user,role,action,entity,target_user_id,ip_address,risk_score,summary,changes');
    expect(csv).toContain('"not captured"');
    expect(JSON.parse(A.auditToJson(s.audit)).events).toHaveLength(1);
  });
});
