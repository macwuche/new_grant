import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result } from './model';
import * as P from './payouts';
import * as R from './rules';
import { createSeedState } from './seed';
import * as M from './money';

const now = new Date('2026-09-25T12:00:00Z');
const FINANCE = 'Jordan Lee';

let s: DemoState;
const tx = (id: string) => s.transactions.find(t => t.id === id)!;
const mine = () => R.computeBalances(R.ownTransactions(s));
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  s = result.state;
  return result;
}

beforeEach(() => { s = createSeedState(); });

describe('queue', () => {
  it('lists only withdrawals, pending oldest first then processed', () => {
    const newer = accept(M.requestWithdrawal(s, 200, 'mobile', now)).id!;
    accept(P.markPayoutPaid(s, 'TX-84077', FINANCE, now));
    const later = accept(M.requestWithdrawal(s, 50, 'bank', new Date('2026-09-26T09:00:00Z'))).id!;
    expect(P.payoutQueue(s).map(t => t.id)).toEqual([newer, later, 'TX-84077']);
    expect(P.payoutQueue(s).every(t => t.type === 'Withdrawal')).toBe(true);
  });

  it('totals pending payouts', () => {
    accept(M.requestWithdrawal(s, 200, 'bank', now));
    expect(P.pendingPayoutTotal(s)).toBe(325);
  });

  it('splits gross, fee, and net', () => {
    expect(P.payoutAmounts(tx('TX-84077'))).toEqual({ gross: 125, fee: 1.56, net: 123.44 });
  });
});

describe('mark paid', () => {
  it('completes the payout and keeps the balance deducted', () => {
    accept(P.markPayoutPaid(s, 'TX-84077', FINANCE, now));
    expect(tx('TX-84077')).toMatchObject({ status: 'Completed', processedBy: FINANCE, processedAt: now.toISOString() });
    expect(mine()).toEqual({ grant: 4075, deposit: 441.5, pendingWithdrawals: 0, pendingDeposits: 0 });
  });

  it('cannot be processed twice', () => {
    accept(P.markPayoutPaid(s, 'TX-84077', FINANCE, now));
    const again = P.markPayoutPaid(s, 'TX-84077', FINANCE, now);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/already marked paid/);
    expect(P.markPayoutFailed(s, 'TX-84077', 'Bank rejected the transfer.', FINANCE, now).ok).toBe(false);
  });

  it('only processes withdrawals', () => {
    expect(P.markPayoutPaid(s, 'TX-84019', FINANCE, now).ok).toBe(false);
    expect(P.markPayoutPaid(s, 'TX-missing', FINANCE, now).ok).toBe(false);
  });
});

describe('mark failed', () => {
  it('requires a reason the applicant can read', () => {
    const result = P.markPayoutFailed(s, 'TX-84077', 'no', FINANCE, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.reason).toBeDefined();
  });

  it('returns the held amount to the grant balance', () => {
    accept(P.markPayoutFailed(s, 'TX-84077', '  Account number did not match.  ', FINANCE, now));
    expect(tx('TX-84077')).toMatchObject({ status: 'Failed', failureReason: 'Account number did not match.' });
    expect(mine()).toEqual({ grant: 4200, deposit: 441.5, pendingWithdrawals: 0, pendingDeposits: 0 });
  });

  it('lets the applicant request again with the returned funds', () => {
    accept(P.markPayoutFailed(s, 'TX-84077', 'Account number did not match.', FINANCE, now));
    expect(M.validateWithdrawal(s, 4200, 'bank')).toBeNull();
  });
});
