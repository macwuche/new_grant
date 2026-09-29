import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result, TreasuryInput } from './model';
import * as M from './money';
import * as T from './treasury';
import { createSeedState } from './seed';

const now = new Date('2026-09-25T12:00:00Z');
const FINANCE = 'Jordan Lee';

let s: DemoState;
const input = (): TreasuryInput => { const { updatedAt: _u, changeLog: _c, channels: _ch, ...rest } = s.treasury; return rest; };
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
    const errors = T.validateTreasury({ ...input(), physicalCardFee: 500, cardDeliveryFee: -1, minDeposit: 100, maxDeposit: 50, depositThreshold: -5, highValueDeposit: 0 });
    expect(Object.keys(errors).sort()).toEqual(['cardDeliveryFee', 'depositThreshold', 'highValueDeposit', 'maxDeposit', 'physicalCardFee']);
  });
});

describe('saving', () => {
  it('applies to new requests and logs a readable summary, leaving withdrawal methods as they are', () => {
    const methods = s.treasury.channels;
    accept(T.updateTreasury(s, s.treasury.updatedAt, { ...input(), minDeposit: 50, applicationFee: 2 }, FINANCE, now));
    expect(s.treasury.changeLog.at(-1)).toMatchObject({ by: FINANCE, summary: 'Changed minimum deposit, application fee.' });
    expect(s.treasury.channels).toBe(methods);
    expect(M.validateWithdrawal(s, 600, 'bank')).toBeNull();
  });

  it('rejects stale versions and no-op saves', () => {
    expect(T.updateTreasury(s, '2020-01-01T00:00:00.000Z', input(), FINANCE, now).ok).toBe(false);
    expect(T.updateTreasury(s, s.treasury.updatedAt, input(), FINANCE, now).ok).toBe(false);
  });
});
