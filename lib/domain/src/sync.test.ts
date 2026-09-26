import { describe, expect, it } from 'vitest';
import { createSeedState } from './seed';
import { applicantRecords } from './applicants';
import { CURRENT_APPLICANT_ID } from './seed';
import { adoptServerApplication, adoptServerApplications, leaveServerApplications, adoptServerApplicant, adoptServerApplicants, adoptServerProfile, adoptServerProgram, adoptServerPrograms, dropServerProgram, forStorage, leaveServerApplicants } from './sync';

describe('adopting server data', () => {
  it('replaces the catalog, and keeps the same state object when nothing changed', () => {
    const state = createSeedState();
    const same = adoptServerPrograms(state, structuredClone(state.grants));
    expect(same.ok && same.state).toBe(state);
    const fewer = adoptServerPrograms(state, state.grants.slice(0, 2));
    expect(fewer.ok && fewer.state.grants).toHaveLength(2);
  });

  it('adds, replaces, and drops single programs', () => {
    const state = createSeedState();
    const edited = { ...state.grants[0]!, summary: 'Edited on the server.' };
    const replaced = adoptServerProgram(state, edited);
    expect(replaced.ok && replaced.state.grants[0]!.summary).toBe('Edited on the server.');
    expect(replaced.ok && replaced.state.grants).toHaveLength(state.grants.length);
    const added = adoptServerProgram(state, { ...edited, id: 'PRG-3001', name: 'New one' });
    expect(added.ok && added.state.grants.at(-1)!.id).toBe('PRG-3001');
    const dropped = dropServerProgram(state, state.grants[0]!.id);
    expect(dropped.ok && dropped.state.grants.some(g => g.id === state.grants[0]!.id)).toBe(false);
  });

  it('takes the profile and account controls from the server, keeping only the two-step preference locally', () => {
    const state = createSeedState();
    const account = { status: 'Locked' as const, lockReason: 'Checking a deposit.', passwordResetRequired: true, twoFactorResetRequired: false, kyc: { status: 'Pending' as const } };
    const result = adoptServerProfile(state, { name: 'Maya Okafor', email: 'maya@example.com', phone: '+44 20 7946 0000', address: '', sector: 'Retail', country: 'United Kingdom', joined: '2026-09-26', tier: 1, identityVerified: false }, account);
    if (!result.ok) throw new Error(result.error);
    expect(result.state.profile).toMatchObject({ name: 'Maya Okafor', tier: 1, identityVerified: false, twoFactor: state.profile.twoFactor });
    expect(result.state.accounts[CURRENT_APPLICANT_ID]).toMatchObject({ status: 'Locked', passwordResetRequired: true, kyc: { status: 'Pending' } });
  });
});

describe('the staff directory from the server', () => {
  const entry = (id: string, name: string) => ({
    id, profile: { name, email: `${id}@example.com`, phone: '', address: '', sector: 'Retail', country: 'Kenya', joined: '2026-09-26', tier: 1 as const, identityVerified: false },
    account: { status: 'Active' as const, passwordResetRequired: false, twoFactorResetRequired: false, kyc: { status: 'Not submitted' as const } },
  });

  it('replaces the demo people and hides the demo user from staff views', () => {
    const result = adoptServerApplicants(createSeedState(), [entry('u1', 'Real Person')]);
    if (!result.ok) throw new Error(result.error);
    expect(applicantRecords(result.state).map(a => a.name)).toEqual(['Real Person']);
    expect(result.state.accounts['u1']!.signals).toEqual({ ipCountry: 'Unknown', sharedDeviceWith: [] });
  });

  it('updates one person in place', () => {
    const loaded = adoptServerApplicants(createSeedState(), [entry('u1', 'Real Person'), entry('u2', 'Second Person')]);
    if (!loaded.ok) throw new Error(loaded.error);
    const changed = adoptServerApplicant(loaded.state, { ...entry('u2', 'Second Person'), profile: { ...entry('u2', 'Second Person').profile, tier: 3 } });
    if (!changed.ok) throw new Error(changed.error);
    expect(changed.state.otherApplicants.map(o => [o.id, o.tier])).toEqual([['u1', 1], ['u2', 3]]);
  });

  it('never puts real applicants in browser storage, and goes back to the demo directory after signing out', () => {
    const loaded = adoptServerApplicants(createSeedState(), [entry('u1', 'Real Person')]);
    if (!loaded.ok) throw new Error(loaded.error);
    const stored = forStorage(loaded.state);
    expect(JSON.stringify(stored)).not.toContain('Real Person');
    expect(Object.keys(stored.accounts)).toEqual([CURRENT_APPLICANT_ID]);
    const left = leaveServerApplicants(stored);
    if (!left.ok) throw new Error(left.error);
    expect(left.state.serverApplicants).toBe(false);
    expect(applicantRecords(left.state)).toHaveLength(createSeedState().otherApplicants.length + 1);
  });
});

describe('applications from the server', () => {
  const approved = (id: string, applicantId: string) => ({
    ...createSeedState().applications[0]!, id, applicantId, grantId: 'creative', status: 'Approved' as const, awardedAmount: 3500,
    history: [{ status: 'Approved' as const, at: '2026-09-26T10:00:00.000Z', actor: 'Reviewer' as const, note: 'Approved.' }],
  });

  it("moves an applicant's own applications into the portal slot and credits each award once", () => {
    const first = adoptServerApplications(createSeedState(), [approved('APP-5001', 'me-uuid')], 'me-uuid');
    if (!first.ok) throw new Error(first.error);
    expect(first.state.applications.map(a => a.applicantId)).toEqual([CURRENT_APPLICANT_ID]);
    const credits = first.state.transactions.filter(t => t.description.endsWith('(APP-5001)'));
    expect(credits).toMatchObject([{ type: 'Grant', amount: 3500, status: 'Completed', createdAt: '2026-09-26T10:00:00.000Z' }]);
    const again = adoptServerApplication(first.state, approved('APP-5001', 'me-uuid'), 'me-uuid');
    if (!again.ok) throw new Error(again.error);
    expect(again.state.transactions.filter(t => t.description.endsWith('(APP-5001)'))).toHaveLength(1);
  });

  it("gives staff the queue as is, without crediting anyone's balance", () => {
    const state = createSeedState();
    const result = adoptServerApplications(state, [approved('APP-5001', 'someone')]);
    if (!result.ok) throw new Error(result.error);
    expect(result.state.applications[0]!.applicantId).toBe('someone');
    expect(result.state.transactions).toBe(state.transactions);
  });

  it('never stores server applications in the browser, and restores the demo ones after signing out', () => {
    const loaded = adoptServerApplications(createSeedState(), [approved('APP-5001', 'someone')]);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(forStorage(loaded.state).applications).toEqual([]);
    const left = leaveServerApplications(loaded.state);
    if (!left.ok) throw new Error(left.error);
    expect(left.state.applications).toEqual(createSeedState().applications);
  });
});
