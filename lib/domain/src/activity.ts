import type { DemoState, Result, StaffEvent } from './model';
import { nextIds } from './core';
import { findApplicant } from './applicants';
import { assessRisk } from './risk';

// Staff activity feed: what applicants did that staff may need to act on.
// Applicant-side rules call `logStaff` in the same step as the change. One
// shared read state stands in for the (single) demo staff team.

export function logStaff(state: DemoState, event: Pick<StaffEvent, 'kind' | 'title' | 'body' | 'href'> & { highlight?: boolean }, now: Date): DemoState {
  const ids = nextIds(state);
  const entry: StaffEvent = { id: ids.feed, at: now.toISOString(), highlight: false, read: false, ...event };
  return { ...state, nextId: ids.nextId, staffFeed: [entry, ...state.staffFeed] };
}

/** Automated fraud alert: logs a highlighted staff event when an action pushes an applicant into high risk. */
export function alertIfHighRisk(before: DemoState, after: DemoState, applicantId: string, now: Date): DemoState {
  const was = assessRisk(before, applicantId, now);
  const risk = assessRisk(after, applicantId, now);
  if (risk.level !== 'High' || was.level === 'High') return after;
  const name = findApplicant(after, applicantId)?.name ?? applicantId;
  return logStaff(after, {
    kind: 'security', highlight: true, title: `Risk alert: ${name} scored ${risk.score}/100`,
    body: risk.factors.slice(0, 3).map(f => f.label).join(' · '), href: '/admin/security',
  }, now);
}

export const staffFeed = (state: DemoState) => [...state.staffFeed].sort((a, b) => b.at.localeCompare(a.at));
export const staffUnread = (state: DemoState) => state.staffFeed.filter(e => !e.read).length;

export function markStaffEventRead(state: DemoState, id: string): Result {
  if (!state.staffFeed.some(e => e.id === id)) return { ok: false, error: 'That activity item could not be found.' };
  return { ok: true, message: 'Marked as read.', state: { ...state, staffFeed: state.staffFeed.map(e => e.id === id ? { ...e, read: true } : e) } };
}

export function markAllStaffEventsRead(state: DemoState): Result {
  const count = staffUnread(state);
  return { ok: true, message: count ? `${count} item${count === 1 ? '' : 's'} marked as read.` : 'Nothing unread.', state: count ? { ...state, staffFeed: state.staffFeed.map(e => ({ ...e, read: true })) } : state };
}
