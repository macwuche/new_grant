import type { ChannelId, DemoState, PayoutChannel, Result, Transaction, Treasury } from './model';
import { fail, nextIds, roundCents, usd } from './core';
import { logStaff } from './activity';
import { computeBalances, ownTransactions } from './rules';
import { CURRENT_APPLICANT_ID, payoutDestinations } from './seed';

// Applicant money actions: withdrawals and cards. Limits and fees come from the
// treasury settings finance manages in /admin/settings. No provider is connected.

/** Fee = min(fixed + amount × rate, cap), never more than the amount itself. */
export function channelFee(channel: PayoutChannel, amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return roundCents(Math.min(channel.feeFixed + amount * channel.feeRate, channel.feeCap, amount));
}

export const enabledChannels = (state: DemoState) => state.treasury.channels.filter(c => c.enabled);
export const findChannel = (state: DemoState, id: string) => state.treasury.channels.find(c => c.id === id);

/** Why the applicant can't request a payout right now (independent of amount), or null. */
export function payoutBlocker(state: DemoState): string | null {
  const { deposit } = computeBalances(ownTransactions(state));
  if (!enabledChannels(state).length) return 'Payouts are temporarily unavailable: no payout channel is enabled.';
  if (deposit < state.treasury.depositThreshold) return `Keep at least ${usd(state.treasury.depositThreshold)} in your deposit balance to request payouts (you have ${usd(deposit)}).`;
  return null;
}

export function validateWithdrawal(state: DemoState, amount: number, channelId: string): string | null {
  const channel = findChannel(state, channelId);
  if (!channel || !channel.enabled) return 'Choose an available payout channel.';
  const blocker = payoutBlocker(state);
  if (blocker) return blocker;
  const { grant } = computeBalances(ownTransactions(state));
  if (!Number.isFinite(amount) || amount <= 0) return 'Enter an amount to withdraw.';
  if (roundCents(amount) !== amount) return 'Use at most two decimal places.';
  if (amount < channel.min) return `The minimum for ${channel.name} is ${usd(channel.min)}.`;
  if (amount > channel.max) return `The maximum for ${channel.name} is ${usd(channel.max)} per request.`;
  if (amount > grant) return `You can request up to ${usd(grant)}.`;
  if (amount <= channelFee(channel, amount)) return `The amount must be more than the ${usd(channelFee(channel, amount))} fee.`;
  return null;
}

export function requestWithdrawal(state: DemoState, amount: number, channelId: ChannelId, now: Date): Result {
  const error = validateWithdrawal(state, amount, channelId);
  if (error) return fail(error, { amount: error });
  const channel = findChannel(state, channelId)!;
  const ids = nextIds(state);
  const tx: Transaction = {
    id: ids.tx, applicantId: CURRENT_APPLICANT_ID, type: 'Withdrawal', description: `Payout to ${channel.name}`, amount: -amount, status: 'Pending',
    createdAt: now.toISOString(), method: channel.id, fee: channelFee(channel, amount), destination: `${channel.name} · ${payoutDestinations[channel.id]}`,
  };
  const next = logStaff({ ...state, nextId: ids.nextId, transactions: [tx, ...state.transactions] }, {
    kind: 'withdrawal', title: `Payout request ${tx.id}`, body: `${state.profile.name} · ${usd(amount)} via ${channel.name}`, href: '/admin/payouts',
  }, now);
  return { ok: true, id: tx.id, message: `Payout request ${tx.id} recorded as pending.`, state: next };
}

/** The applicant may withdraw a request finance hasn't processed yet; the held amount returns. */
export function cancelWithdrawal(state: DemoState, txId: string, now: Date): Result {
  const tx = ownTransactions(state).find(t => t.id === txId && t.type === 'Withdrawal');
  if (!tx) return fail('That payout request could not be found.');
  if (tx.status !== 'Pending') return fail('Only pending payout requests can be cancelled.');
  const cancelled: Transaction = { ...tx, status: 'Cancelled', processedAt: now.toISOString(), processedBy: 'Applicant' };
  const next = logStaff({ ...state, transactions: state.transactions.map(t => t.id === txId ? cancelled : t) }, {
    kind: 'withdrawal', title: `Payout request ${txId} cancelled`, body: `${state.profile.name} cancelled ${usd(Math.abs(tx.amount))}. No action needed.`, href: '/admin/payouts',
  }, now);
  return { ok: true, id: txId, message: `Payout request ${txId} cancelled. ${usd(Math.abs(tx.amount))} is back in your grant balance.`, state: next };
}

// ---------- Cards ----------

export const physicalCardTotal = (treasury: Treasury) => roundCents(treasury.physicalCardFee + treasury.cardDeliveryFee);

export function toggleCardFreeze(state: DemoState): Result {
  const frozen = !state.cards.virtual.frozen;
  return { ok: true, message: frozen ? 'Virtual card frozen.' : 'Virtual card unfrozen.', state: { ...state, cards: { ...state.cards, virtual: { ...state.cards.virtual, frozen } } } };
}

/** Charges issuance + delivery to the deposit balance, which must still hold the reserve afterwards. */
export function requestPhysicalCard(state: DemoState, now: Date): Result {
  if (state.cards.physical.status !== 'Not requested') return fail('A physical card has already been requested.');
  const total = physicalCardTotal(state.treasury);
  const reserve = state.treasury.depositThreshold;
  const { deposit } = computeBalances(ownTransactions(state));
  if (deposit - total < reserve) return fail(`Your deposit balance must cover the ${usd(total)} card fees${reserve ? ` and keep ${usd(reserve)} in reserve` : ''}. You have ${usd(deposit)}.`);
  const ids = nextIds(state);
  const fee: Transaction = { id: ids.tx, applicantId: CURRENT_APPLICANT_ID, type: 'Card fee', description: `Physical card issuance${state.treasury.cardDeliveryFee ? ' and delivery' : ''}`, amount: -total, status: 'Completed', createdAt: now.toISOString() };
  const next = logStaff({ ...state, nextId: ids.nextId, transactions: [fee, ...state.transactions], cards: { ...state.cards, physical: { ...state.cards.physical, status: 'Requested' } } }, {
    kind: 'card', title: 'Physical card requested', body: `${state.profile.name} · ${usd(total)} in fees charged`, href: '/admin/applicants',
  }, now);
  return { ok: true, message: `Physical card requested. ${usd(total)} in fees deducted from your deposit balance.`, state: next };
}
