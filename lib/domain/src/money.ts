import type { ChannelId, DemoState, PayoutBalance, PayoutChannel, Result, Transaction } from './model';
import { fail, nextIds, roundCents, usd } from './core';
import { alertIfHighRisk, logStaff } from './activity';
import { accountLockReason, patchAccount, permissionBlocker, permissionsOf } from './applicants';
import { computeBalances, ownTransactions } from './rules';
import { notify } from './notifications';
import { lockdownMessage } from './security';
import { CURRENT_APPLICANT_ID } from './seed';
import { BALANCE_LABELS, checkAnswers, destinationSummary, methodBalances } from './withdrawalMethods';

// Applicant money actions: withdrawals (cards: ./cards). Methods, with their limits, charges, balance, and form,
// are managed by finance (./withdrawalMethods). No provider is connected.

/** Fee = min(fixed + amount × rate, cap), never more than the amount itself. A cap of 0 means no maximum. */
export function channelFee(channel: Pick<PayoutChannel, 'feeFixed' | 'feeRate' | 'feeCap'>, amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const cap = channel.feeCap > 0 ? channel.feeCap : Infinity;
  return roundCents(Math.min(channel.feeFixed + amount * channel.feeRate, cap, amount));
}

export const enabledChannels = (state: DemoState) => state.treasury.channels.filter(c => c.enabled);
export const findChannel = (state: DemoState, id: string) => state.treasury.channels.find(c => c.id === id);

/** Why the applicant can't request a payout right now (independent of amount), or null. */
export function payoutBlocker(state: DemoState): string | null {
  const locked = accountLockReason(state) ?? lockdownMessage(state) ?? permissionBlocker(state, 'payout');
  if (locked) return locked;
  if (!enabledChannels(state).length) return 'Payouts are temporarily unavailable: no withdrawal method is available.';
  return null;
}

/**
 * Why grant payouts are on hold, or null. By default they never are, even with
 * a negative deposit balance (e.g. an unpaid commission); staff can switch on
 * "clear a negative deposit balance first" per applicant. (Grant payouts don't
 * need the deposit reserve; payouts from the deposit balance keep it.)
 */
export function grantPayoutHold(state: DemoState): string | null {
  if (!permissionsOf(state).clearBalanceForPayouts) return null;
  const { deposit } = computeBalances(ownTransactions(state));
  return deposit < 0 ? `Your deposit balance is ${usd(deposit)}. Add funds to bring it back to ${usd(0)} or more before requesting a payout from your grant balance.` : null;
}

/** How much the applicant can request from a balance: the grant balance, or the deposit balance above the reserve. */
export function availableFor(state: DemoState, balance: PayoutBalance): number {
  const { grant, deposit } = computeBalances(ownTransactions(state));
  return roundCents(Math.max(0, balance === 'grant' ? grant : deposit - state.treasury.depositThreshold));
}

export type WithdrawalInput = {
  amount: number;
  method: ChannelId;
  /** Required when the method pays out from both balances; otherwise it must match (or be left out). */
  source?: PayoutBalance;
  /** The method's form: field id → answer. */
  details?: Record<string, string>;
};

/** The balance a request comes from, or why it can't be chosen. */
function balanceFor(method: PayoutChannel, source: PayoutBalance | undefined): { balance: PayoutBalance } | { error: string } {
  const allowed = methodBalances(method);
  if (source === undefined) return allowed.length === 1 ? { balance: allowed[0]! } : { error: 'Choose the balance to withdraw from.' };
  return allowed.includes(source) ? { balance: source } : { error: `${method.name} pays out from your ${BALANCE_LABELS[allowed[0]!].toLowerCase()} only.` };
}

/** Amount and balance problems (not the form), or null. */
export function validateWithdrawal(state: DemoState, amount: number, channelId: string, source?: PayoutBalance): string | null {
  const channel = findChannel(state, channelId);
  if (!channel || !channel.enabled) return 'Choose an available withdrawal method.';
  const blocker = payoutBlocker(state);
  if (blocker) return blocker;
  const chosen = balanceFor(channel, source);
  if ('error' in chosen) return chosen.error;
  const held = chosen.balance === 'grant' ? grantPayoutHold(state) : null;
  if (held) return held;
  if (!Number.isFinite(amount) || amount <= 0) return 'Enter an amount to withdraw.';
  if (roundCents(amount) !== amount) return 'Use at most two decimal places.';
  if (amount < channel.min) return `The minimum for ${channel.name} is ${usd(channel.min)}.`;
  if (amount > channel.max) return `The maximum for ${channel.name} is ${usd(channel.max)} per request.`;
  const available = availableFor(state, chosen.balance);
  if (amount > available) {
    return chosen.balance === 'grant'
      ? `You can request up to ${usd(available)} from your grant balance.`
      : `You can request up to ${usd(available)} from your deposit balance (the ${usd(state.treasury.depositThreshold)} reserve stays in it).`;
  }
  if (amount <= channelFee(channel, amount)) return `The amount must be more than the ${usd(channelFee(channel, amount))} fee.`;
  return null;
}

