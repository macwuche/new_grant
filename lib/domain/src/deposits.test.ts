import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result } from './model';
import * as A from './activity';
import * as D from './deposits';
import * as N from './notifications';
import * as R from './rules';
import { createSeedState } from './seed';

const now = new Date('2026-09-25T12:00:00Z');
const FINANCE = 'Jordan Lee';

let s: DemoState;
const mine = () => R.computeBalances(R.ownTransactions(s));
const tx = (id: string) => s.transactions.find(t => t.id === id)!;
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  s = result.state;
  return result;
}

beforeEach(() => { s = createSeedState(); });

describe('requesting', () => {
  it("validates against the method's limits", () => {
    expect(D.validateDeposit(s, 10, 'bank')).toMatch(/minimum for Bank transfer is \$20/);
    expect(D.validateDeposit(s, 30000, 'bank')).toMatch(/maximum for Bank transfer/);
    expect(D.validateDeposit(s, 20.001, 'bank')).toMatch(/decimal/);
    expect(D.validateDeposit(s, 100, 'bank')).toBeNull();
    expect(D.validateDeposit(s, 100, 'crypto')).toMatch(/available deposit method/);
    expect(D.validateDeposit(s, 100, 'nope')).toMatch(/available deposit method/);
  });

  it('records a pending deposit with a reference that does not count yet', () => {
    const { id } = accept(D.requestDeposit(s, 200, 'mobile', now));
    expect(tx(id!)).toMatchObject({ type: 'Deposit', status: 'Pending', amount: 200, method: 'mobile' });
    expect(tx(id!).reference).toMatch(/^ARC-\d+$/);
    expect(mine()).toMatchObject({ deposit: 441.5, pendingDeposits: 200 });
  });

  it('alerts staff and flags high-value deposits', () => {
    accept(D.requestDeposit(s, 200, 'bank', now));
    expect(s.staffFeed[0]).toMatchObject({ kind: 'deposit', highlight: false, href: '/admin/deposits' });
    accept(D.requestDeposit(s, 1000, 'bank', now));
    expect(s.staffFeed[0]).toMatchObject({ highlight: true });
    expect(s.staffFeed[0]!.title).toMatch(/High-value deposit/);
  });

  it('limits how many deposits can wait at once', () => {
    for (let i = 0; i < D.MAX_PENDING_DEPOSITS; i++) accept(D.requestDeposit(s, 50, 'bank', now));
    expect(D.requestDeposit(s, 50, 'bank', now).ok).toBe(false);
  });

  it('lets the applicant cancel a pending deposit', () => {
    const { id } = accept(D.requestDeposit(s, 200, 'bank', now));
    accept(D.cancelDeposit(s, id!, now));
    expect(tx(id!).status).toBe('Cancelled');
    expect(mine().pendingDeposits).toBe(0);
    expect(D.confirmDeposit(s, id!, FINANCE, now).ok).toBe(false);
  });

  it('cannot cancel another applicant’s deposit', () => {
    expect(D.cancelDeposit(s, 'TX-82090', now).ok).toBe(false);
  });
});

describe('finance processing', () => {
  it('confirming credits the deposit balance and notifies the applicant', () => {
    const { id } = accept(D.requestDeposit(s, 200, 'bank', now));
    accept(D.confirmDeposit(s, id!, FINANCE, now));
    expect(tx(id!)).toMatchObject({ status: 'Completed', processedBy: FINANCE });
    expect(mine()).toMatchObject({ deposit: 641.5, pendingDeposits: 0 });
    expect(N.ownNotifications(s)[0]).toMatchObject({ title: 'Deposit received', href: '/deposits' });
  });

  it('rejecting needs a reason and leaves the balance alone', () => {
    const { id } = accept(D.requestDeposit(s, 200, 'bank', now));
    expect(D.rejectDeposit(s, id!, 'no', FINANCE, now).ok).toBe(false);
    accept(D.rejectDeposit(s, id!, 'No transfer with this reference arrived.', FINANCE, now));
    expect(tx(id!)).toMatchObject({ status: 'Failed', failureReason: 'No transfer with this reference arrived.' });
    expect(mine()).toMatchObject({ deposit: 441.5, pendingDeposits: 0 });
    expect(N.ownNotifications(s)[0]!.title).toBe('Deposit not credited');
  });

  it('processes each deposit once', () => {
    accept(D.confirmDeposit(s, 'TX-82090', FINANCE, now));
    const again = D.rejectDeposit(s, 'TX-82090', 'Changed my mind about it.', FINANCE, now);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/already confirmed/);
  });

  it('lists pending oldest first, then processed', () => {
    const { id } = accept(D.requestDeposit(s, 200, 'bank', now));
    expect(D.depositQueue(s).map(t => t.id).slice(0, 2)).toEqual(['TX-82090', id]);
    expect(D.pendingDepositTotal(s)).toBe(1700);
  });
});

describe('staff feed', () => {
  it('tracks unread and marks read', () => {
    expect(A.staffUnread(s)).toBe(3);
    accept(A.markStaffEventRead(s, 'FD-4'));
    expect(A.staffUnread(s)).toBe(2);
    accept(A.markAllStaffEventsRead(s));
    expect(A.staffUnread(s)).toBe(0);
    expect(A.markStaffEventRead(s, 'FD-missing').ok).toBe(false);
  });

  it('logs application submissions', () => {
    const draft = s.applications.find(a => a.id === 'APP-2101')!;
    const grant = s.grants.find(g => g.id === 'green')!;
    accept(R.submitApplication(s, 'green', { ...draft, purpose: 'Replace the kiln with an efficient electric model.', checklist: grant.requirements }, now, 'APP-2101'));
    expect(s.staffFeed[0]).toMatchObject({ kind: 'application', title: 'New application APP-2101', href: '/admin/applications' });
  });
});
