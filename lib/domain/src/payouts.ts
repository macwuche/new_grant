import type { DemoState, Result, Transaction } from './model';
import { fail, roundCents } from './rules';
import { usd } from './core';
import { notify } from './notifications';

// Finance payout processing. Pure, like ./rules and ./review. No payment
// provider is connected: "paid" only records that finance says the transfer
// happened. There is no staff authorization yet.

export const MIN_FAILURE_REASON_LENGTH = 10;

const isWithdrawal = (tx: Transaction) => tx.type === 'Withdrawal';

/** Pending first (oldest first, so nothing waits indefinitely), then processed (newest first). */
export function payoutQueue(state: DemoState): Transaction[] {
  const all = state.transactions.filter(isWithdrawal);
  const pending = all.filter(t => t.status === 'Pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const processed = all.filter(t => t.status !== 'Pending').sort((a, b) => (b.processedAt ?? b.createdAt).localeCompare(a.processedAt ?? a.createdAt));
  return [...pending, ...processed];
}

/** Amount requested (positive), fee, and what the applicant receives. */
export function payoutAmounts(tx: Transaction) {
  const gross = roundCents(Math.abs(tx.amount));
  const fee = roundCents(tx.fee ?? 0);
  return { gross, fee, net: roundCents(gross - fee) };
}

export function pendingPayoutTotal(state: DemoState): number {
  return roundCents(state.transactions.filter(t => isWithdrawal(t) && t.status === 'Pending').reduce((sum, t) => sum + payoutAmounts(t).gross, 0));
}

/** Four-eyes rule: large payouts need a release approval from someone other than whoever marks them paid. */
export const needsSecondSignOff = (state: DemoState, tx: Transaction) => !!tx.dualControl || payoutAmounts(tx).gross >= state.treasury.dualControlThreshold;

const LOCKDOWN_ERROR = 'Payouts are frozen during the system lockdown. A super admin must lift it first.';

/** Only a pending payout can be processed, and only once; repeating the action is rejected. */
function loadPending(state: DemoState, txId: string): { ok: true; tx: Transaction } | { ok: false; result: Result } {
  const tx = state.transactions.find(t => t.id === txId);
  if (!tx || !isWithdrawal(tx)) return { ok: false, result: fail('That payout request could not be found.') };
  if (tx.status !== 'Pending') return { ok: false, result: fail(`${txId} was already marked ${tx.status === 'Completed' ? 'paid' : 'failed'}${tx.processedBy ? ` by ${tx.processedBy}` : ''}.`) };
  return { ok: true, tx };
}

function update(state: DemoState, tx: Transaction): DemoState {
  return { ...state, transactions: state.transactions.map(t => t.id === tx.id ? tx : t) };
}

/** Second sign-off on a large payout. The approver can't also be the one who marks it paid. */
export function approvePayoutRelease(state: DemoState, txId: string, approver: string, now: Date): Result {
  if (state.lockdown) return fail(LOCKDOWN_ERROR);
  const loaded = loadPending(state, txId);
  if (!loaded.ok) return loaded.result;
  if (!needsSecondSignOff(state, loaded.tx)) return fail(`${txId} is below the ${usd(state.treasury.dualControlThreshold)} dual-control threshold, so no second sign-off is needed.`);
  if (loaded.tx.releaseApproval) return fail(`${txId} was already approved for release by ${loaded.tx.releaseApproval.by}.`);
  const tx: Transaction = { ...loaded.tx, releaseApproval: { by: approver, at: now.toISOString() } };
  return { ok: true, id: txId, message: `${txId} approved for release. A different staff member with payment rights can now mark it paid.`, state: update(state, tx) };
}

export function markPayoutPaid(state: DemoState, txId: string, operator: string, now: Date): Result {
  if (state.lockdown) return fail(LOCKDOWN_ERROR);
  const loaded = loadPending(state, txId);
  if (!loaded.ok) return loaded.result;
  if (needsSecondSignOff(state, loaded.tx)) {
    const approval = loaded.tx.releaseApproval;
    if (!approval) return fail(`${txId} is ${usd(payoutAmounts(loaded.tx).gross)}, at or above the dual-control threshold. It needs a release approval from a second staff member (compliance or a super admin) before it can be paid.`);
    if (approval.by === operator) return fail(`You approved the release of ${txId}, so a different staff member must mark it paid.`);
  }
  const tx: Transaction = { ...loaded.tx, status: 'Completed', processedAt: now.toISOString(), processedBy: operator };
  const net = payoutAmounts(tx).net.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const next = notify(update(state, tx), tx.applicantId, 'Payout sent', `${net} was sent to ${tx.destination ?? 'your payout destination'} (${txId}).`, '/withdrawals', now);
  return { ok: true, id: txId, message: `${txId} marked as paid (${net} to the applicant).`, state: next };
}

/** A failed payout stops holding funds, so the amount returns to the balance it came from. */
export function markPayoutFailed(state: DemoState, txId: string, reason: string, operator: string, now: Date): Result {
  const text = reason.trim();
  if (text.length < MIN_FAILURE_REASON_LENGTH) return fail('Explain why the payout failed.', { reason: `Write at least ${MIN_FAILURE_REASON_LENGTH} characters; the applicant sees this reason.` });
  const loaded = loadPending(state, txId);
  if (!loaded.ok) return loaded.result;
  const tx: Transaction = { ...loaded.tx, status: 'Failed', processedAt: now.toISOString(), processedBy: operator, failureReason: text };
  const gross = payoutAmounts(tx).gross.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const balance = tx.source === 'deposit' ? 'deposit balance' : 'grant balance';
  const next = notify(update(state, tx), tx.applicantId, 'Payout failed', `${text} ${gross} is back in your ${balance} (${txId}).`, '/withdrawals', now);
  return { ok: true, id: txId, message: `${txId} marked as failed. ${gross} returned to the applicant's ${balance}.`, state: next };
}
