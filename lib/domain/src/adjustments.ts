import type { AdjustmentCategory, DemoState, Result, Transaction } from './model';
import { fail, nextIds, roundCents, usd } from './core';
import { staffDeductCard, staffFundCard } from './cards';
import { notify } from './notifications';
import { computeBalances, ownTransactions } from './rules';
import { CURRENT_APPLICANT_ID } from './seed';

// Staff credit or debit one of the applicant's balances by hand: the grant
// balance, the deposit balance, or the card balance. Each adjustment is a
// ledger entry with a category and a reason the applicant sees, so balances
// stay derived from the ledger. Card adjustments are staff card moves with no
// other balance involved. Runs on the current-applicant slot, like the card rules.

export const ADJUSTMENT_CATEGORIES: AdjustmentCategory[] = ['Grant adjustment', 'Deposit manual override', 'Card fee refund', 'Correction', 'Fraud freeze'];
export type AdjustmentTarget = 'grant' | 'deposit' | 'card';
export type AdjustmentInput = { target: AdjustmentTarget; direction: 'credit' | 'debit'; amount: number; category: AdjustmentCategory; reason: string };

export const MIN_ADJUSTMENT_REASON_LENGTH = 10;
export const MAX_ADJUSTMENT = 1_000_000;
const TARGET_LABELS: Record<AdjustmentTarget, string> = { grant: 'grant balance', deposit: 'deposit balance', card: 'card balance' };

/** Field errors for the adjustment form, checked before anything else (the browser shows the same messages). */
export function validateAdjustment(input: AdjustmentInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!['grant', 'deposit', 'card'].includes(input.target)) errors.target = 'Choose which balance to adjust.';
  if (input.direction !== 'credit' && input.direction !== 'debit') errors.direction = 'Choose credit or debit.';
  if (!Number.isFinite(input.amount) || input.amount <= 0) errors.amount = 'Enter an amount above zero.';
  else if (roundCents(input.amount) !== input.amount) errors.amount = 'Use at most two decimal places.';
  else if (input.amount > MAX_ADJUSTMENT) errors.amount = `At most ${usd(MAX_ADJUSTMENT)} per adjustment.`;
  if (!ADJUSTMENT_CATEGORIES.includes(input.category)) errors.category = 'Choose a category.';
  if (input.reason.trim().length < MIN_ADJUSTMENT_REASON_LENGTH) errors.reason = `Write at least ${MIN_ADJUSTMENT_REASON_LENGTH} characters; the applicant sees this reason.`;
  return errors;
}

export function staffAdjustBalance(state: DemoState, input: AdjustmentInput, by: string, now: Date): Result {
  const errors = validateAdjustment(input);
  if (Object.keys(errors).length) return fail('Fix the highlighted fields.', errors);
  const { target, direction, amount, category } = input;
  const reason = input.reason.trim();
  const note = `${category}: ${reason}`;

  if (target === 'card') {
    const result = direction === 'credit' ? staffFundCard(state, amount, 'none', note, by, now) : staffDeductCard(state, amount, 'none', note, by, now);
    if (!result.ok) return result;
    // The card move is the adjustment: tag it with the category.
    return { ...result, state: { ...result.state, transactions: result.state.transactions.map(t => t.id === result.id ? { ...t, category } : t) } };
  }

  const balances = computeBalances(ownTransactions(state));
  const available = balances[target];
  if (direction === 'debit' && amount > available) return fail(`The ${TARGET_LABELS[target]} holds ${usd(available)}.`, { amount: `Up to ${usd(available)}.` });
  const ids = nextIds(state);
  const at = now.toISOString();
  const tx: Transaction = {
    id: ids.tx, applicantId: CURRENT_APPLICANT_ID, type: target === 'grant' ? 'Grant adjustment' : 'Deposit adjustment',
    description: `${category} by the grant team`, amount: direction === 'credit' ? amount : -amount, status: 'Completed', createdAt: at,
    processedAt: at, processedBy: by, note: reason, category,
  };
  const next: DemoState = { ...state, nextId: ids.nextId, transactions: [tx, ...state.transactions] };
  const verb = direction === 'credit' ? 'added to' : 'taken from';
  return {
    ok: true, id: tx.id, message: `${usd(amount)} ${verb} the ${TARGET_LABELS[target]} (${category.toLowerCase()}).`,
    state: notify(next, CURRENT_APPLICANT_ID, 'Balance adjusted by the grant team', `${usd(amount)} was ${verb} your ${TARGET_LABELS[target]}: ${reason}.`, '/transactions', now),
  };
}
