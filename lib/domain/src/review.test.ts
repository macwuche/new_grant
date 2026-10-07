import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result } from './model';
import * as R from './rules';
import * as V from './review';
import { CURRENT_APPLICANT_ID, createSeedState } from './seed';

const now = new Date('2026-09-25T12:00:00Z');
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const REVIEWER = 'Avery Taylor';

let s: DemoState;
const app = (id: string) => s.applications.find(a => a.id === id)!;
const version = (id: string) => app(id).updatedAt;
const mine = () => R.computeBalances(R.ownTransactions(s));
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  s = result.state;
  return result;
}

beforeEach(() => { s = createSeedState(); });

describe('queue', () => {
  it('never shows drafts to staff', () => {
    expect(V.reviewQueue(s).some(a => a.status === 'Draft')).toBe(false);
  });

  it('lists work awaiting action oldest first', () => {
    expect(V.awaitingAction(s).map(a => a.id)).toEqual(['APP-2048', 'APP-2049', 'APP-2051', 'APP-2050', 'APP-2047']);
  });
});

describe('transitions', () => {
  it('starts a review and assigns the reviewer', () => {
    accept(V.startReview(s, 'APP-2050', version('APP-2050'), REVIEWER, now));
    expect(app('APP-2050')).toMatchObject({ status: 'Under review', reviewer: REVIEWER });
    expect(app('APP-2050').history.at(-1)).toMatchObject({ status: 'Under review', actor: 'Reviewer' });
  });

  it('rejects decisions on a submitted (not yet reviewed) application', () => {
    expect(V.approveApplication(s, 'APP-2047', version('APP-2047'), 1000, REVIEWER, now).ok).toBe(false);
    expect(V.declineApplication(s, 'APP-2047', version('APP-2047'), 'Not a fit for this program.', REVIEWER, now).ok).toBe(false);
  });

  it('treats approved and declined as final', () => {
    accept(V.declineApplication(s, 'APP-2049', version('APP-2049'), 'Outside the program focus.', REVIEWER, now));
    expect(V.approveApplication(s, 'APP-2049', version('APP-2049'), 1000, REVIEWER, now).ok).toBe(false);
    expect(V.requestChanges(s, 'APP-2049', version('APP-2049'), 'Please add more detail.', REVIEWER, now).ok).toBe(false);
  });

  it('requires applicant-facing messages for declines and change requests', () => {
    expect(V.declineApplication(s, 'APP-2049', version('APP-2049'), 'no', REVIEWER, now).ok).toBe(false);
    expect(V.requestChanges(s, 'APP-2049', version('APP-2049'), '   ', REVIEWER, now).ok).toBe(false);
  });

  it('rejects actions against a stale version', () => {
    const result = V.startReview(s, 'APP-2047', '2020-01-01T00:00:00.000Z', REVIEWER, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/changed since you opened it/);
  });

  it('rejects actions on drafts', () => {
    expect(V.startReview(s, 'APP-2101', version('APP-2101'), REVIEWER, now).ok).toBe(false);
  });
});

