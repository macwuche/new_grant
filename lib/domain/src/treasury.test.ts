import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result, TreasuryInput } from './model';
import * as M from './money';
import * as T from './treasury';
import { createSeedState } from './seed';

const now = new Date('2026-09-25T12:00:00Z');
const FINANCE = 'Jordan Lee';

let s: DemoState;
const input = (): TreasuryInput => { const { updatedAt: _u, changeLog: _c, ...rest } = s.treasury; return { ...rest, channels: rest.channels.map(c => ({ ...c })) }; };
const withChannel = (id: string, patch: object): TreasuryInput => { const i = input(); return { ...i, channels: i.channels.map(c => c.id === id ? { ...c, ...patch } : c) }; };
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

  it('checks channel limits and fees', () => {
    const errors = T.validateTreasury(withChannel('bank', { min: 0, max: -1, feeRate: 0.2, feeFixed: -1, feeCap: -1 }));
    expect(Object.keys(errors).sort()).toEqual(['channels.bank.feeCap', 'channels.bank.feeFixed', 'channels.bank.feeRate', 'channels.bank.max', 'channels.bank.min']);
    expect(T.validateTreasury(withChannel('bank', { max: 5 }))['channels.bank.max']).toMatch(/at least the minimum/);
    expect(T.validateTreasury(withChannel('wire', { feeFixed: 600, feeCap: 600 }))['channels.wire.feeFixed']).toMatch(/below the channel minimum/);
    expect(T.validateTreasury(withChannel('crypto', { feeCap: 0.5 }))['channels.crypto.feeCap']).toMatch(/at least the fixed fee/);
  });

  it('checks deposit and card settings', () => {
    const errors = T.validateTreasury({ ...input(), physicalCardFee: 500, cardDeliveryFee: -1, minDeposit: 100, maxDeposit: 50, depositThreshold: -5, highValueDeposit: 0 });
    expect(Object.keys(errors).sort()).toEqual(['cardDeliveryFee', 'depositThreshold', 'highValueDeposit', 'maxDeposit', 'physicalCardFee']);
  });
});

describe('saving', () => {
  it('applies to new requests and logs a readable summary', () => {
    accept(T.updateTreasury(s, s.treasury.updatedAt, { ...withChannel('wire', { enabled: true }), minDeposit: 50 }, FINANCE, now));
    expect(M.enabledChannels(s).map(c => c.id)).toContain('wire');
    expect(s.treasury.changeLog.at(-1)).toMatchObject({ by: FINANCE, summary: 'Changed Wire transfer enabled, minimum deposit.' });
    expect(M.validateWithdrawal(s, 600, 'wire')).toBeNull();
  });

  it('rejects stale versions, no-op saves, and added channels', () => {
    expect(T.updateTreasury(s, '2020-01-01T00:00:00.000Z', input(), FINANCE, now).ok).toBe(false);
    expect(T.updateTreasury(s, s.treasury.updatedAt, input(), FINANCE, now).ok).toBe(false);
    const extra = { ...input(), channels: [...input().channels, { ...input().channels[0]!, id: 'cash' as never }] };
    expect(T.updateTreasury(s, s.treasury.updatedAt, extra, FINANCE, now).ok).toBe(false);
  });

  it('warns when every channel is disabled', () => {
    const off = { ...input(), channels: input().channels.map(c => ({ ...c, enabled: false })) };
    const result = accept(T.updateTreasury(s, s.treasury.updatedAt, off, FINANCE, now));
    expect(result.message).toMatch(/cannot request payouts/);
  });
});
