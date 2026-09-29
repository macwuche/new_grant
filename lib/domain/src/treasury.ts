import type { DemoState, Result, Treasury, TreasuryInput } from './model';
import { fail, roundCents } from './core';

// Money settings managed by finance: card fees, deposit limits, the deposit
// reserve, the high-value deposit flag, the two-person threshold, and the
// application fee. Withdrawal methods have their own rules (./withdrawalMethods).
// Changes apply to new requests only; pending payouts keep the fee they were quoted.

export { MAX_FEE_RATE } from './withdrawalMethods';
export const MAX_CARD_FEE = 100;

const isAmount = (value: number, allowZero = false) => Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) && roundCents(value) === value;

/** Errors keyed by field name. */
export function validateTreasury(input: TreasuryInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!isAmount(input.physicalCardFee, true) || input.physicalCardFee > MAX_CARD_FEE) errors.physicalCardFee = `Use 0–${MAX_CARD_FEE}.`;
  if (!isAmount(input.cardDeliveryFee, true) || input.cardDeliveryFee > MAX_CARD_FEE) errors.cardDeliveryFee = `Use 0–${MAX_CARD_FEE}.`;
  if (!isAmount(input.minDeposit)) errors.minDeposit = 'Enter a positive amount.';
  if (!isAmount(input.maxDeposit)) errors.maxDeposit = 'Enter a positive amount.';
  else if (!errors.minDeposit && input.maxDeposit < input.minDeposit) errors.maxDeposit = 'Must be at least the minimum deposit.';
  if (!isAmount(input.depositThreshold, true)) errors.depositThreshold = 'Enter 0 or more.';
  if (!isAmount(input.highValueDeposit)) errors.highValueDeposit = 'Enter a positive amount.';
  if (!isAmount(input.dualControlThreshold)) errors.dualControlThreshold = 'Enter a positive amount.';
  if (!isAmount(input.applicationFee, true) || input.applicationFee > MAX_CARD_FEE) errors.applicationFee = `Use 0–${MAX_CARD_FEE}.`;
  return errors;
}

const LABELS: Record<string, string> = {
  physicalCardFee: 'physical card fee', cardDeliveryFee: 'card delivery fee', minDeposit: 'minimum deposit', maxDeposit: 'maximum deposit',
  depositThreshold: 'deposit reserve', highValueDeposit: 'high-value deposit flag',
  dualControlThreshold: 'dual-control threshold', applicationFee: 'application fee',
};

export function describeChanges(before: Treasury, after: TreasuryInput): string[] {
  const changes: string[] = [];
  for (const key of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
    if (before[key as keyof Treasury] !== after[key as keyof TreasuryInput]) changes.push(LABELS[key]!);
  }
  return changes;
}

export function updateTreasury(state: DemoState, expectedVersion: string, input: TreasuryInput, by: string, now: Date): Result {
  const current = state.treasury;
  if (current.updatedAt !== expectedVersion) return fail('Money settings changed since you opened them. Review the latest values and try again.');
  const errors = validateTreasury(input);
  if (Object.keys(errors).length) return fail('Fix the highlighted settings.', errors);
  const changes = describeChanges(current, input);
  if (!changes.length) return fail('Nothing has changed.');
  const at = now.toISOString();
  const summary = `Changed ${changes.join(', ')}.`;
  // Withdrawal methods are managed on their own (./withdrawalMethods) and kept as they are.
  const treasury: Treasury = {
    channels: current.channels, physicalCardFee: input.physicalCardFee, cardDeliveryFee: input.cardDeliveryFee, minDeposit: input.minDeposit, maxDeposit: input.maxDeposit,
    depositThreshold: input.depositThreshold, highValueDeposit: input.highValueDeposit, dualControlThreshold: input.dualControlThreshold, applicationFee: input.applicationFee,
    updatedAt: at, changeLog: [...current.changeLog, { at, by, summary }],
  };
  return { ok: true, message: 'Money settings saved. They apply to new requests.', state: { ...state, treasury } };
}