export function requestWithdrawal(state: DemoState, input: WithdrawalInput, now: Date): Result {
  const { amount } = input;
  const error = validateWithdrawal(state, amount, input.method, input.source);
  if (error) return fail(error, { amount: error });
  const channel = findChannel(state, input.method)!;
  const checked = checkAnswers(channel, input.details ?? {});
  if ('errors' in checked) return fail(`Fix the highlighted ${channel.formTitle ? channel.formTitle.toLowerCase() : 'details'}.`, checked.errors);
  const source = (balanceFor(channel, input.source) as { balance: PayoutBalance }).balance;
  const ids = nextIds(state);
  const tx: Transaction = {
    id: ids.tx, applicantId: CURRENT_APPLICANT_ID, type: 'Withdrawal', description: `Payout to ${channel.name}`, amount: -amount, status: 'Pending',
    createdAt: now.toISOString(), method: channel.id, fee: channelFee(channel, amount), destination: destinationSummary(channel.name, checked.details),
    source, payoutDetails: checked.details,
    ...(amount >= state.treasury.dualControlThreshold && permissionsOf(state).payoutTwoSignOffs ? { dualControl: true } : {}),
  };
  // The answers are remembered for next time; changing them is a fraud signal (staff are told; risk rises for 7 days).
  const remembered = Object.fromEntries(checked.details.map(d => [d.fieldId, d.value]));
  const previous = state.savedPayoutDetails[channel.id];
  const detailsChanged = JSON.stringify(previous ?? null) !== JSON.stringify(remembered);
  let next: DemoState = { ...state, nextId: ids.nextId, transactions: [tx, ...state.transactions], savedPayoutDetails: { ...state.savedPayoutDetails, [channel.id]: remembered } };
  if (detailsChanged && checked.details.length) {
    next = patchAccount(next, CURRENT_APPLICANT_ID, { destinationChangedAt: now.toISOString() });
    next = logStaff(next, { kind: 'account', title: `Payout details ${previous ? 'changed' : 'added'}`, body: `${state.profile.name} · ${channel.name} → ${tx.destination}`, href: '/admin/payouts' }, now);
  }
  const logged = logStaff(next, {
    kind: 'withdrawal', highlight: !!tx.dualControl, title: `Payout request ${tx.id}${tx.dualControl ? ' (needs two sign-offs)' : ''}`, body: `${state.profile.name} · ${usd(amount)} via ${channel.name} from the ${BALANCE_LABELS[source].toLowerCase()}`, href: '/admin/payouts',
  }, now);
  const notified = notify(logged, CURRENT_APPLICANT_ID, 'Payout requested', `Your ${usd(amount)} payout to ${channel.name} (${tx.id}) is pending${tx.fee ? `; a ${usd(tx.fee)} fee applies` : ''}. We'll let you know when it's sent.`, '/withdrawals', now);
  return { ok: true, id: tx.id, message: `Payout request ${tx.id} recorded as pending.`, state: alertIfHighRisk(state, notified, CURRENT_APPLICANT_ID, now) };
}

/** Where a withdrawal's money comes from (older requests have no source: the grant balance). */
export const withdrawalBalance = (tx: Pick<Transaction, 'source'>): PayoutBalance => tx.source ?? 'grant';

/** The applicant may withdraw a request finance hasn't processed yet; the held amount returns to its balance. */
export function cancelWithdrawal(state: DemoState, txId: string, now: Date): Result {
  const tx = ownTransactions(state).find(t => t.id === txId && t.type === 'Withdrawal');
  if (!tx) return fail('That payout request could not be found.');
  if (tx.status !== 'Pending') return fail('Only pending payout requests can be cancelled.');
  const cancelled: Transaction = { ...tx, status: 'Cancelled', processedAt: now.toISOString(), processedBy: 'Applicant' };
  const next = logStaff({ ...state, transactions: state.transactions.map(t => t.id === txId ? cancelled : t) }, {
    kind: 'withdrawal', title: `Payout request ${txId} cancelled`, body: `${state.profile.name} cancelled ${usd(Math.abs(tx.amount))}. No action needed.`, href: '/admin/payouts',
  }, now);
  return { ok: true, id: txId, message: `Payout request ${txId} cancelled. ${usd(Math.abs(tx.amount))} is back in your ${BALANCE_LABELS[withdrawalBalance(tx)].toLowerCase()}.`, state: next };
}

// Cards live in ./cards; re-exported so existing imports keep working.
export * from './cards';
