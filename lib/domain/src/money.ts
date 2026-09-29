import type { ChannelId, DemoState, PayoutChannel, Result, Transaction } from './model';
import { fail, nextIds, roundCents, usd } from './core';
import { alertIfHighRisk, logStaff } from './activity';
import { accountLockReason, patchAccount, permissionBlocker } from './applicants';
import { computeBalances, ownTransactions } from './rules';
import { notify } from './notifications';
import { lockdownMessage } from './security';
import { CURRENT_APPLICANT_ID } from './seed';

// Applicant money actions: withdrawals and payout destinations (cards: ./cards). Limits and fees come from the
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
  const locked = accountLockReason(state) ?? lockdownMessage(state) ?? permissionBlocker(state, 'payout');
  if (locked) return locked;
  const { deposit } = computeBalances(ownTransactions(state));
  if (!enabledChannels(state).length) return 'Payouts are temporarily unavailable: no payout channel is enabled.';
  if (deposit < state.treasury.depositThreshold) return `Keep at least ${usd(state.treasury.depositThreshold)} in your deposit balance to request payouts (you have ${usd(deposit)}).`;
  return null;
}

export function validateWithdrawal(state: DemoState, amount: number, channelId: string): string | null {
  const channel = findChannel(state, channelId);
  if (!channel || !channel.enabled) return 'Choose an available payout channel.';
  if (!state.payoutDestinations[channel.id]) return `Add your ${channel.name} details in Settings → Payout destinations first.`;
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
    createdAt: now.toISOString(), method: channel.id, fee: channelFee(channel, amount), destination: `${channel.name} · ${state.payoutDestinations[channel.id]}`,
    ...(amount >= state.treasury.dualControlThreshold ? { dualControl: true } : {}),
  };
  const logged = logStaff({ ...state, nextId: ids.nextId, transactions: [tx, ...state.transactions] }, {
    kind: 'withdrawal', highlight: !!tx.dualControl, title: `Payout request ${tx.id}${tx.dualControl ? ' (needs two sign-offs)' : ''}`, body: `${state.profile.name} · ${usd(amount)} via ${channel.name}`, href: '/admin/payouts',
  }, now);
  const notified = notify(logged, CURRENT_APPLICANT_ID, 'Payout requested', `Your ${usd(amount)} payout to ${channel.name} (${tx.id}) is pending${tx.fee ? `; a ${usd(tx.fee)} fee applies` : ''}. We'll let you know when it's sent.`, '/withdrawals', now);
  return { ok: true, id: tx.id, message: `Payout request ${tx.id} recorded as pending.`, state: alertIfHighRisk(state, notified, CURRENT_APPLICANT_ID, now) };
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

// Cards live in ./cards; re-exported so existing imports keep working.
export * from './cards';

// ---------- Payout destinations ----------

export type DestinationField = { key: 'primary' | 'secondary'; label: string; placeholder: string };
export const DESTINATION_FIELDS: Record<ChannelId, DestinationField[]> = {
  bank: [{ key: 'primary', label: 'Bank name', placeholder: 'e.g. Meridian Bank' }, { key: 'secondary', label: 'Account number', placeholder: '6–17 digits' }],
  wire: [{ key: 'primary', label: 'SWIFT / BIC', placeholder: 'e.g. MRDNUS33' }, { key: 'secondary', label: 'Account number or IBAN', placeholder: '6–34 letters or digits' }],
  mobile: [{ key: 'primary', label: 'Mobile money number', placeholder: '+1 415 555 0148' }],
  crypto: [{ key: 'primary', label: 'USDT (TRC-20) address', placeholder: 'T… (34 characters)' }],
};
export type DestinationInput = { primary: string; secondary?: string };

const last4 = (value: string) => `•••• ${value.slice(-4)}`;

/** Validates channel-specific details and returns the masked label that gets stored. Full numbers are never kept. */
export function destinationLabel(channelId: ChannelId, input: DestinationInput): { label: string } | { errors: Record<string, string> } {
  const a = input.primary.trim();
  const b = (input.secondary ?? '').replace(/[\s-]/g, '');
  const errors: Record<string, string> = {};
  if (channelId === 'bank') {
    if (a.length < 2 || a.length > 40) errors.primary = 'Enter the bank name.';
    if (!/^\d{6,17}$/.test(b)) errors.secondary = 'Enter 6–17 digits.';
    return Object.keys(errors).length ? { errors } : { label: `${a} · ${last4(b)}` };
  }
  if (channelId === 'wire') {
    const swift = a.toUpperCase().replace(/\s/g, '');
    if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) errors.primary = 'Enter an 8 or 11 character SWIFT/BIC code.';
    if (!/^[A-Za-z0-9]{6,34}$/.test(b)) errors.secondary = 'Enter 6–34 letters or digits.';
    return Object.keys(errors).length ? { errors } : { label: `SWIFT ${swift} · ${last4(b.toUpperCase())}` };
  }
  if (channelId === 'mobile') {
    const digits = a.replace(/\D/g, '');
    if (!/^\+?[\d\s()-]+$/.test(a) || digits.length < 7 || digits.length > 15) return { errors: { primary: 'Enter a phone number (7–15 digits).' } };
    return { label: a };
  }
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return { errors: { primary: 'Enter a TRC-20 address: 34 characters starting with T.' } };
  return { label: `USDT (TRC-20) · ${a.slice(0, 4)}…${a.slice(-4)}` };
}

/** Saving a destination is a fraud signal, so staff are told and the risk score reflects it for 7 days. */
export function savePayoutDestination(state: DemoState, channelId: ChannelId, input: DestinationInput, now: Date): Result {
  const locked = accountLockReason(state);
  if (locked) return fail(locked);
  const channel = findChannel(state, channelId);
  if (!channel) return fail('Choose a payout channel.');
  const checked = destinationLabel(channelId, input);
  if ('errors' in checked) return fail('Fix the highlighted fields.', checked.errors);
  const previous = state.payoutDestinations[channelId];
  if (previous === checked.label) return fail('That destination is already saved.');
  const saved = patchAccount({ ...state, payoutDestinations: { ...state.payoutDestinations, [channelId]: checked.label } }, CURRENT_APPLICANT_ID, { destinationChangedAt: now.toISOString() });
  const logged = logStaff(saved, {
    kind: 'account', title: `Payout destination ${previous ? 'changed' : 'added'}`, body: `${state.profile.name} · ${channel.name} → ${checked.label}`, href: '/admin/applicants',
  }, now);
  return { ok: true, message: `${channel.name} destination saved. New payout requests go to ${checked.label}.`, state: alertIfHighRisk(state, logged, CURRENT_APPLICANT_ID, now) };
}

export function removePayoutDestination(state: DemoState, channelId: ChannelId): Result {
  if (!state.payoutDestinations[channelId]) return fail('No destination is saved for that channel.');
  const { [channelId]: _, ...rest } = state.payoutDestinations;
  return { ok: true, message: 'Destination removed. Pending requests still go where they were sent.', state: { ...state, payoutDestinations: rest } };
}
