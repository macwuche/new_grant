import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result } from './model';
import * as G from './programs';
import * as M from './money';
import * as R from './rules';
import { createSeedState } from './seed';
import { migrateState } from './store';

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
    expect(G.validateProgram(s, { ...draftInput, questions: [...questions, { id: '', label: 'link to your portfolio', type: 'number', required: false }] }, now, space).questions).toMatch(/must be different/);
    accept(G.updateProgram(s, 'space', space.updatedAt, { ...draftInput, questions: [...questions, { id: '', label: '', type: 'text', required: false }] }, 'Sam Rivera', now));
    expect(grant('space').questions).toEqual([{ id: 'link-to-your-portfolio', label: 'Link to your portfolio', type: 'text', required: true }]);
    expect(G.validateProgram(s, { ...draftInput, questions: Array.from({ length: 7 }, (_, i) => ({ id: `q${i}`, label: `Question ${i}`, type: 'text' as const, required: false })) }, now, space).questions).toMatch(/at most 6/);
  });
});

describe('application fee', () => {
  const complete = () => ({ ...app('APP-2101'), purpose: 'Replace the kiln with an efficient electric model.', checklist: grant('green').requirements });

  it('charges the deposit balance once, on first submission', () => {
    s = { ...s, treasury: { ...s.treasury, applicationFee: 15 } };
    const before = R.computeBalances(R.ownTransactions(s)).deposit;
    const result = accept(R.submitApplication(s, 'green', complete(), now, 'APP-2101'));
    expect(result.message).toMatch(/\$15\.00 application fee/);
    expect(R.computeBalances(R.ownTransactions(s)).deposit).toBe(before - 15);
    expect(s.transactions[0]).toMatchObject({ type: 'Application fee', amount: -15 });
  });

  it('blocks submission when the deposit balance cannot cover it', () => {
    s = { ...s, treasury: { ...s.treasury, applicationFee: 99 }, transactions: s.transactions.filter(t => t.type !== 'Deposit') };
    const result = R.submitApplication(s, 'green', complete(), now, 'APP-2101');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/application fee/);
  });
});

describe('payout destinations', () => {
  it('validates each channel and stores only a masked label', () => {
    expect(M.destinationLabel('bank', { primary: 'Meridian', secondary: '12345678901' })).toEqual({ label: 'Meridian · •••• 8901' });
    expect(M.destinationLabel('bank', { primary: '', secondary: '12' })).toEqual({ errors: { primary: 'Enter the bank name.', secondary: 'Enter 6–17 digits.' } });
    expect(M.destinationLabel('wire', { primary: 'mrdnus33', secondary: 'GB29NWBK60161331926819' })).toEqual({ label: 'SWIFT MRDNUS33 · •••• 6819' });
    expect('errors' in M.destinationLabel('wire', { primary: 'BAD', secondary: '123456' })).toBe(true);
    expect(M.destinationLabel('mobile', { primary: '+44 7700 900123' })).toEqual({ label: '+44 7700 900123' });
    expect('errors' in M.destinationLabel('mobile', { primary: 'call me' })).toBe(true);
    expect(M.destinationLabel('crypto', { primary: 'TXr9ab3kLmN2pQ4sT6vW8yZ1cD5fG7h9jK' })).toEqual({ label: 'USDT (TRC-20) · TXr9…h9jK' });
    expect('errors' in M.destinationLabel('crypto', { primary: '0xabc' })).toBe(true);
  });

  it('requires a destination before requesting a payout on that channel', () => {
    s = { ...s, treasury: { ...s.treasury, channels: s.treasury.channels.map(c => ({ ...c, enabled: true })) } };
    expect(M.validateWithdrawal(s, 100, 'crypto')).toMatch(/Payout destinations/);
    accept(M.savePayoutDestination(s, 'crypto', { primary: 'TXr9ab3kLmN2pQ4sT6vW8yZ1cD5fG7h9jK' }, now));
    expect(s.staffFeed[0]).toMatchObject({ kind: 'account', title: 'Payout destination added' });
    const id = accept(M.requestWithdrawal(s, 100, 'crypto', now)).id!;
    expect(s.transactions.find(t => t.id === id)!.destination).toBe('USDT wallet · USDT (TRC-20) · TXr9…h9jK');
    accept(M.removePayoutDestination(s, 'crypto'));
    expect(s.transactions.find(t => t.id === id)!.destination).toContain('TXr9…h9jK');
    expect(M.savePayoutDestination(s, 'bank', { primary: 'Meridian checking', secondary: '0000000842' }, now).ok).toBe(false); // unchanged
  });
});

describe('card limits', () => {
  it('keeps limits within the tier maximum', () => {
    expect(M.setCardLimit(s, 'virtual', 2600).ok).toBe(false);
    expect(M.setCardLimit(s, 'virtual', 20).ok).toBe(false);
    expect(M.setCardLimit(s, 'virtual', 99.5).ok).toBe(false);
    expect(M.setCardLimit(s, 'physical', 500).ok).toBe(false); // not requested yet
    accept(M.setCardLimit(s, 'virtual', 2500));
    expect(s.cards.virtual.dailyLimit).toBe(2500);
  });
});

describe('saved-data migration v4 → v5', () => {
  it('adds the new records without changing existing programs or applications', () => {
    const seed = createSeedState();
    const { payoutDestinations: _p, accounts: _a, staff: _s, actingStaffId: _x, audit: _au, lockdown: _l, ...rest } = seed;
    const v4 = JSON.parse(JSON.stringify({
      ...rest, version: 4,
      grants: rest.grants.map(({ questions: _q, ...g }) => g),
      applications: rest.applications.map(({ answers: _an, escalation: _e, ...a }) => a),
      profile: { ...rest.profile, identityVerified: false },
    }));
    const migrated = migrateState(v4)!;
    expect(migrated.version).toBe(5);
    expect(migrated.grants.every(g => g.questions.length === 0)).toBe(true);
    expect(migrated.applications.every(a => a.escalation === null && typeof a.answers === 'object')).toBe(true);
    expect(migrated.accounts['APL-1001']!.kyc.status).toBe('Not submitted');
    expect(migrated.treasury.dualControlThreshold).toBe(2500);
    expect(migrated.lockdown).toBeNull();
    expect(migrated.cards.virtual.pin).toBeDefined();
  });
});
