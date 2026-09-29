import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result } from './model';
import * as Ac from './accounts';
import { accountOf, applicantRecords, findApplicant } from './applicants';
import * as D from './deposits';
import * as M from './money';
import * as R from './rules';
import * as Risk from './risk';
import { createSeedState, CURRENT_APPLICANT_ID as ME } from './seed';

const now = new Date('2026-09-25T12:00:00Z');
let s: DemoState;
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error} ${JSON.stringify(result.fieldErrors ?? {})}`);
  s = result.state;
  return result;
}
const draft = () => s.applications.find(a => a.id === 'APP-2101')!;

beforeEach(() => { s = createSeedState(); });

describe('applicant directory', () => {
  it('joins every applicant with their account controls', () => {
    const all = applicantRecords(s);
    expect(all).toHaveLength(7);
    expect(all[0]).toMatchObject({ id: ME, current: true, tier: 2, country: 'United States', account: { status: 'Active', kyc: { status: 'Verified' } } });
    expect(findApplicant(s, 'APL-1043')).toMatchObject({ tier: 2, identityVerified: false, account: { kyc: { status: 'Pending' } } });
  });
});

describe('tier changes', () => {
  it('needs a reason, changes eligibility, and tells the applicant', () => {
    expect(Ac.setApplicantTier(s, ME, 3, 'x', now).ok).toBe(false);
    expect(Ac.setApplicantTier(s, ME, 2, 'Already there, no change.', now).ok).toBe(false);
    const community = R.findGrant(s, 'community')!;
    expect(R.checkEligibility(community, s.profile, R.ownApplications(s), now).eligible).toBe(false);
    accept(Ac.setApplicantTier(s, ME, 3, 'Registered nonprofit confirmed.', now));
    expect(R.checkEligibility(community, s.profile, R.ownApplications(s), now).eligible).toBe(true);
    expect(s.notifications[0]).toMatchObject({ applicantId: ME, title: 'Account upgraded to Tier 3' });
    accept(Ac.setApplicantTier(s, 'APL-1047', 1, 'Tier awarded in error.', now));
    expect(findApplicant(s, 'APL-1047')!.tier).toBe(1);
  });
});

describe('account lock', () => {
  it('blocks applying, deposits, payouts, and card changes until unlocked', () => {
    accept(Ac.lockAccount(s, ME, 'Suspected account takeover.', 'Riley Chen', now));
    expect(accountOf(s, ME)).toMatchObject({ status: 'Locked', lockedBy: 'Riley Chen' });
    expect(R.saveDraft(s, 'green', draft(), now, 'APP-2101').ok).toBe(false);
    expect(D.requestDeposit(s, 50, 'bank', now).ok).toBe(false);
    expect(M.payoutBlocker(s)).toMatch(/locked/);
    expect(M.requestPhysicalCard(s, { name: 'Alex Morgan', line1: '1 Main St', city: 'Austin', postalCode: '73301', country: 'United States' }, now).ok).toBe(false);
    expect(M.setCardLimit(s, 'virtual', 1000).ok).toBe(false);
    expect(M.requestWithdrawal(s, { amount: 50, method: 'mobile', details: s.savedPayoutDetails['mobile'] }, now).ok).toBe(false);
    accept(M.toggleCardFreeze(s)); // freezing is still allowed
    expect(M.toggleCardFreeze(s).ok).toBe(false); // unfreezing is not
    expect(D.cancelDeposit(s, 'TX-99999', now).ok).toBe(false);
    expect(Ac.lockAccount(s, ME, 'Suspected account takeover.', 'Riley Chen', now).ok).toBe(false);
    accept(Ac.unlockAccount(s, ME, now));
    expect(M.payoutBlocker(s)).toBeNull();
    expect(Ac.unlockAccount(s, ME, now).ok).toBe(false);
  });
});

describe('credential resets', () => {
  it('records the requirement, turns off two-step sign-in, and lets the applicant complete it', () => {
    accept(Ac.requireCredentialReset(s, ME, 'twoFactor', now));
    expect(s.profile.twoFactor).toBe(false);
    expect(Ac.requireCredentialReset(s, ME, 'twoFactor', now).ok).toBe(false);
    accept(Ac.requireCredentialReset(s, ME, 'password', now));
    expect(accountOf(s, ME)).toMatchObject({ passwordResetRequired: true, twoFactorResetRequired: true });
    accept(Ac.completeCredentialReset(s, 'twoFactor'));
    accept(Ac.completeCredentialReset(s, 'password'));
    expect(s.profile.twoFactor).toBe(true);
    expect(Ac.completeCredentialReset(s, 'password').ok).toBe(false);
  });
});

describe('identity verification', () => {
  const input: Ac.KycInput = { documentType: 'Passport', documentNumber: 'X12 345 678', nameOnDocument: 'Alex Morgan' };

  it('runs submit → reject → resubmit → approve, keeping only the last four characters', () => {
    expect(Ac.submitKyc(s, input, now).ok).toBe(false); // already verified
    accept(Ac.requestReverification(s, ME, 'Your passport on file has expired.', 'Riley Chen', now));
    expect(s.profile.identityVerified).toBe(false);
    expect(R.checkEligibility(R.findGrant(s, 'creative')!, s.profile, R.ownApplications(s), now).reasons).toContain('Identity verification is required before applying.');
    expect(Object.keys(Ac.validateKyc({ ...input, documentNumber: '12', nameOnDocument: '' })).sort()).toEqual(['documentNumber', 'nameOnDocument']);
    accept(Ac.submitKyc(s, input, now));
    expect(accountOf(s, ME).kyc).toMatchObject({ status: 'Pending', documentLast4: '5678' });
    expect(JSON.stringify(s)).not.toContain('X12345678');
    expect(s.staffFeed[0]).toMatchObject({ kind: 'account', title: 'Identity check submitted' });
    expect(Ac.submitKyc(s, input, now).ok).toBe(false);
    accept(Ac.rejectKyc(s, ME, 'The photo is too blurry to read.', 'Riley Chen', now));
    expect(accountOf(s, ME).kyc.status).toBe('Rejected');
    accept(Ac.submitKyc(s, input, now));
    accept(Ac.approveKyc(s, ME, 'Riley Chen', now));
    expect(s.profile.identityVerified).toBe(true);
    expect(accountOf(s, ME).kyc).toMatchObject({ status: 'Verified', reviewedBy: 'Riley Chen' });
    expect(Ac.approveKyc(s, ME, 'Riley Chen', now).ok).toBe(false);
  });

  it('approves other applicants in the queue', () => {
    accept(Ac.approveKyc(s, 'APL-1046', 'Riley Chen', now));
    expect(findApplicant(s, 'APL-1046')!.identityVerified).toBe(true);
  });
});

describe('risk scoring', () => {
  it('explains each score with weighted factors', () => {
    expect(Risk.assessRisk(s, ME, now)).toEqual({ score: 0, level: 'Low', factors: [] });
    const elias = Risk.assessRisk(s, 'APL-1043', now);
    expect(elias.level).toBe('High');
    expect(elias.factors.map(f => f.label)).toEqual(expect.arrayContaining(['Identity not verified', expect.stringMatching(/Device shared/), expect.stringMatching(/Name on ID/)]));
    expect(Risk.assessRisk(s, 'APL-1042', now)).toMatchObject({ level: 'Medium', score: 30 });
    expect(Risk.assessRisk(s, 'APL-1043', now).score).toBeLessThanOrEqual(100);
  });

  it('reacts to velocity and changed payout details, and alerts staff when an applicant turns high risk', () => {
    s = { ...s, accounts: { ...s.accounts, [ME]: { ...s.accounts[ME]!, signals: { ipCountry: 'Brazil', sharedDeviceWith: [] } } } };
    accept(M.requestWithdrawal(s, { amount: 20, method: 'bank', details: { ...s.savedPayoutDetails['bank'], 'account-number': '7700112233' } }, now));
    // Changing details takes a request, and with the seeded one that's 2 payout requests in 7 days.
    expect(Risk.assessRisk(s, ME, now)).toMatchObject({ score: 50, level: 'Medium' });
    expect(Risk.assessRisk(s, ME, now).factors.map(f => f.label)).toEqual(expect.arrayContaining(['Payout details changed in the last 7 days', '2 payout requests in 7 days']));
    for (let i = 0; i < 3; i++) accept(D.requestDeposit(s, 1200, 'bank', now));
    expect(Risk.assessRisk(s, ME, now)).toMatchObject({ score: 75, level: 'High' });
    accept(M.requestWithdrawal(s, { amount: 20, method: 'bank', details: s.savedPayoutDetails['bank'] }, now)); // stays high: no second alert
    const alerts = s.staffFeed.filter(e => e.kind === 'security' && e.title.startsWith('Risk alert'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ highlight: true, href: '/admin/security' });
  });
});
