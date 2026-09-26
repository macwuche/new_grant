import type { DemoState, Notification, Result } from './model';
import { fail, nextIds } from './rules';
import { CURRENT_APPLICANT_ID } from './seed';

// In-app notifications. Review, payout, and program rules call `notify` in the
// same step as the change they describe, so a notification never exists for a
// change that didn't happen (and vice versa). Email delivery is not connected.

export function notify(state: DemoState, applicantId: string, title: string, body: string, href: string, now: Date): DemoState {
  const ids = nextIds(state);
  const notification: Notification = { id: ids.notification, applicantId, at: now.toISOString(), title, body, href, read: false };
  return { ...state, nextId: ids.nextId, notifications: [notification, ...state.notifications] };
}

/** The signed-in demo applicant's notifications, newest first. */
export const ownNotifications = (state: DemoState) => state.notifications
  .filter(n => n.applicantId === CURRENT_APPLICANT_ID)
  .sort((a, b) => b.at.localeCompare(a.at));

export const unreadCount = (state: DemoState) => ownNotifications(state).filter(n => !n.read).length;

export function markNotificationRead(state: DemoState, id: string): Result {
  const target = state.notifications.find(n => n.id === id && n.applicantId === CURRENT_APPLICANT_ID);
  if (!target) return fail('That notification could not be found.');
  if (target.read) return { ok: true, message: 'Already read.', state };
  return { ok: true, message: 'Marked as read.', state: { ...state, notifications: state.notifications.map(n => n.id === id ? { ...n, read: true } : n) } };
}

export function markAllNotificationsRead(state: DemoState): Result {
  const count = unreadCount(state);
  if (!count) return { ok: true, message: 'No unread notifications.', state };
  return {
    ok: true, message: `${count} notification${count === 1 ? '' : 's'} marked as read.`,
    state: { ...state, notifications: state.notifications.map(n => n.applicantId === CURRENT_APPLICANT_ID ? { ...n, read: true } : n) },
  };
}
