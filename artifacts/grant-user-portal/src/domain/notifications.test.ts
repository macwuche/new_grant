import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result } from './model';
import * as N from './notifications';
import * as P from './payouts';
import * as V from './review';
import { CURRENT_APPLICANT_ID, createSeedState } from './seed';

const now = new Date('2026-09-25T12:00:00Z');
const REVIEWER = 'Avery Taylor';

let s: DemoState;
const version = (id: string) => s.applications.find(a => a.id === id)!.updatedAt;
const newest = () => N.ownNotifications(s)[0]!;
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  s = result.state;
  return result;
}

beforeEach(() => { s = createSeedState(); });

describe('created by review decisions', () => {
  it('notifies the applicant when changes are requested, with the reviewer message', () => {
    accept(V.requestChanges(s, 'APP-2048', version('APP-2048'), 'Please attach a clearer bank statement.', REVIEWER, now));
    expect(newest()).toMatchObject({ title: 'Business Momentum needs changes', body: 'Please attach a clearer bank statement.', href: '/applications/APP-2048', read: false });
  });

  it('notifies on approval with the award', () => {
    accept(V.approveApplication(s, 'APP-2048', version('APP-2048'), 7800, REVIEWER, now));
    expect(newest().title).toBe('Business Momentum was approved');
    expect(newest().body).toMatch(/\$7,800\.00/);
  });

  it('notifies the owning applicant only', () => {
    const before = N.ownNotifications(s).length;
    accept(V.startReview(s, 'APP-2050', version('APP-2050'), REVIEWER, now));
    expect(N.ownNotifications(s)).toHaveLength(before);
    expect(s.notifications.find(n => n.applicantId === 'APL-1045')?.title).toBe('Green Transition is under review');
  });

  it('does not notify when a decision is rejected', () => {
    const count = s.notifications.length;
    expect(V.declineApplication(s, 'APP-2048', version('APP-2048'), 'no', REVIEWER, now).ok).toBe(false);
    expect(s.notifications).toHaveLength(count);
  });

  it('does not notify for staff-only internal notes', () => {
    const count = s.notifications.length;
    accept(V.addInternalNote(s, 'APP-2048', 'Looks fine.', REVIEWER, now));
    expect(s.notifications).toHaveLength(count);
  });
});

describe('created by payouts', () => {
  it('notifies when a payout is sent or fails', () => {
    accept(P.markPayoutFailed(s, 'TX-84077', 'Account number did not match.', 'Jordan Lee', now));
    expect(newest()).toMatchObject({ title: 'Payout failed', href: '/withdrawals' });
    expect(newest().body).toMatch(/Account number did not match\..*\$125\.00 is back/);
  });
});

describe('read state', () => {
  it('counts and clears unread for the signed-in applicant', () => {
    expect(N.unreadCount(s)).toBe(1);
    accept(V.requestChanges(s, 'APP-2048', version('APP-2048'), 'Please clarify the timeline.', REVIEWER, now));
    expect(N.unreadCount(s)).toBe(2);
    accept(N.markNotificationRead(s, newest().id));
    expect(N.unreadCount(s)).toBe(1);
    accept(N.markAllNotificationsRead(s));
    expect(N.unreadCount(s)).toBe(0);
  });

  it('cannot mark another applicant’s notification', () => {
    accept(V.startReview(s, 'APP-2050', version('APP-2050'), REVIEWER, now));
    const theirs = s.notifications.find(n => n.applicantId !== CURRENT_APPLICANT_ID)!;
    expect(N.markNotificationRead(s, theirs.id).ok).toBe(false);
  });

  it('lists newest first with unique ids', () => {
    accept(V.requestChanges(s, 'APP-2048', version('APP-2048'), 'Please clarify the timeline.', REVIEWER, now));
    const list = N.ownNotifications(s);
    expect(list[0]!.at >= list[1]!.at).toBe(true);
    const ids = s.notifications.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
