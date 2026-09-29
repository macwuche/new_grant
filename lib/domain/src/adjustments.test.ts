import { beforeEach, describe, expect, it } from 'vitest';
import type { Application, DemoState, Result } from './model';
import * as A from './adjustments';
import { setAccountPermission } from './accounts';
import { permissionsOf } from './applicants';
import { snapshot } from './audit';
import * as C from './cards';
import * as D from './deposits';
import * as M from './money';
import * as R from './rules';
import { createSeedState, CURRENT_APPLICANT_ID } from './seed';

const now = new Date('2026-09-29T12:00:00Z');
const address = { name: 'Alex Morgan', line1: '1 Main St', city: 'Austin', postalCode: '73301', country: 'United States' };

let s: DemoState;
const balances = () => R.computeBalances(R.ownTransactions(s));
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  s = result.state;
  return result;
}
function refuse(result: Result, pattern: RegExp) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatch(pattern);
}
const adjust = (input: Partial<A.AdjustmentInput>) => A.staffAdjustBalance(s, { target: 'grant', direction: 'credit', amount: 100, category: 'Correction', reason: 'Award was entered short', ...input }, 'Fin Ops', now);
const turn = (key: Parameters<typeof setAccountPermission>[2], value: boolean) => accept(setAccountPermission(s, CURRENT_APPLICANT_ID, key, value, now));
const unverified = () => { s = { ...s, profile: { ...s.profile, identityVerified: false } }; };

beforeEach(() => { s = createSeedState(); });

describe('balance adjustments', () => {
  it('credits and debits the grant and deposit balances through the ledger', () => {
    const start = balances();
    const { id } = accept(adjust({ amount: 250 }));
    expect(balances().grant).toBe(start.grant + 250);
    expect(s.transactions.find(t => t.id === id)).toMatchObject({ type: 'Grant adjustment', amount: 250, category: 'Correction', note: 'Award was entered short', processedBy: 'Fin Ops' });
    accept(adjust({ target: 'deposit', direction: 'debit', amount: 40, category: 'Deposit manual override' }));
    expect(balances().deposit).toBe(start.deposit - 40);
    expect(s.notifications[0]).toMatchObject({ title: 'Balance adjusted by the grant team', applicantId: CURRENT_APPLICANT_ID });
    expect(s.notifications[0]!.body).toMatch(/taken from your deposit balance: Award was entered short/);
  });

  it('refuses debits beyond the balance and bad input, with field errors', () => {
    const { deposit } = balances();
    refuse(adjust({ target: 'deposit', direction: 'debit', amount: deposit + 1 }), /deposit balance holds/);
    const bad = adjust({ amount: 0, reason: 'short', category: 'Nope' as never });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.fieldErrors ?? {}).sort()).toEqual(['amount', 'category', 'reason']);
    refuse(adjust({ amount: 10.005 }), /highlighted/);
  });

  it('adjusts the card balance as a tagged staff card move', () => {
    const start = balances();
    const { id } = accept(adjust({ target: 'card', amount: 30, category: 'Card fee refund' }));
    expect(balances()).toMatchObject({ card: start.card + 30, grant: start.grant, deposit: start.deposit });
    expect(s.transactions.find(t => t.id === id)).toMatchObject({ type: 'Card top-up', counterpart: 'none', category: 'Card fee refund', note: 'Card fee refund: Award was entered short' });
    refuse(adjust({ target: 'card', direction: 'debit', amount: start.card + 31 }), /card balance holds/);
  });

  it('shows the balance change in the applicant audit snapshot', () => {
    const before = snapshot(s, CURRENT_APPLICANT_ID);
    accept(adjust({ amount: 5 }));
    const after = snapshot(s, CURRENT_APPLICANT_ID);
    expect(Number(after['balances.grant'])).toBe(Number(before['balances.grant']) + 5);
  });
});

describe('permission switches', () => {
  it('defaults everything open and refuses a no-op change', () => {
    expect(permissionsOf(s)).toEqual({ payoutKyc: false, depositKyc: false, emailNotifications: true, cardApplications: true, grantApplications: true });
    refuse(setAccountPermission(s, CURRENT_APPLICANT_ID, 'cardApplications', true, now), /already on/);
    refuse(setAccountPermission(s, 'APL-nobody', 'cardApplications', false, now), /could not be found/);
  });

  it('requires a verified identity for payouts and deposits when switched on', () => {
    unverified();
    expect(M.payoutBlocker(s)).toBeNull();
    turn('payoutKyc', true);
    expect(s.notifications[0]!.body).toMatch(/Payouts now need a verified identity/);
    refuse(M.requestWithdrawal(s, 20, 'bank', now), /Verify your identity .* payout/);
    accept(D.requestDeposit(s, 50, 'bank', now));
    turn('depositKyc', true);
    refuse(D.requestDeposit(s, 50, 'bank', now), /Verify your identity .* adding funds/);
    s = { ...s, profile: { ...s.profile, identityVerified: true } };
    accept(D.requestDeposit(s, 50, 'bank', now));
  });

  it('blocks card applications but not staff issuing', () => {
    s = { ...s, cards: { ...s.cards, virtual: null } };
    turn('cardApplications', false);
    refuse(C.createVirtualCard(s, '1234', '0000', now), /Card applications are turned off/);
    accept(C.staffCreateVirtualCard(s, '1234', '0000', 'Fin Ops', now));
    refuse(C.requestPhysicalCard(s, address, now), /Card applications are turned off/);
  });

  it('blocks new grant applications but allows resubmitting requested changes', () => {
    const draft = s.applications.find(a => a.id === 'APP-2101')!;
    const complete = (a: Application) => ({ ...a, purpose: 'Replace the kiln with an efficient electric model and add rooftop solar.', checklist: s.grants.find(g => g.id === a.grantId)!.requirements });
    turn('grantApplications', false);
    refuse(R.submitApplication(s, draft.grantId, complete(draft), now, draft.id), /New grant applications are turned off/);
    s = { ...s, applications: s.applications.map(a => a.id === draft.id ? { ...a, status: 'Changes requested' as const } : a) };
    accept(R.submitApplication(s, draft.grantId, complete(draft), now, draft.id));
  });
});
