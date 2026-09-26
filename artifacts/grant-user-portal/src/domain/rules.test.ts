import { beforeEach, describe, expect, it } from 'vitest';
import type { Application, ApplicationInput, DemoState, Result } from './model';
import * as R from './rules';
import { createSeedState, payoutMethods } from './seed';

const now = new Date('2026-09-25T12:00:00Z');
const bank = payoutMethods[0]!;

let s: DemoState;
const grant = (id: string) => s.grants.find(g => g.id === id)!;
const app = (id: string) => s.applications.find(a => a.id === id)!;
const mine = () => R.computeBalances(R.ownTransactions(s));
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  s = result.state;
  return result;
}
const complete = (a: Application): ApplicationInput => ({
  ...a,
  purpose: 'Replace the kiln with an efficient electric model and add rooftop solar.',
  checklist: grant(a.grantId).requirements,
});

beforeEach(() => { s = createSeedState(); });

describe('balances', () => {
  it('derives balances from the ledger, holding pending withdrawals', () => {
    expect(mine()).toEqual({ grant: 4075, deposit: 441.5, pendingWithdrawals: 125 });
  });

  it('ignores failed entries', () => {
    const failed = s.transactions.map(t => t.id === 'TX-84077' ? { ...t, status: 'Failed' as const } : t);
    expect(R.computeBalances(failed).grant).toBe(4200);
  });
});

describe('eligibility', () => {
  it('blocks grants above the applicant tier', () => {
    const result = R.checkEligibility(grant('community'), s.profile, R.ownApplications(s), now);
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toMatch(/Tier 3/);
  });

  it('blocks a second application while one is active', () => {
    expect(R.checkEligibility(grant('momentum'), s.profile, R.ownApplications(s), now).eligible).toBe(false);
  });

  it('points to an existing draft instead of blocking', () => {
    const result = R.checkEligibility(grant('green'), s.profile, R.ownApplications(s), now);
    expect(result.eligible).toBe(true);
    expect(result.existing?.id).toBe('APP-2101');
  });

  it('closes grants after the deadline', () => {
    expect(R.checkEligibility(grant('creative'), s.profile, [], new Date('2027-03-01')).eligible).toBe(false);
  });

  it('reports the largest award currently open', () => {
    expect(R.maxEligibleAward(s.grants, s.profile, R.ownApplications(s), now)).toBe(18000);
  });

  it('hides draft programs and blocks applying to them', () => {
    expect(R.visibleGrants(s).map(g => g.id)).not.toContain('space');
    expect(R.checkEligibility(grant('space'), s.profile, [], now).reasons).toContain('This program has not been published.');
  });

  it('blocks new work on a closed program but allows resubmitting requested changes', () => {
    s = { ...s, grants: s.grants.map(g => g.id === 'momentum' ? { ...g, status: 'Closed' as const } : g) };
    expect(R.checkEligibility(grant('momentum'), s.profile, [], now).reasons).toContain('This program is not accepting new applications.');
    const inFlight = R.ownApplications(s).map(a => a.id === 'APP-2048' ? { ...a, status: 'Changes requested' as const } : a);
    expect(R.checkEligibility(grant('momentum'), s.profile, inFlight, now).eligible).toBe(true);
  });

  it('only counts the signed-in applicant’s applications', () => {
    expect(R.ownApplications(s).map(a => a.id).sort()).toEqual(['APP-1932', 'APP-2048', 'APP-2101']);
  });
});

describe('application validation', () => {
  const base: ApplicationInput = { businessName: 'Morgan Studio', requestedAmount: 5000, registrationNumber: 'CA-1', purpose: 'x'.repeat(40), checklist: [] };

  it('enforces the grant amount range', () => {
    expect(R.validateApplication({ ...base, requestedAmount: 100 }, grant('green'), 1).requestedAmount).toMatch(/minimum/);
    expect(R.validateApplication({ ...base, requestedAmount: 20000 }, grant('green'), 1).requestedAmount).toMatch(/up to/);
    expect(R.validateApplication({ ...base, requestedAmount: 5000.555 }, grant('green'), 1).requestedAmount).toMatch(/decimal/);
  });

  it('requires registration only where the grant does', () => {
    expect(R.validateApplication({ ...base, registrationNumber: '' }, grant('green'), 1).registrationNumber).toBeDefined();
    expect(R.validateApplication({ ...base, registrationNumber: '' }, grant('creative'), 1).registrationNumber).toBeUndefined();
  });

  it('requires every requirement to be confirmed from step 2', () => {
    expect(R.validateApplication(base, grant('green'), 1).checklist).toBeUndefined();
    expect(R.validateApplication(base, grant('green'), 2).checklist).toMatch(/3 remaining/);
  });
});

