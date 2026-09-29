import { describe, expect, it } from 'vitest';
import { createSeedState } from './seed';
import { applicantRecords } from './applicants';
import { CURRENT_APPLICANT_ID } from './seed';
import { adoptServerMoney, adoptServerLedger, leaveServerMoney, adoptServerActivity, leaveServerActivity, adoptServerApplication, adoptServerApplications, leaveServerApplications, adoptServerApplicant, adoptServerApplicants, adoptServerProfile, adoptServerProgram, adoptServerPrograms, dropServerProgram, forStorage, leaveServerApplicants } from './sync';

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

  it("moves an applicant's own applications into the portal slot, leaving award credits to the server", () => {
    const state = createSeedState();
    const first = adoptServerApplications(state, [approved('APP-5001', 'me-uuid')], 'me-uuid');
    if (!first.ok) throw new Error(first.error);
    expect(first.state.applications.map(a => a.applicantId)).toEqual([CURRENT_APPLICANT_ID]);
    expect(first.state.transactions).toBe(state.transactions);
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

describe('activity from the server', () => {
  const note = { id: 'NT-7', at: '2026-09-26T10:00:00.000Z', title: 'Creative Practice was approved', body: 'Approved.', href: '/applications/APP-5001', read: false };
  const entry = { id: 'AU-2', at: '2026-09-26T10:00:00.000Z', staffId: 'uuid', staffName: 'Riley Chen', role: 'compliance' as const, action: 'Lock account', target: 'u1', applicantId: 'u1', summary: 'Locked.', changes: [], riskScore: null, ip: '203.0.113.9' };

  it("gives the applicant their notifications in the portal slot, so the bell shows them", () => {
    const result = adoptServerActivity(createSeedState(), { notifications: [note] });
    if (!result.ok) throw new Error(result.error);
    expect(result.state.notifications).toEqual([{ ...note, applicantId: CURRENT_APPLICANT_ID }]);
  });

  it('keeps the audit log oldest first, like the browser log', () => {
    const result = adoptServerActivity(createSeedState(), { audit: [{ ...entry, id: 'AU-3' }, entry] });
    if (!result.ok) throw new Error(result.error);
    expect(result.state.audit.map(e => e.id)).toEqual(['AU-2', 'AU-3']);
  });

  it('never stores server activity in the browser, and restores the demo activity after signing out', () => {
    const loaded = adoptServerActivity(createSeedState(), { notifications: [note], audit: [entry] });
    if (!loaded.ok) throw new Error(loaded.error);
    const stored = forStorage(loaded.state);
    expect([stored.notifications, stored.staffFeed, stored.audit]).toEqual([[], [], []]);
    const left = leaveServerActivity(stored);
    if (!left.ok) throw new Error(left.error);
    expect(left.state.notifications).toEqual(createSeedState().notifications);
  });
});

describe('money from the server', () => {
  const seed = createSeedState();
  const credit = { id: 'TX-180000', applicantId: 'me-uuid', type: 'Grant' as const, description: 'Award (APP-5001)', amount: 3000, status: 'Completed' as const, createdAt: '2026-09-26T10:00:00.000Z' };
  const money = { transactions: [credit], cards: seed.cards, savedPayoutDetails: { bank: { 'account-number': '12346789' } }, destinationChangedAt: '2026-09-25T10:00:00.000Z', treasury: seed.treasury, lockdown: null };

  it("gives the applicant their own ledger and remembered payout details in the portal slot", () => {
    const result = adoptServerMoney(seed, money, 'me-uuid');
    if (!result.ok) throw new Error(result.error);
    expect(result.state.transactions).toEqual([{ ...credit, applicantId: CURRENT_APPLICANT_ID }]);
    expect(result.state.savedPayoutDetails).toEqual({ bank: { 'account-number': '12346789' } });
    expect(result.state.accounts[CURRENT_APPLICANT_ID]!.destinationChangedAt).toBe('2026-09-25T10:00:00.000Z');
  });

  it('gives staff the whole ledger as is', () => {
    const result = adoptServerLedger(seed, [credit], { treasury: seed.treasury, lockdown: { since: 'x', by: 'Sam', reason: 'Checking.' } });
    if (!result.ok) throw new Error(result.error);
    expect(result.state.transactions).toEqual([credit]);
    expect(result.state.lockdown?.by).toBe('Sam');
  });

  it('never stores the ledger or payout details in the browser, and restores the demo money after signing out', () => {
    const loaded = adoptServerMoney(seed, money, 'me-uuid');
    if (!loaded.ok) throw new Error(loaded.error);
    const stored = forStorage(loaded.state);
    expect([stored.transactions, stored.savedPayoutDetails]).toEqual([[], {}]);
    const left = leaveServerMoney(stored);
    if (!left.ok) throw new Error(left.error);
    expect(left.state.transactions).toEqual(seed.transactions);
  });
});
