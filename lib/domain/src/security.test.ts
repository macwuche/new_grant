import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result } from './model';
import * as M from './money';
import * as P from './payouts';
import * as Rv from './review';
import * as Sec from './security';
import * as Risk from './risk';
import { createSeedState, CURRENT_APPLICANT_ID } from './seed';

const now = new Date('2026-09-25T12:00:00Z');
let s: DemoState;
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  s = result.state;
  return result;
}
const tx = (id: string) => s.transactions.find(t => t.id === id)!;
const app = (id: string) => s.applications.find(a => a.id === id)!;

beforeEach(() => { s = createSeedState(); });

describe('dual-control payouts', () => {
  it('flags payouts at or above the threshold when requested', () => {
    const small = accept(M.requestWithdrawal(s, { amount: 100, method: 'bank', details: s.savedPayoutDetails['bank'] }, now)).id!;
    const large = accept(M.requestWithdrawal(s, { amount: 2500, method: 'bank', details: s.savedPayoutDetails['bank'] }, now)).id!;
    expect(tx(small).dualControl).toBeUndefined();
    expect(tx(large).dualControl).toBe(true);
    expect(s.staffFeed[0]).toMatchObject({ highlight: true, title: expect.stringMatching(/two sign-offs/) });
  });

  it('needs a release approval from a different person before it can be paid', () => {
    const id = accept(M.requestWithdrawal(s, { amount: 3000, method: 'bank', details: s.savedPayoutDetails['bank'] }, now)).id!;
    expect(P.markPayoutPaid(s, id, 'Jordan Lee', now).ok).toBe(false);
    accept(P.approvePayoutRelease(s, id, 'Riley Chen', now));
    expect(P.approvePayoutRelease(s, id, 'Sam Rivera', now).ok).toBe(false);
    const same = P.markPayoutPaid(s, id, 'Riley Chen', now);
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error).toMatch(/different staff member/);
    accept(P.markPayoutPaid(s, id, 'Jordan Lee', now));
    expect(tx(id)).toMatchObject({ status: 'Completed', releaseApproval: { by: 'Riley Chen' } });
  });

  it("keeps the requirement if finance raises the threshold afterwards, and doesn't ask for small ones", () => {
    const id = accept(M.requestWithdrawal(s, { amount: 3000, method: 'bank', details: s.savedPayoutDetails['bank'] }, now)).id!;
    s = { ...s, treasury: { ...s.treasury, dualControlThreshold: 10000 } };
    expect(P.markPayoutPaid(s, id, 'Jordan Lee', now).ok).toBe(false);
    expect(P.approvePayoutRelease(s, 'TX-84077', 'Riley Chen', now).ok).toBe(false);
    accept(P.markPayoutPaid(s, 'TX-84077', 'Jordan Lee', now));
  });
});

describe('system lockdown', () => {
  it('requires a reason and freezes payouts until lifted', () => {
    expect(Sec.startLockdown(s, 'short', 'Sam Rivera', now).ok).toBe(false);
    const result = accept(Sec.startLockdown(s, 'Suspicious login activity on finance accounts.', 'Sam Rivera', now));
    expect(result.message).toMatch(/1 pending payout/);
    expect(s.notifications[0]).toMatchObject({ applicantId: CURRENT_APPLICANT_ID, title: 'Payouts paused' });
    expect(M.payoutBlocker(s)).toMatch(/paused/);
    expect(M.requestWithdrawal(s, { amount: 50, method: 'bank', details: s.savedPayoutDetails['bank'] }, now).ok).toBe(false);
    expect(P.markPayoutPaid(s, 'TX-84077', 'Jordan Lee', now).ok).toBe(false);
    accept(P.markPayoutFailed(s, 'TX-84077', 'Returned during the security check.', 'Jordan Lee', now));
    expect(Sec.startLockdown(s, 'Again, for another reason.', 'Sam Rivera', now).ok).toBe(false);
    accept(Sec.endLockdown(s, 'Sam Rivera', now));
    expect(M.payoutBlocker(s)).toBeNull();
    expect(Sec.endLockdown(s, 'Sam Rivera', now).ok).toBe(false);
  });
});

describe('escalation to security', () => {
  it('blocks approval until compliance clears it, and keeps a note trail', () => {
    expect(Rv.escalateApplication(s, 'APP-2051', 'short', 'Avery Taylor', now).ok).toBe(false);
    accept(Rv.escalateApplication(s, 'APP-2051', 'Bank statement looks edited.', 'Avery Taylor', now));
    expect(Rv.openEscalations(s).map(a => a.id)).toEqual(['APP-2051']);
    expect(Rv.escalateApplication(s, 'APP-2051', 'Bank statement looks edited.', 'Avery Taylor', now).ok).toBe(false);
    const blocked = Rv.approveApplication(s, 'APP-2051', app('APP-2051').updatedAt, 1000, 'Avery Taylor', now);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/escalated/);
    accept(Rv.clearEscalation(s, 'APP-2051', 'Statement verified with the bank.', 'Riley Chen', now));
    expect(app('APP-2051').internalNotes.map(n => n.text)).toEqual(expect.arrayContaining(['Escalated to security: Bank statement looks edited.', 'Security check cleared: Statement verified with the bank.']));
    accept(Rv.approveApplication(s, 'APP-2051', app('APP-2051').updatedAt, 1000, 'Avery Taylor', now));
  });

  it("isn't shown to the applicant and can't be applied to final decisions", () => {
    const before = s.notifications.length;
    accept(Rv.escalateApplication(s, 'APP-2048', 'Registration number format is unusual.', 'Avery Taylor', now));
    expect(s.notifications.length).toBe(before);
    expect(Rv.escalateApplication(s, 'APP-1932', 'Too late for this one.', 'Avery Taylor', now).ok).toBe(false);
    expect(Rv.clearEscalation(s, 'APP-2050', 'Nothing to clear here.', 'Riley Chen', now).ok).toBe(false);
  });

  it('raises the applicant risk score while open', () => {
    const before = Risk.assessRisk(s, CURRENT_APPLICANT_ID, now).score;
    accept(Rv.escalateApplication(s, 'APP-2048', 'Registration number format is unusual.', 'Avery Taylor', now));
    expect(Risk.assessRisk(s, CURRENT_APPLICANT_ID, now).score).toBe(before + 10);
  });
});
