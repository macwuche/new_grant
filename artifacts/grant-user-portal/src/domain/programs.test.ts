import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Grant, GrantInput, Result } from './model';
import * as G from './programs';
import * as N from './notifications';
import * as R from './rules';
import * as V from './review';
import { createSeedState } from './seed';
import { migrateState } from './store';

const now = new Date('2026-09-25T12:00:00Z');
const PM = 'Sam Rivera';

let s: DemoState;
const program = (id: string) => s.grants.find(g => g.id === id)!;
const inputOf = (g: Grant): GrantInput => ({ name: g.name, summary: g.summary, focus: g.focus, maxFunding: g.maxFunding, minimumRequest: g.minimumRequest, budget: g.budget, deadline: g.deadline, minimumTier: g.minimumTier, requirements: [...g.requirements], requiresRegistration: g.requiresRegistration, questions: g.questions.map(q => ({ ...q })) });
const valid: GrantInput = { name: 'Rural Broadband', summary: 'Connect small rural businesses to reliable internet.', focus: 'Rural business', maxFunding: 6000, minimumRequest: 500, budget: 60000, deadline: '2027-03-31', minimumTier: 1, requirements: ['Installer quote', ' Proof of address '], requiresRegistration: false, questions: [] };
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error} ${JSON.stringify(result.fieldErrors ?? {})}`);
  s = result.state;
  return result;
}
function errorsOf(result: Result) {
  expect(result.ok).toBe(false);
  return result.ok ? {} : result.fieldErrors ?? {};
}

beforeEach(() => { s = createSeedState(); });

describe('create', () => {
  it('creates a normalized draft with a change log entry', () => {
    const { id } = accept(G.createProgram(s, valid, PM, now));
    expect(program(id!)).toMatchObject({ status: 'Draft', requirements: ['Installer quote', 'Proof of address'], changeLog: [{ by: PM, summary: 'Created as draft.' }] });
    expect(R.visibleGrants(s).some(g => g.id === id)).toBe(false);
  });

  it('validates every field', () => {
    const errors = errorsOf(G.createProgram(s, { ...valid, name: 'x', summary: 'short', focus: '', minimumRequest: -1, maxFunding: 100.001, budget: 0, deadline: '2027-02-30', minimumTier: 4 as never, requirements: ['  '] }, PM, now));
    expect(Object.keys(errors).sort()).toEqual(['budget', 'deadline', 'focus', 'maxFunding', 'minimumRequest', 'minimumTier', 'name', 'requirements', 'summary']);
  });

  it('checks amounts relate sensibly and names are unique', () => {
    expect(errorsOf(G.createProgram(s, { ...valid, maxFunding: 400 }, PM, now)).maxFunding).toMatch(/at least the minimum/);
    expect(errorsOf(G.createProgram(s, { ...valid, budget: 5000 }, PM, now)).budget).toMatch(/at least one maximum award/);
    expect(errorsOf(G.createProgram(s, { ...valid, name: 'green transition' }, PM, now)).name).toMatch(/already uses/);
    expect(errorsOf(G.createProgram(s, { ...valid, requirements: ['A', 'a'] }, PM, now)).requirements).toMatch(/different/);
  });
});

describe('publish, close, reopen, delete', () => {
  it('publishes a draft so applicants can apply', () => {
    accept(G.publishProgram(s, 'space', program('space').updatedAt, PM, now));
    expect(program('space').status).toBe('Open');
    expect(R.checkEligibility(program('space'), s.profile, R.ownApplications(s), now).eligible).toBe(true);
    expect(program('space').changeLog.at(-1)).toMatchObject({ summary: 'Published.', by: PM });
  });

  it('refuses to publish with a past deadline', () => {
    accept(G.updateProgram(s, 'space', program('space').updatedAt, { ...inputOf(program('space')), deadline: '2026-01-01' }, PM, now));
    const result = G.publishProgram(s, 'space', program('space').updatedAt, PM, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.deadline).toBeDefined();
  });

  it('closes an open program, keeps in-flight work, and notifies draft holders', () => {
    accept(G.closeProgram(s, 'green', program('green').updatedAt, PM, now));
    expect(program('green').status).toBe('Closed');
    expect(N.ownNotifications(s)[0]).toMatchObject({ title: 'Green Transition closed', href: '/applications/APP-2101' });
    expect(R.checkEligibility(program('green'), s.profile, [], now).eligible).toBe(false);
    // Reviews on the closed program continue.
    accept(V.startReview(s, 'APP-2050', s.applications.find(a => a.id === 'APP-2050')!.updatedAt, 'Avery Taylor', now));
  });

  it('reopens a closed program', () => {
    accept(G.closeProgram(s, 'green', program('green').updatedAt, PM, now));
    accept(G.publishProgram(s, 'green', program('green').updatedAt, PM, now));
    expect(program('green').status).toBe('Open');
    expect(program('green').changeLog.at(-1)!.summary).toBe('Reopened.');
  });

  it('rejects invalid status moves', () => {
    expect(G.publishProgram(s, 'green', program('green').updatedAt, PM, now).ok).toBe(false);
    expect(G.closeProgram(s, 'space', program('space').updatedAt, PM, now).ok).toBe(false);
  });

  it('deletes only unused drafts', () => {
    expect(G.deleteProgram(s, 'green', program('green').updatedAt).ok).toBe(false);
    accept(G.deleteProgram(s, 'space', program('space').updatedAt));
    expect(s.grants.some(g => g.id === 'space')).toBe(false);
  });

  it('rejects stale versions', () => {
    const result = G.closeProgram(s, 'green', '2020-01-01T00:00:00.000Z', PM, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/changed since you opened it/);
  });
});

describe('editing', () => {
  it('logs which fields changed', () => {
    accept(G.updateProgram(s, 'space', program('space').updatedAt, { ...inputOf(program('space')), budget: 120000, summary: 'Updated summary for shared spaces.' }, PM, now));
    expect(program('space').changeLog.at(-1)!.summary).toBe('Edited summary, budget.');
  });

  it('rejects a save with no changes', () => {
    expect(G.updateProgram(s, 'space', program('space').updatedAt, inputOf(program('space')), PM, now).ok).toBe(false);
  });

  it('locks eligibility criteria once applications are submitted', () => {
    const g = program('momentum');
    const errors = errorsOf(G.updateProgram(s, 'momentum', g.updatedAt, { ...inputOf(g), minimumTier: 1, requirements: ['Anything'], requiresRegistration: false, minimumRequest: 10, maxFunding: 12000 }, PM, now));
    expect(Object.keys(errors).sort()).toEqual(['maxFunding', 'minimumRequest', 'minimumTier', 'requirements', 'requiresRegistration']);
    accept(G.updateProgram(s, 'momentum', g.updatedAt, { ...inputOf(g), maxFunding: 15000, deadline: '2026-12-31' }, PM, now));
    expect(program('momentum').maxFunding).toBe(15000);
  });

  it('keeps criteria editable when only drafts exist', () => {
    s = { ...s, applications: s.applications.filter(a => a.grantId !== 'green' || a.status === 'Draft') };
    accept(G.updateProgram(s, 'green', program('green').updatedAt, { ...inputOf(program('green')), minimumTier: 1 }, PM, now));
  });

  it('never lowers the budget below what is awarded', () => {
    const g = program('creative'); // 4,200 awarded in seed data
    expect(errorsOf(G.updateProgram(s, 'creative', g.updatedAt, { ...inputOf(g), budget: 4000 }, PM, now)).budget).toBeDefined();
  });

  it('requires an open program’s deadline to stay in the future', () => {
    const g = program('green');
    expect(errorsOf(G.updateProgram(s, 'green', g.updatedAt, { ...inputOf(g), deadline: '2026-09-01' }, PM, now)).deadline).toMatch(/Close it instead/);
  });
});

describe('saved-data migration', () => {
  it('upgrades v2 data through v5, keeping applications and adding the catalog, money settings, and staff', () => {
    const { grants: _g, notifications: _n, treasury: _t, staffFeed: _f, ...rest } = createSeedState();
    const v2 = { ...rest, version: 2, applications: rest.applications.slice(0, 1) };
    const migrated = migrateState(JSON.parse(JSON.stringify(v2)))!;
    expect(migrated.version).toBe(5);
    expect(migrated.staff.length).toBeGreaterThan(0);
    expect(migrated.audit).toEqual([]);
    expect(migrated.treasury.channels.length).toBeGreaterThan(0);
    expect(migrated.staffFeed).toEqual([]);
    expect(migrated.applications).toHaveLength(1);
    expect(migrated.grants.map(g => g.id)).toContain('momentum');
    expect(migrated.notifications).toEqual([]);
  });

  it('rejects unknown shapes', () => {
    expect(migrateState({ version: 1, applications: [], transactions: [] })).toBeNull();
    expect(migrateState(null)).toBeNull();
  });
});
