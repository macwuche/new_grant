import type { Application, ApplicationStatus, DemoState, Result, Transaction } from './model';
import { canTransition, fail, findGrant, nextIds, roundCents } from './rules';
import { CURRENT_APPLICANT_ID } from './seed';
import { notify } from './notifications';

// Staff review rules. Like ./rules, these are pure so they can move behind an
// authorized API later. There is NO staff authorization today: whoever opens
// /admin in this browser acts as the demo reviewer.

export const MIN_MESSAGE_LENGTH = 10;
export const MAX_NOTE_LENGTH = 1000;

/** Drafts belong to the applicant alone and never appear in the review queue. */
export const reviewQueue = (state: DemoState) => state.applications.filter(a => a.status !== 'Draft');

/** Oldest submission first, so nothing waits indefinitely. */
export const awaitingAction = (state: DemoState) => reviewQueue(state)
  .filter(a => a.status === 'Submitted' || a.status === 'Under review')
  .sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));

export function applicantName(state: DemoState, applicantId: string): string {
  if (applicantId === CURRENT_APPLICANT_ID) return state.profile.name;
  return state.otherApplicants.find(p => p.id === applicantId)?.name ?? 'Unknown applicant';
}

export type ProgramBudget = { budget: number; awarded: number; remaining: number };

export function programBudget(state: DemoState, grantId: string): ProgramBudget {
  const grant = findGrant(state, grantId);
  const awarded = roundCents(state.applications.filter(a => a.grantId === grantId && a.status === 'Approved').reduce((sum, a) => sum + (a.awardedAmount ?? 0), 0));
  const budget = grant?.budget ?? 0;
  return { budget, awarded, remaining: roundCents(budget - awarded) };
}

type Guard = { ok: true; app: Application } | { ok: false; result: Result };

/**
 * Loads the record and rejects stale actions: `expectedVersion` is the
 * `updatedAt` the reviewer was looking at. If the record changed since (the
 * applicant resubmitted, or another tab acted), the reviewer must re-read it.
 */
function guard(state: DemoState, appId: string, expectedVersion: string, to: ApplicationStatus | null): Guard {
  const app = state.applications.find(a => a.id === appId);
  if (!app || app.status === 'Draft') return { ok: false, result: fail('That application is not in the review queue.') };
  if (app.updatedAt !== expectedVersion) return { ok: false, result: fail('This application changed since you opened it. Review the latest version and try again.') };
  if (to && !canTransition(app.status, to)) return { ok: false, result: fail(`An application that is ${app.status.toLowerCase()} can't move to ${to.toLowerCase()}.`) };
  return { ok: true, app };
}

const NOTIFICATION_TITLES: Partial<Record<ApplicationStatus, string>> = {
  'Under review': 'is under review',
  'Changes requested': 'needs changes',
  Approved: 'was approved',
  Declined: 'was declined',
};

/** Applies a reviewer transition, records history, and notifies the applicant with the same note. */
function transition(state: DemoState, app: Application, to: ApplicationStatus, reviewer: string, note: string, now: Date, extra: Partial<Application> = {}): DemoState {
  const at = now.toISOString();
  const updated: Application = { ...app, ...extra, status: to, updatedAt: at, reviewer, history: [...app.history, { status: to, at, actor: 'Reviewer', note }] };
  const next = { ...state, applications: state.applications.map(a => a.id === app.id ? updated : a) };
  const title = `${findGrant(state, app.grantId)?.name ?? 'Your application'} ${NOTIFICATION_TITLES[to] ?? `is ${to.toLowerCase()}`}`;
  return notify(next, app.applicantId, title, note, `/applications/${app.id}`, now);
}

export function startReview(state: DemoState, appId: string, expectedVersion: string, reviewer: string, now: Date): Result {
  const g = guard(state, appId, expectedVersion, 'Under review');
  if (!g.ok) return g.result;
  return { ok: true, id: appId, message: `${appId} moved to under review and assigned to you.`, state: transition(state, g.app, 'Under review', reviewer, 'A reviewer has started reviewing your application.', now) };
}

