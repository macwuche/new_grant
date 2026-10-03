import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result, TreasuryInput } from './model';
import * as M from './money';
import * as T from './treasury';
import { createSeedState } from './seed';

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
