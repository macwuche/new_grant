import { describe, expect, it } from 'vitest';
import { closeProgram } from './programs';
import { createSeedState } from './seed';
import { lockAccount, submitKyc } from './accounts';
import { CURRENT_APPLICANT_ID } from './seed';
import { applicantState, readApplicantSlot, serverState } from './server';

describe('serverState', () => {
  it('holds only what the server loaded, so no demo record reaches a server decision', () => {
    const grants = createSeedState().grants;
    const state = serverState({ grants });
    expect(state.grants).toBe(grants);
    expect([state.applications, state.notifications, state.transactions, state.staffFeed, state.otherApplicants, state.audit, state.staff]).toEqual([[], [], [], [], [], [], []]);
    expect(state.accounts).toEqual({});
    // The browser seed has drafts for this program; on the server there are none to notify.
    const result = closeProgram(state, 'green', grants.find(g => g.id === 'green')!.updatedAt, 'Sam Rivera', new Date('2026-09-26T12:00:00Z'));
    expect(result.ok && result.state.notifications).toEqual([]);
  });

  it('runs account rules for a real applicant in the current-applicant slot and maps their id back', () => {
    const applicant = {
      id: 'real-uuid',
      profile: { name: 'Maya Okafor', email: 'maya@example.com', phone: '', address: '', sector: 'Retail', country: 'Kenya', joined: '2026-09-26', tier: 1 as const, identityVerified: false },
      account: { status: 'Active' as const, passwordResetRequired: false, twoFactorResetRequired: false, kyc: { status: 'Not submitted' as const }, signals: { ipCountry: 'Unknown', sharedDeviceWith: [] } },
    };
    const now = new Date('2026-09-26T12:00:00Z');
    const submitted = submitKyc(applicantState({}, applicant), { documentType: 'Passport', documentNumber: 'AB12345678', nameOnDocument: 'Maya Okafor' }, now);
    if (!submitted.ok) throw new Error(submitted.error);
    const locked = lockAccount(submitted.state, CURRENT_APPLICANT_ID, 'Checking a deposit pattern.', 'Riley Chen', now);
    if (!locked.ok) throw new Error(locked.error);
    expect(locked.message).toContain('Maya Okafor');
    const slot = readApplicantSlot(locked.state, 'real-uuid');
    expect(slot.account).toMatchObject({ status: 'Locked', lockedBy: 'Riley Chen', kyc: { status: 'Pending', documentLast4: '5678' } });
    expect(slot.notifications.every(n => n.applicantId === 'real-uuid')).toBe(true);
    expect(slot.profile).not.toHaveProperty('twoFactor');
  });
});