describe('approval', () => {
  beforeEach(() => { accept(V.startReview(s, 'APP-2050', version('APP-2050'), REVIEWER, now)); });

  it('validates the award amount', () => {
    expect(V.approveApplication(s, 'APP-2050', version('APP-2050'), 0, REVIEWER, now).ok).toBe(false);
    expect(V.approveApplication(s, 'APP-2050', version('APP-2050'), 13000, REVIEWER, now).ok).toBe(false);
    expect(V.approveApplication(s, 'APP-2050', version('APP-2050'), 100.001, REVIEWER, now).ok).toBe(false);
  });

  it('credits the award to that applicant only and adds it to the plan’s total awarded', () => {
    accept(V.approveApplication(s, 'APP-2050', version('APP-2050'), 10000, REVIEWER, later(1)));
    expect(app('APP-2050').awardedAmount).toBe(10000);
    expect(s.transactions.find(t => t.applicantId === 'APL-1045' && t.type === 'Grant')).toMatchObject({ amount: 10000, status: 'Completed' });
    expect(s.transactions.find(t => t.applicantId === 'APL-1045' && t.type === 'Commission')).toMatchObject({ amount: -800, status: 'Completed' }); // green: 8%
    expect(mine().grant).toBe(4075);
    expect(V.programAwarded(s, 'green')).toBe(10000);
  });

  it('has no overall plan budget: approvals are limited only by the request and the plan maximum (owner, 7 Oct 2026)', () => {
    // Far more already awarded on the plan than any former budget.
    s = { ...s, applications: [...s.applications, { ...app('APP-2049'), id: 'APP-9000', status: 'Approved', awardedAmount: 10_000_000 }] };
    accept(V.approveApplication(s, 'APP-2049', version('APP-2049'), 5000, REVIEWER, now));
    expect(app('APP-2049').awardedAmount).toBe(5000);
    expect(V.validateAward(s, { ...app('APP-2049'), requestedAmount: 1_000_000 }, 999_999)).toMatch(/ceiling/);
  });
});

describe('changes requested loop', () => {
  it('reopens the application for the applicant and returns it to the queue on resubmit', () => {
    const opened = version('APP-2048');
    accept(V.requestChanges(s, 'APP-2048', opened, 'Please attach a clearer bank statement.', REVIEWER, later(1)));
    expect(app('APP-2048').status).toBe('Changes requested');
    expect(R.isEditable(app('APP-2048'))).toBe(true);
    expect(R.deleteDraft(s, 'APP-2048').ok).toBe(false);

    const staleVersion = version('APP-2048');
    accept(R.saveDraft(s, 'momentum', { ...app('APP-2048'), purpose: `${app('APP-2048').purpose} Statement attached.` }, later(2), 'APP-2048'));
    accept(R.submitApplication(s, 'momentum', app('APP-2048'), later(3), 'APP-2048'));
    expect(app('APP-2048').status).toBe('Submitted');
    expect(app('APP-2048').history.at(-1)!.note).toMatch(/resubmitted/);

    expect(V.startReview(s, 'APP-2048', staleVersion, REVIEWER, later(4)).ok).toBe(false);
    accept(V.startReview(s, 'APP-2048', version('APP-2048'), REVIEWER, later(4)));
    accept(V.approveApplication(s, 'APP-2048', version('APP-2048'), 6000, REVIEWER, later(5)));
    expect(app('APP-2048').history.at(-1)!.note).toMatch(/of \$7,800 requested/);
    expect(mine().grant).toBe(10075);
  });

  it('allows resubmission after the grant deadline', () => {
    accept(V.requestChanges(s, 'APP-2048', version('APP-2048'), 'Please clarify the timeline.', REVIEWER, now));
    accept(R.submitApplication(s, 'momentum', app('APP-2048'), new Date('2027-01-01'), 'APP-2048'));
    expect(app('APP-2048').status).toBe('Submitted');
  });
});

describe('internal notes', () => {
  it('adds staff notes without changing the record version', () => {
    const before = version('APP-2049');
    accept(V.addInternalNote(s, 'APP-2049', 'Checked references.', REVIEWER, now));
    expect(version('APP-2049')).toBe(before);
    expect(app('APP-2049').internalNotes.at(-1)).toMatchObject({ author: REVIEWER, text: 'Checked references.' });
  });

  it('rejects empty notes and notes on drafts', () => {
    expect(V.addInternalNote(s, 'APP-2049', '  ', REVIEWER, now).ok).toBe(false);
    expect(V.addInternalNote(s, 'APP-2101', 'hello', REVIEWER, now).ok).toBe(false);
  });
});

describe('names', () => {
  it('resolves the demo applicant and others', () => {
    expect(V.applicantName(s, CURRENT_APPLICANT_ID)).toBe('Alex Morgan');
    expect(V.applicantName(s, 'APL-1042')).toBe('Maya Okafor');
  });
});
