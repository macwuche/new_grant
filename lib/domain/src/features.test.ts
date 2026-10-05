import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result } from './model';
import * as G from './programs';
import * as M from './money';
import * as R from './rules';
import { createSeedState } from './seed';
import { migrateState } from './migrate';
import * as V from './review';
import { CURRENT_APPLICANT_ID } from './seed';

const now = new Date('2026-09-25T12:00:00Z');
let s: DemoState;
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error} ${JSON.stringify(result.fieldErrors ?? {})}`);
  s = result.state;
  return result;
}
const grant = (id: string) => R.findGrant(s, id)!;
const app = (id: string) => s.applications.find(a => a.id === id)!;

beforeEach(() => { s = createSeedState(); });

describe('program questions', () => {
  it('validates required, number, and yes/no answers on step 2', () => {
    const input = { businessName: 'Morgan Studio', requestedAmount: 5000, registrationNumber: 'CA-1', purpose: 'x'.repeat(40), checklist: grant('momentum').requirements, answers: { employees: 'three', trading: 'Maybe' } };
    expect(R.validateApplication(input, grant('momentum'), 1)).toEqual({});
    expect(R.validateApplication(input, grant('momentum'), 2)).toEqual({ 'answers.employees': 'Enter a number (digits only).', 'answers.trading': 'Choose yes or no.' });
    expect(R.validateApplication({ ...input, answers: {} }, grant('momentum'), 2)['answers.employees']).toBe('Answer this question.');
    expect(R.validateApplication({ ...input, answers: { employees: '3', trading: 'Yes' } }, grant('momentum'), 2)).toEqual({});
    expect(R.validateApplication({ ...input, checklist: grant('green').requirements, answers: {} }, grant('green'), 2)).toEqual({}); // optional
  });

  it('saves only answers to the program’s own questions', () => {
    accept(R.saveDraft(s, 'green', { ...app('APP-2101'), answers: { savings: ' 1200 ', stray: 'x' } }, now, 'APP-2101'));
    expect(app('APP-2101').answers).toEqual({ savings: '1200' });
  });

  it('lets staff add questions with generated ids, and locks them after submissions', () => {
    const creative = grant('creative');
    const { updatedAt: _u, changeLog: _c, status: _s, id: _i, ...input } = creative;
    const questions = [{ id: '', label: 'Link to your portfolio', type: 'text' as const, required: true }];
    expect(G.updateProgram(s, 'creative', creative.updatedAt, { ...input, questions }, 'Sam Rivera', now).ok).toBe(false); // creative has submissions
    const space = grant('space');
    const { updatedAt: _u2, changeLog: _c2, status: _s2, id: _i2, ...draftInput } = space;
    expect(G.validateProgram(s, { ...draftInput, questions: [...questions, { id: '', label: 'link to your portfolio', type: 'number', required: false }] }, now, space).questions).toMatch(/different label/);
    accept(G.updateProgram(s, 'space', space.updatedAt, { ...draftInput, questions: [...questions, { id: '', label: '', type: 'text', required: false }] }, 'Sam Rivera', now));
    expect(grant('space').questions).toEqual([{ id: 'link-to-your-portfolio', label: 'Link to your portfolio', type: 'text', required: true }]);
    expect(G.validateProgram(s, { ...draftInput, questions: Array.from({ length: 16 }, (_, i) => ({ id: `q${i}`, label: `Question ${i}`, type: 'text' as const, required: false })) }, now, space).questions).toMatch(/at most 15/);
  });
});

describe('commission', () => {
  const complete = () => ({ ...app('APP-2101'), purpose: 'Replace the kiln with an efficient electric model.', checklist: grant('green').requirements });
  const deposit = () => R.computeBalances(R.ownTransactions(s)).deposit;
  const submitAndReview = () => {
    accept(R.submitApplication(s, 'green', complete(), now, 'APP-2101'));
    accept(V.startReview(s, 'APP-2101', app('APP-2101').updatedAt, 'Avery Taylor', now));
  };

  it('charges nothing at submission and fixes no rate until approval', () => {
    const before = s.transactions.length;
    const result = accept(R.submitApplication(s, 'green', complete(), now, 'APP-2101'));
    expect(result.message).not.toMatch(/fee|commission/);
    expect(s.transactions).toHaveLength(before);
    expect(app('APP-2101').commissionRate).toBeNull();
    expect(s.notifications[0]!.body).toMatch(/plan's commission on the amount approved \(currently 8%\) is taken from your deposit balance/);
  });

  it('takes the commission on the approved amount from the deposit balance on approval, even below zero', () => {
    s = { ...s, transactions: s.transactions.filter(t => t.applicantId !== CURRENT_APPLICANT_ID || t.type !== 'Deposit') };
    submitAndReview();
    const before = deposit();
    const result = accept(V.approveApplication(s, 'APP-2101', app('APP-2101').updatedAt, 2500, 'Avery Taylor', now));
    expect(result.message).toMatch(/\$200\.00 commission taken/);
    expect(s.transactions.slice(0, 2)).toMatchObject([
      { type: 'Commission', amount: -200, status: 'Completed', applicantId: CURRENT_APPLICANT_ID },
      { type: 'Grant', amount: 2500 },
    ]);
    expect(s.transactions[0]!.id).not.toBe(s.transactions[1]!.id);
    expect(deposit()).toBe(before - 200);
    expect(deposit()).toBeLessThan(0);
    expect(s.notifications[0]!.body).toMatch(/8% commission \(\$200\.00\) has been taken from your deposit balance/);
  });

  it('uses the plan’s rate at approval, not at submission, and records it on the application', () => {
    submitAndReview();
    s = { ...s, grants: s.grants.map(g => g.id === 'green' ? { ...g, commissionRate: 50 } : g) };
    expect(V.commissionOn(s, app('APP-2101'), 1000)).toEqual({ rate: 50, amount: 500 });
    accept(V.approveApplication(s, 'APP-2101', app('APP-2101').updatedAt, 1000, 'Avery Taylor', now));
    expect(s.transactions[0]).toMatchObject({ type: 'Commission', amount: -500 });
    expect(app('APP-2101').commissionRate).toBe(50);
    // A later change to the plan doesn't rewrite what an approved application was charged.
    s = { ...s, grants: s.grants.map(g => g.id === 'green' ? { ...g, commissionRate: 5 } : g) };
    expect(V.commissionOn(s, app('APP-2101'), 1000)).toEqual({ rate: 50, amount: 500 });
  });

  it('ignores a rate stored at submission by older versions', () => {
    submitAndReview();
    s = { ...s, applications: s.applications.map(a => a.id === 'APP-2101' ? { ...a, commissionRate: 0 } : a) };
    accept(V.approveApplication(s, 'APP-2101', app('APP-2101').updatedAt, 1000, 'Avery Taylor', now));
    expect(s.transactions[0]).toMatchObject({ type: 'Commission', amount: -80 });
    expect(app('APP-2101').commissionRate).toBe(8);
  });

  it('uses the rate at approval after a resubmission', () => {
    submitAndReview();
    accept(V.requestChanges(s, 'APP-2101', app('APP-2101').updatedAt, 'Please add the installer quote.', 'Avery Taylor', now));
    s = { ...s, grants: s.grants.map(g => g.id === 'green' ? { ...g, commissionRate: 20 } : g) };
    accept(R.submitApplication(s, 'green', complete(), now, 'APP-2101'));
    expect(app('APP-2101').commissionRate).toBeNull();
    accept(V.startReview(s, 'APP-2101', app('APP-2101').updatedAt, 'Avery Taylor', now));
    accept(V.approveApplication(s, 'APP-2101', app('APP-2101').updatedAt, 1000, 'Avery Taylor', now));
    expect(s.transactions[0]).toMatchObject({ type: 'Commission', amount: -200 });
  });

  it('adds no ledger entry when the plan takes no commission', () => {
    s = { ...s, grants: s.grants.map(g => g.id === 'green' ? { ...g, commissionRate: 0 } : g) };
    submitAndReview();
    accept(V.approveApplication(s, 'APP-2101', app('APP-2101').updatedAt, 1000, 'Avery Taylor', now));
    expect(s.transactions[0]).toMatchObject({ type: 'Grant' });
    expect(s.transactions.some(t => t.type === 'Commission')).toBe(false);
  });
});

describe('remembered payout details', () => {
  it('keeps the answers with the request, remembers them for next time, and tells staff when they change', () => {
    s = { ...s, treasury: { ...s.treasury, channels: s.treasury.channels.map(c => ({ ...c, enabled: true })) } };
    const refused = M.requestWithdrawal(s, { amount: 100, method: 'crypto', details: {} }, now);
    expect(refused.ok === false && refused.fieldErrors).toEqual({ 'details.wallet': 'USDT (TRC-20) wallet address is required.' });
    const wallet = 'TXr9ab3kLmN2pQ4sT6vW8yZ1cD5fG7h9jK';
    const id = accept(M.requestWithdrawal(s, { amount: 100, method: 'crypto', details: { wallet } }, now)).id!;
    const tx = s.transactions.find(t => t.id === id)!;
    expect(tx.payoutDetails).toEqual([{ fieldId: 'wallet', label: 'USDT (TRC-20) wallet address', value: wallet }]);
    expect(tx.destination).toBe(`USDT wallet · ${wallet.slice(0, 14)}…${wallet.slice(-8)}`);
    expect(s.savedPayoutDetails['crypto']).toEqual({ wallet });
    expect(s.staffFeed.find(e => e.kind === 'account')).toMatchObject({ title: 'Payout details added' });
    const feed = s.staffFeed.length;
    accept(M.requestWithdrawal(s, { amount: 60, method: 'crypto', details: { wallet } }, now)); // same answers: no new account alert
    expect(s.staffFeed.filter(e => e.kind === 'account')).toHaveLength(1);
    expect(s.staffFeed.length).toBe(feed + 1);
  });
});

describe('card limits', () => {
  it('keeps limits within the tier maximum', () => {
    expect(M.setCardLimit(s, 'virtual', 2600).ok).toBe(false);
    expect(M.setCardLimit(s, 'virtual', 20).ok).toBe(false);
    expect(M.setCardLimit(s, 'virtual', 99.5).ok).toBe(false);
    expect(M.setCardLimit(s, 'physical', 500).ok).toBe(false); // not requested yet
    accept(M.setCardLimit(s, 'virtual', 2500));
    expect(s.cards.virtual!.dailyLimit).toBe(2500);
  });
});

describe('saved-data migration v4 → v6', () => {
  it('adds the new records without changing existing programs or applications', () => {
    const seed = createSeedState();
    const { savedPayoutDetails: _p, accounts: _a, staff: _s, actingStaffId: _x, audit: _au, lockdown: _l, ...rest } = seed;
    const v4 = JSON.parse(JSON.stringify({
      ...rest, version: 4,
      grants: rest.grants.map(({ questions: _q, ...g }) => g),
      applications: rest.applications.map(({ answers: _an, escalation: _e, ...a }) => a),
      profile: { ...rest.profile, identityVerified: false },
    }));
    const migrated = migrateState(v4)!;
    expect(migrated.version).toBe(6);
    expect(migrated.treasury.channels.every(c => c.processingTime && c.source === 'grant' && Array.isArray(c.fields))).toBe(true);
    expect(migrated.grants.every(g => g.questions.length === 0)).toBe(true);
    expect(migrated.applications.every(a => a.escalation === null && typeof a.answers === 'object')).toBe(true);
    expect(migrated.accounts['APL-1001']!.kyc.status).toBe('Not submitted');
    expect(migrated.treasury.dualControlThreshold).toBe(2500);
    expect(migrated.lockdown).toBeNull();
    expect(migrated.cards.virtual!.pin).toBeDefined();
  });
});

describe('saved data from before commissions', () => {
  it('gives programs 7 approval days and no commission, applications no rate, and drops the application fee', () => {
    const fresh = createSeedState();
    const old = JSON.parse(JSON.stringify({
      ...fresh,
      grants: fresh.grants.map(({ approvalDays: _d, commissionRate: _c, ...g }) => g),
      applications: fresh.applications.map(({ commissionRate: _r, ...a }) => a),
      treasury: { ...fresh.treasury, applicationFee: 15 },
    }));
    const migrated = migrateState(old)!;
    expect(migrated.grants.every(g => g.approvalDays === 7 && g.commissionRate === 0)).toBe(true);
    expect(migrated.applications.every(a => a.commissionRate === null)).toBe(true);
    expect('applicationFee' in migrated.treasury).toBe(false);
  });
});