describe('drafts and submission', () => {
  it('rejects submitting an incomplete draft with field errors', () => {
    const result = R.submitApplication(s, 'green', app('APP-2101'), now, 'APP-2101');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.fieldErrors ?? {})).toEqual(expect.arrayContaining(['purpose', 'checklist']));
  });

  it('submits a complete draft and records history', () => {
    accept(R.submitApplication(s, 'green', complete(app('APP-2101')), now, 'APP-2101'));
    expect(app('APP-2101').status).toBe('Submitted');
    expect(app('APP-2101').history.at(-1)).toMatchObject({ status: 'Submitted', actor: 'Applicant' });
  });

  it('locks a submitted application', () => {
    accept(R.submitApplication(s, 'green', complete(app('APP-2101')), now, 'APP-2101'));
    expect(R.saveDraft(s, 'green', complete(app('APP-2101')), now, 'APP-2101').ok).toBe(false);
    expect(R.deleteDraft(s, 'APP-2101').ok).toBe(false);
    expect(R.saveDraft(s, 'green', complete(app('APP-2101')), now).ok).toBe(false);
  });

  it('saving a new draft for a grant with an existing draft updates that draft', () => {
    const result = accept(R.saveDraft(s, 'green', { ...app('APP-2101'), businessName: 'Renamed' }, now));
    expect(result.id).toBe('APP-2101');
    expect(app('APP-2101').businessName).toBe('Renamed');
  });

  it('creates new drafts with unique ids owned by the applicant', () => {
    accept(R.deleteDraft(s, 'APP-2101'));
    const result = accept(R.saveDraft(s, 'green', complete(createSeedState().applications.find(a => a.id === 'APP-2101')!), now));
    expect(result.id).not.toBe('APP-2101');
    expect(R.ownApplications(s).some(a => a.id === result.id)).toBe(true);
  });

  it('refuses drafts the applicant is not eligible for', () => {
    expect(R.saveDraft(s, 'community', complete(app('APP-2101')), now).ok).toBe(false);
  });
});

describe('withdrawals', () => {
  it('computes a capped fee', () => {
    expect(R.withdrawalFee(100)).toBe(1.25);
    expect(R.withdrawalFee(5000)).toBe(14);
    expect(R.withdrawalFee(0)).toBe(0);
  });

  it('validates the amount', () => {
    expect(R.validateWithdrawal(5, 4075)).toMatch(/minimum/);
    expect(R.validateWithdrawal(5000, 4075)).toMatch(/up to/);
    expect(R.validateWithdrawal(10.005, 4075)).toMatch(/decimal/);
    expect(R.validateWithdrawal(100, 4075)).toBeNull();
  });

  it('records a pending withdrawal with fee and destination, holding the amount', () => {
    const result = accept(R.requestWithdrawal(s, 1000, bank, now));
    const tx = s.transactions.find(t => t.id === result.id)!;
    expect(tx).toMatchObject({ status: 'Pending', amount: -1000, fee: 12.5, destination: `${bank.type} · ${bank.label}` });
    expect(mine().grant).toBe(3075);
    expect(R.requestWithdrawal(s, 3075.01, bank, now).ok).toBe(false);
  });
});

describe('cards and profile', () => {
  it('charges the physical card fee once', () => {
    accept(R.requestPhysicalCard(s, now));
    expect(mine().deposit).toBe(433);
    expect(R.requestPhysicalCard(s, now).ok).toBe(false);
  });

  it('validates profile edits', () => {
    const result = R.updateProfile(s, { name: 'A', email: 'bad', phone: '12', address: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.fieldErrors ?? {}).sort()).toEqual(['address', 'email', 'name', 'phone']);
  });
});
