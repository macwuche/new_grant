import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result, TreasuryInput } from './model';
import * as M from './money';
import * as T from './treasury';
import { createSeedState } from './seed';
import { normalizeTreasury } from './depositMethods';

const now = new Date('2026-09-25T12:00:00Z');
const FINANCE = 'Jordan Lee';

let s: DemoState;
const input = (): TreasuryInput => { const { updatedAt: _u, changeLog: _c, channels: _ch, depositMethods: _dm, ...rest } = s.treasury; return rest; };
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error} ${JSON.stringify(result.fieldErrors ?? {})}`);
  s = result.state;
  return result;
}

beforeEach(() => { s = createSeedState(); });

describe('validation', () => {
  it('accepts the defaults', () => {
    expect(T.validateTreasury(input())).toEqual({});
  });

  it('checks deposit and card settings', () => {
    const errors = T.validateTreasury({ ...input(), physicalCardFee: 500, cardDeliveryFee: -1, depositThreshold: -5, highValueDeposit: 0, depositDualControlThreshold: -1 });
    expect(Object.keys(errors).sort()).toEqual(['cardDeliveryFee', 'depositDualControlThreshold', 'depositThreshold', 'highValueDeposit', 'physicalCardFee']);
    expect(T.validateTreasury({ ...input(), depositDualControlThreshold: 0 })).toEqual({});
  });
  it('checks the eligible amount for each tier (0 is allowed: not set)', () => {
    const errors = T.validateTreasury({ ...input(), tierEligibleAmounts: { tier1: -1, tier2: 1000.555, tier3: Number.NaN } });
    expect(Object.keys(errors).sort()).toEqual(['tierEligibleAmounts.tier1', 'tierEligibleAmounts.tier2', 'tierEligibleAmounts.tier3']);
    expect(T.validateTreasury({ ...input(), tierEligibleAmounts: { tier1: 0, tier2: 5000, tier3: 25000.5 } })).toEqual({});
  });
});

describe('eligible amount by tier', () => {
  it('starts unset, and older saved settings have none set', () => {
    expect(s.treasury.tierEligibleAmounts).toEqual({ tier1: 0, tier2: 0, tier3: 0 });
    const { tierEligibleAmounts: _t, ...old } = s.treasury;
    expect(normalizeTreasury(old).tierEligibleAmounts).toEqual({ tier1: 0, tier2: 0, tier3: 0 });
    expect(normalizeTreasury({ ...old, tierEligibleAmounts: { tier2: 800 } }).tierEligibleAmounts).toEqual({ tier1: 0, tier2: 800, tier3: 0 });
  });

  it('gives the amount for the tier, or null when that tier is not set', () => {
    const amounts = { tier1: 2000, tier2: 0, tier3: 50000 };
    expect(T.eligibleAmountFor(amounts, 1)).toBe(2000);
    expect(T.eligibleAmountFor(amounts, 2)).toBeNull();
    expect(T.eligibleAmountFor(amounts, 3)).toBe(50000);
  });

  it('saves tier amounts and names the changed tiers in the change log', () => {
    accept(T.updateTreasury(s, s.treasury.updatedAt, { ...input(), tierEligibleAmounts: { tier1: 5000, tier2: 0, tier3: 40000 } }, FINANCE, now));
    expect(s.treasury.tierEligibleAmounts).toEqual({ tier1: 5000, tier2: 0, tier3: 40000 });
    expect(s.treasury.changeLog.at(-1)?.summary).toBe('Changed tier 1 eligible amount, tier 3 eligible amount.');
  });
});

describe('saving', () => {
  it('applies to new requests and logs a readable summary, leaving withdrawal methods as they are', () => {
    const methods = s.treasury.channels;
    const depositMethods = s.treasury.depositMethods;
    accept(T.updateTreasury(s, s.treasury.updatedAt, { ...input(), depositDualControlThreshold: 5000, physicalCardFee: 2 }, FINANCE, now));
    expect(s.treasury.changeLog.at(-1)).toMatchObject({ by: FINANCE, summary: 'Changed physical card fee, deposit two-person threshold.' });
    expect(s.treasury.depositMethods).toBe(depositMethods);
    expect(s.treasury.channels).toBe(methods);
    expect(M.validateWithdrawal(s, 600, 'bank')).toBeNull();
  });

  it('rejects stale versions and no-op saves', () => {
    expect(T.updateTreasury(s, '2020-01-01T00:00:00.000Z', input(), FINANCE, now).ok).toBe(false);
    expect(T.updateTreasury(s, s.treasury.updatedAt, input(), FINANCE, now).ok).toBe(false);
  });
});
