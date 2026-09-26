import type { DemoState, DepositMethodId, Result, Transaction } from './model';
import { fail, nextIds, roundCents, usd } from './core';
import { alertIfHighRisk, logStaff } from './activity';
import { accountLockReason } from './applicants';
import { notify } from './notifications';
import { ownTransactions } from './rules';
import { CURRENT_APPLICANT_ID } from './seed';

// Deposits: the applicant announces a transfer and quotes a reference; finance
// confirms it arrived (crediting the deposit balance) or rejects it. No bank or
// mobile-money provider is connected, so nothing is detected automatically.

export const MIN_REJECTION_REASON_LENGTH = 10;
/** Velocity guard: how many unconfirmed deposits one applicant may have open. */
export const MAX_PENDING_DEPOSITS = 3;

export type DepositMethod = { id: DepositMethodId; name: string; payTo: string; timing: string };

/** Fictional receiving details for the demo. */
export const DEPOSIT_METHODS: DepositMethod[] = [
  { id: 'bank', name: 'Bank transfer', payTo: 'arc.fund Demo Trust · Account 00012345 · Routing 000000000', timing: 'Usually 1–2 business days' },
  { id: 'mobile', name: 'Mobile money', payTo: 'arc.fund Demo · +1 (415) 555-0100', timing: 'Usually within an hour' },
];

const isDeposit = (tx: Transaction) => tx.type === 'Deposit';

export function validateDeposit(state: DemoState, amount: number): string | null {
  const locked = accountLockReason(state);
  if (locked) return locked;
  const { minDeposit, maxDeposit } = state.treasury;
  if (!Number.isFinite(amount) || amount <= 0) return 'Enter an amount to deposit.';
  if (roundCents(amount) !== amount) return 'Use at most two decimal places.';
  if (amount < minDeposit) return `The minimum deposit is ${usd(minDeposit)}.`;
  if (amount > maxDeposit) return `The maximum deposit is ${usd(maxDeposit)} per request.`;
  const open = ownTransactions(state).filter(t => isDeposit(t) && t.status === 'Pending').length;
  if (open >= MAX_PENDING_DEPOSITS) return `You already have ${open} deposits waiting to be confirmed. Cancel one or wait for finance to confirm them.`;
  return null;
}

export function requestDeposit(state: DemoState, amount: number, methodId: DepositMethodId, now: Date): Result {
  const method = DEPOSIT_METHODS.find(m => m.id === methodId);
  if (!method) return fail('Choose a deposit method.');
  const error = validateDeposit(state, amount);
  if (error) return fail(error, { amount: error });
  const ids = nextIds(state);
  const tx: Transaction = { id: ids.tx, applicantId: CURRENT_APPLICANT_ID, type: 'Deposit', description: `Deposit via ${method.name}`, amount, status: 'Pending', createdAt: now.toISOString(), method: method.id, reference: ids.reference };
  const highValue = amount >= state.treasury.highValueDeposit;
  const next = logStaff({ ...state, nextId: ids.nextId, transactions: [tx, ...state.transactions] }, {
    kind: 'deposit', highlight: highValue,
    title: `${highValue ? 'High-value deposit' : 'Deposit'} announced: ${usd(amount)}`,
    body: `${state.profile.name} · ${method.name} · reference ${tx.reference}`, href: '/admin/deposits',
  }, now);
  return { ok: true, id: tx.id, message: `Deposit ${tx.reference} recorded. Send ${usd(amount)} with that reference; it's added once finance confirms it arrived.`, state: alertIfHighRisk(state, next, CURRENT_APPLICANT_ID, now) };
}

export function cancelDeposit(state: DemoState, txId: string, now: Date): Result {
  const tx = ownTransactions(state).find(t => t.id === txId && isDeposit(t));
  if (!tx) return fail('That deposit could not be found.');
  if (tx.status !== 'Pending') return fail('Only deposits waiting for confirmation can be cancelled.');
  const cancelled: Transaction = { ...tx, status: 'Cancelled', processedAt: now.toISOString(), processedBy: 'Applicant' };
  const next = logStaff({ ...state, transactions: state.transactions.map(t => t.id === txId ? cancelled : t) }, {
    kind: 'deposit', title: `Deposit ${tx.reference ?? txId} cancelled`, body: `${state.profile.name} cancelled ${usd(tx.amount)}. Don't credit it if it arrives.`, href: '/admin/deposits',
  }, now);
  return { ok: true, id: txId, message: `Deposit ${tx.reference ?? txId} cancelled.`, state: next };
}

/** Pending first (oldest first), then processed (newest first). */
export function depositQueue(state: DemoState): Transaction[] {
  const all = state.transactions.filter(isDeposit);
  const pending = all.filter(t => t.status === 'Pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const done = all.filter(t => t.status !== 'Pending').sort((a, b) => (b.processedAt ?? b.createdAt).localeCompare(a.processedAt ?? a.createdAt));
  return [...pending, ...done];
}

export const pendingDepositTotal = (state: DemoState) => roundCents(state.transactions.filter(t => isDeposit(t) && t.status === 'Pending').reduce((sum, t) => sum + t.amount, 0));

function loadPending(state: DemoState, txId: string): { ok: true; tx: Transaction } | { ok: false; result: Result } {
  const tx = state.transactions.find(t => t.id === txId);
  if (!tx || !isDeposit(tx)) return { ok: false, result: fail('That deposit could not be found.') };
  if (tx.status !== 'Pending') {
    const what = tx.status === 'Completed' ? 'confirmed' : tx.status === 'Cancelled' ? 'cancelled by the applicant' : 'rejected';
    return { ok: false, result: fail(`${tx.reference ?? txId} was already ${what}${tx.processedBy && tx.status !== 'Cancelled' ? ` by ${tx.processedBy}` : ''}.`) };
  }
  return { ok: true, tx };
}

const replace = (state: DemoState, tx: Transaction): DemoState => ({ ...state, transactions: state.transactions.map(t => t.id === tx.id ? tx : t) });

/** Finance confirms the money arrived; only then does it count toward the deposit balance. */
export function confirmDeposit(state: DemoState, txId: string, operator: string, now: Date): Result {
  const loaded = loadPending(state, txId);
  if (!loaded.ok) return loaded.result;
  const tx: Transaction = { ...loaded.tx, status: 'Completed', processedAt: now.toISOString(), processedBy: operator };
  const next = notify(replace(state, tx), tx.applicantId, 'Deposit received', `${usd(tx.amount)} (${tx.reference}) was added to your deposit balance.`, '/deposits', now);
  return { ok: true, id: txId, message: `${tx.reference} confirmed. ${usd(tx.amount)} credited to the applicant's deposit balance.`, state: next };
}

export function rejectDeposit(state: DemoState, txId: string, reason: string, operator: string, now: Date): Result {
  const text = reason.trim();
  if (text.length < MIN_REJECTION_REASON_LENGTH) return fail('Explain why the deposit was rejected.', { reason: `Write at least ${MIN_REJECTION_REASON_LENGTH} characters; the applicant sees this reason.` });
  const loaded = loadPending(state, txId);
  if (!loaded.ok) return loaded.result;
  const tx: Transaction = { ...loaded.tx, status: 'Failed', processedAt: now.toISOString(), processedBy: operator, failureReason: text };
  const next = notify(replace(state, tx), tx.applicantId, 'Deposit not credited', `${usd(tx.amount)} (${tx.reference}): ${text}`, '/deposits', now);
  return { ok: true, id: txId, message: `${tx.reference} rejected. The applicant has been told why.`, state: next };
}
