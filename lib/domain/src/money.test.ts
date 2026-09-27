import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, PayoutChannel, Result } from './model';
import * as M from './money';
import * as R from './rules';
import { createSeedState } from './seed';

const now = new Date('2026-09-25T12:00:00Z');

let s: DemoState;
const mine = () => R.computeBalances(R.ownTransactions(s));
const tx = (id: string) => s.transactions.find(t => t.id === id)!;
const channel = (id: string) => s.treasury.channels.find(c => c.id === id)!;
const setTreasury = (patch: Partial<DemoState['treasury']>) => { s = { ...s, treasury: { ...s.treasury, ...patch } }; };
const setChannel = (id: string, patch: Partial<PayoutChannel>) => setTreasury({ channels: s.treasury.channels.map(c => c.id === id ? { ...c, ...patch } : c) });
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  s = result.state;
  return result;
}

beforeEach(() => { s = createSeedState(); });

describe('channel fees', () => {
  it('applies rate, fixed fee, and cap', () => {
    expect(M.channelFee(channel('bank'), 100)).toBe(1.25);
    expect(M.channelFee(channel('bank'), 5000)).toBe(14);
    expect(M.channelFee(channel('wire'), 1000)).toBe(25);
    expect(M.channelFee(channel('crypto'), 100)).toBe(2);
    expect(M.channelFee(channel('bank'), 0)).toBe(0);
  });

  it('never exceeds the amount', () => {
    expect(M.channelFee({ ...channel('wire'), min: 1 }, 10)).toBe(10);
  });
});

describe('withdrawal validation', () => {
  it('offers only enabled channels', () => {
    expect(M.enabledChannels(s).map(c => c.id)).toEqual(['bank', 'mobile']);
    expect(M.validateWithdrawal(s, 600, 'wire')).toMatch(/available payout channel/);
  });

  it('enforces per-channel limits and the balance', () => {
    expect(M.validateWithdrawal(s, 5, 'bank')).toMatch(/minimum for Bank transfer/);
    expect(M.validateWithdrawal(s, 2500, 'mobile')).toMatch(/maximum for Mobile money/);
    expect(M.validateWithdrawal(s, 5000, 'bank')).toMatch(/up to \$4,075/);
    expect(M.validateWithdrawal(s, 10.005, 'bank')).toMatch(/decimal/);
    expect(M.validateWithdrawal(s, 100, 'bank')).toBeNull();
  });

  it('requires the deposit reserve', () => {
    setTreasury({ depositThreshold: 500 });
    expect(M.payoutBlocker(s)).toMatch(/Keep at least \$500/);
    expect(M.validateWithdrawal(s, 100, 'bank')).toMatch(/Keep at least/);
  });

  it('blocks payouts when every channel is disabled', () => {
    setChannel('bank', { enabled: false });
    setChannel('mobile', { enabled: false });
    expect(M.payoutBlocker(s)).toMatch(/temporarily unavailable/);
  });
});

describe('withdrawal requests', () => {
  it('records channel, fee, and destination, holds funds, and alerts staff', () => {
    const { id } = accept(M.requestWithdrawal(s, 1000, 'mobile', now));
    expect(tx(id!)).toMatchObject({ status: 'Pending', amount: -1000, method: 'mobile', fee: 10, destination: 'Mobile money · +1 (415) 555-0148' });
    expect(mine().grant).toBe(3075);
    expect(s.staffFeed[0]).toMatchObject({ kind: 'withdrawal', title: `Payout request ${id}`, read: false });
  });

  it('keeps the quoted fee even if settings change later', () => {
    const { id } = accept(M.requestWithdrawal(s, 1000, 'bank', now));
    setChannel('bank', { feeRate: 0.05, feeCap: 100 });
    expect(tx(id!).fee).toBe(12.5);
  });

  it('lets the applicant cancel a pending request, returning the funds', () => {
    const { id } = accept(M.requestWithdrawal(s, 1000, 'bank', now));
    accept(M.cancelWithdrawal(s, id!, now));
    expect(tx(id!)).toMatchObject({ status: 'Cancelled', processedBy: 'Applicant' });
    expect(mine()).toMatchObject({ grant: 4075, pendingWithdrawals: 125 });
    expect(s.staffFeed[0]!.title).toMatch(/cancelled/);
    expect(M.cancelWithdrawal(s, id!, now).ok).toBe(false);
  });

  it('cannot cancel someone else’s or a non-withdrawal entry', () => {
    expect(M.cancelWithdrawal(s, 'TX-82090', now).ok).toBe(false);
    expect(M.cancelWithdrawal(s, 'TX-84019', now).ok).toBe(false);
  });
});

describe('cards', () => {
  const address = { name: 'Alex Morgan', line1: '1 Main St', city: 'Austin', postalCode: '73301', country: 'United States' };
  it('charges issuance plus shipping once, keeping the reserve', () => {
    accept(M.requestPhysicalCard(s, address, now));
    expect(mine().deposit).toBe(429.5);
    expect(s.transactions[0]).toMatchObject({ type: 'Card fee', amount: -12, description: 'Physical card and shipping' });
    expect(s.staffFeed[0]!.kind).toBe('card');
    expect(M.requestPhysicalCard(s, address, now).ok).toBe(false);
  });

  it('refuses when fees would breach the reserve', () => {
    setTreasury({ depositThreshold: 435 });
    const result = M.requestPhysicalCard(s, address, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/keep \$435\.00 in reserve/);
  });

  it('toggles the virtual card freeze', () => {
    accept(M.toggleCardFreeze(s));
    expect(s.cards.virtual!.frozen).toBe(true);
  });
});