export function requestChanges(state: DemoState, appId: string, expectedVersion: string, message: string, reviewer: string, now: Date): Result {
  const text = message.trim();
  if (text.length < MIN_MESSAGE_LENGTH) return fail('Tell the applicant what to change.', { message: `Write at least ${MIN_MESSAGE_LENGTH} characters; the applicant sees this message.` });
  const g = guard(state, appId, expectedVersion, 'Changes requested');
  if (!g.ok) return g.result;
  return { ok: true, id: appId, message: `Changes requested on ${appId}. The applicant can edit and resubmit.`, state: transition(state, g.app, 'Changes requested', reviewer, text, now) };
}

export function declineApplication(state: DemoState, appId: string, expectedVersion: string, reason: string, reviewer: string, now: Date): Result {
  const text = reason.trim();
  if (text.length < MIN_MESSAGE_LENGTH) return fail('A decline needs a reason.', { reason: `Write at least ${MIN_MESSAGE_LENGTH} characters; the applicant sees this reason.` });
  const g = guard(state, appId, expectedVersion, 'Declined');
  if (!g.ok) return g.result;
  return { ok: true, id: appId, message: `${appId} declined.`, state: transition(state, g.app, 'Declined', reviewer, `Declined: ${text}`, now) };
}

export function validateAward(state: DemoState, app: Application, amount: number): string | null {
  const grant = findGrant(state, app.grantId);
  if (!grant) return 'This grant program no longer exists.';
  if (!Number.isFinite(amount) || amount <= 0) return 'Enter the amount to award.';
  if (roundCents(amount) !== amount) return 'Use at most two decimal places.';
  if (amount > app.requestedAmount) return `The award can't exceed the $${app.requestedAmount.toLocaleString('en-US')} requested.`;
  if (amount > grant.maxFunding) return `The award can't exceed this program's $${grant.maxFunding.toLocaleString('en-US')} ceiling.`;
  const { remaining } = programBudget(state, app.grantId);
  if (amount > remaining) return `Only $${remaining.toLocaleString('en-US', { minimumFractionDigits: 2 })} remains in the ${grant.name} budget.`;
  return null;
}

/** Approves and credits the award to the applicant's grant balance in the same step. */
export function approveApplication(state: DemoState, appId: string, expectedVersion: string, awardAmount: number, reviewer: string, now: Date): Result {
  const g = guard(state, appId, expectedVersion, 'Approved');
  if (!g.ok) return g.result;
  const error = validateAward(state, g.app, awardAmount);
  if (error) return fail(error, { award: error });
  const grant = findGrant(state, g.app.grantId)!;
  const amountText = `$${awardAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const partial = awardAmount < g.app.requestedAmount;
  const note = `Approved for ${amountText}${partial ? ` (of $${g.app.requestedAmount.toLocaleString('en-US')} requested)` : ''}. The award has been added to your grant balance.`;
  const approved = transition(state, g.app, 'Approved', reviewer, note, now, { awardedAmount: awardAmount });
  const ids = nextIds(approved);
  const credit: Transaction = { id: ids.tx, applicantId: g.app.applicantId, type: 'Grant', description: `${grant.name} award (${appId})`, amount: awardAmount, status: 'Completed', createdAt: now.toISOString() };
  return { ok: true, id: appId, message: `${appId} approved for ${amountText}. Award credited to the applicant's grant balance.`, state: { ...approved, nextId: ids.nextId, transactions: [credit, ...approved.transactions] } };
}

/** Internal notes don't change the record's version, so they never invalidate a reviewer's open decision. */
export function addInternalNote(state: DemoState, appId: string, text: string, reviewer: string, now: Date): Result {
  const body = text.trim();
  if (!body) return fail('Write a note first.', { note: 'Write a note first.' });
  if (body.length > MAX_NOTE_LENGTH) return fail('Note is too long.', { note: `Keep notes under ${MAX_NOTE_LENGTH} characters.` });
  const app = state.applications.find(a => a.id === appId);
  if (!app || app.status === 'Draft') return fail('That application is not in the review queue.');
  const updated = { ...app, internalNotes: [...app.internalNotes, { at: now.toISOString(), author: reviewer, text: body }] };
  return { ok: true, id: appId, message: 'Internal note added.', state: { ...state, applications: state.applications.map(a => a.id === appId ? updated : a) } };
}
