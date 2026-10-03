import type { DemoState, Result, Treasury, TreasuryInput } from './model';
import { fail, roundCents } from './core';

// Money settings managed by finance: card fees, the deposit reserve, the
// high-value deposit flag, the two-person thresholds for payouts and deposits,
// and the application fee. Withdrawal and deposit methods (with their limits
// and charges) have their own rules (./withdrawalMethods, ./depositMethods).
// Changes apply to new requests only; pending ones keep what they were quoted.

export { MAX_FEE_RATE } from './withdrawalMethods';
export const MAX_CARD_FEE = 100;

const isAmount = (value: number, allowZero = false) => Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) && roundCents(value) === value;

/** Errors keyed by field name. */
export function validateTreasury(input: TreasuryInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!isAmount(input.physicalCardFee, true) || input.physicalCardFee > MAX_CARD_FEE) errors.physicalCardFee = `Use 0–${MAX_CARD_FEE}.`;
  if (!isAmount(input.cardDeliveryFee, true) || input.cardDeliveryFee > MAX_CARD_FEE) errors.cardDeliveryFee = `Use 0–${MAX_CARD_FEE}.`;
  if (!isAmount(input.depositThreshold, true)) errors.depositThreshold = 'Enter 0 or more.';
  if (!isAmount(input.highValueDeposit)) errors.highValueDeposit = 'Enter a positive amount.';
  if (!isAmount(input.dualControlThreshold)) errors.dualControlThreshold = 'Enter a positive amount.';
  if (!isAmount(input.depositDualControlThreshold, true)) errors.depositDualControlThreshold = 'Enter 0 or more (0 means never).';
  return errors;
}

const LABELS: Record<string, string> = {
  physicalCardFee: 'physical card fee', cardDeliveryFee: 'card delivery fee',
  depositThreshold: 'deposit reserve', highValueDeposit: 'high-value deposit flag',
  dualControlThreshold: 'dual-control threshold', depositDualControlThreshold: 'deposit two-person threshold',
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
  // Withdrawal and deposit methods are managed on their own and kept as they are.
  const treasury: Treasury = {
    channels: current.channels, physicalCardFee: input.physicalCardFee, cardDeliveryFee: input.cardDeliveryFee, depositMethods: current.depositMethods,
    depositThreshold: input.depositThreshold, highValueDeposit: input.highValueDeposit, dualControlThreshold: input.dualControlThreshold,
    depositDualControlThreshold: input.depositDualControlThreshold,
    updatedAt: at, changeLog: [...current.changeLog, { at, by, summary }],
  };
  return { ok: true, message: 'Money settings saved. They apply to new requests.', state: { ...state, treasury } };
}
