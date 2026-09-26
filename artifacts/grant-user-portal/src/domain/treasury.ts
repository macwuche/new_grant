import type { DemoState, Result, Treasury, TreasuryInput } from './model';
import { fail, roundCents } from './core';

// Money settings managed by finance: withdrawal channels (on/off, limits, fees),
// card fees, deposit limits, the deposit reserve, and the high-value deposit flag.
// Changes apply to new requests only; pending payouts keep the fee they were quoted.

export const MAX_FEE_RATE = 0.1;
export const MAX_CARD_FEE = 100;

const isAmount = (value: number, allowZero = false) => Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) && roundCents(value) === value;

/** Keys: `channels.<id>.<field>` for channel fields, otherwise the field name. */
export function validateTreasury(input: TreasuryInput): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const c of input.channels) {
    const key = (field: string) => `channels.${c.id}.${field}`;
    if (!isAmount(c.min)) errors[key('min')] = 'Enter a positive amount.';
    if (!isAmount(c.max)) errors[key('max')] = 'Enter a positive amount.';
    else if (!errors[key('min')] && c.max < c.min) errors[key('max')] = 'Must be at least the minimum.';
    if (!Number.isFinite(c.feeRate) || c.feeRate < 0 || c.feeRate > MAX_FEE_RATE) errors[key('feeRate')] = `Use 0–${MAX_FEE_RATE * 100}%.`;
    if (!isAmount(c.feeFixed, true)) errors[key('feeFixed')] = 'Enter 0 or more.';
    if (!isAmount(c.feeCap, true)) errors[key('feeCap')] = 'Enter 0 or more.';
    else if (!errors[key('feeFixed')] && c.feeCap < c.feeFixed) errors[key('feeCap')] = 'The cap must be at least the fixed fee.';
    if (!errors[key('min')] && !errors[key('feeFixed')] && c.feeFixed >= c.min) errors[key('feeFixed')] = 'The fixed fee must be below the channel minimum, or the smallest payout would be all fee.';
  }
  if (!isAmount(input.physicalCardFee, true) || input.physicalCardFee > MAX_CARD_FEE) errors.physicalCardFee = `Use 0–${MAX_CARD_FEE}.`;
  if (!isAmount(input.cardDeliveryFee, true) || input.cardDeliveryFee > MAX_CARD_FEE) errors.cardDeliveryFee = `Use 0–${MAX_CARD_FEE}.`;
  if (!isAmount(input.minDeposit)) errors.minDeposit = 'Enter a positive amount.';
  if (!isAmount(input.maxDeposit)) errors.maxDeposit = 'Enter a positive amount.';
  else if (!errors.minDeposit && input.maxDeposit < input.minDeposit) errors.maxDeposit = 'Must be at least the minimum deposit.';
  if (!isAmount(input.depositThreshold, true)) errors.depositThreshold = 'Enter 0 or more.';
  if (!isAmount(input.highValueDeposit)) errors.highValueDeposit = 'Enter a positive amount.';
  return errors;
}

const LABELS: Record<string, string> = {
  physicalCardFee: 'physical card fee', cardDeliveryFee: 'card delivery fee', minDeposit: 'minimum deposit', maxDeposit: 'maximum deposit',
  depositThreshold: 'deposit reserve', highValueDeposit: 'high-value deposit flag',
};

export function describeChanges(before: Treasury, after: TreasuryInput): string[] {
  const changes: string[] = [];
  for (const c of after.channels) {
    const old = before.channels.find(o => o.id === c.id);
    if (!old) continue;
    if (old.enabled !== c.enabled) changes.push(`${c.name} ${c.enabled ? 'enabled' : 'disabled'}`);
    if (old.min !== c.min || old.max !== c.max) changes.push(`${c.name} limits`);
    if (old.feeRate !== c.feeRate || old.feeFixed !== c.feeFixed || old.feeCap !== c.feeCap) changes.push(`${c.name} fees`);
  }
  for (const key of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
    if (before[key as keyof Treasury] !== after[key as keyof TreasuryInput]) changes.push(LABELS[key]!);
  }
  return changes;
}

export function updateTreasury(state: DemoState, expectedVersion: string, input: TreasuryInput, by: string, now: Date): Result {
  const current = state.treasury;
  if (current.updatedAt !== expectedVersion) return fail('Money settings changed since you opened them. Review the latest values and try again.');
  if (input.channels.length !== current.channels.length || input.channels.some(c => !current.channels.find(o => o.id === c.id))) return fail('Channels can be configured but not added or removed.');
  const errors = validateTreasury(input);
  if (Object.keys(errors).length) return fail('Fix the highlighted settings.', errors);
  const changes = describeChanges(current, input);
  if (!changes.length) return fail('Nothing has changed.');
  const at = now.toISOString();
  const summary = `Changed ${changes.join(', ')}.`;
  const treasury: Treasury = { ...input, channels: input.channels.map(c => ({ ...c })), updatedAt: at, changeLog: [...current.changeLog, { at, by, summary }] };
  const warning = treasury.channels.some(c => c.enabled) ? '' : ' Every payout channel is now disabled, so applicants cannot request payouts.';
  return { ok: true, message: `Money settings saved. They apply to new requests.${warning}`, state: { ...state, treasury } };
}
