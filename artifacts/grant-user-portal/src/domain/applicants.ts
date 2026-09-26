import type { AccountControls, DemoState, Tier } from './model';
import { CURRENT_APPLICANT_ID } from './seed';

// One view of every applicant, whether their profile lives in `profile` (the
// demo user) or `otherApplicants`, joined with the staff-managed account controls.

export type ApplicantRecord = {
  id: string;
  name: string;
  email: string;
  sector: string;
  country: string;
  joined: string;
  tier: Tier;
  identityVerified: boolean;
  /** True for the applicant-portal demo user. */
  current: boolean;
  account: AccountControls;
};

const DEFAULT_ACCOUNT: AccountControls = {
  status: 'Active', passwordResetRequired: false, twoFactorResetRequired: false,
  kyc: { status: 'Not submitted' }, signals: { ipCountry: 'Unknown', sharedDeviceWith: [] },
};

export const accountOf = (state: DemoState, applicantId: string): AccountControls => state.accounts[applicantId] ?? DEFAULT_ACCOUNT;

export function applicantRecords(state: DemoState): ApplicantRecord[] {
  const p = state.profile;
  const me: ApplicantRecord = { id: CURRENT_APPLICANT_ID, name: p.name, email: p.email, sector: p.sector, country: p.country, joined: p.joined, tier: p.tier, identityVerified: p.identityVerified, current: true, account: accountOf(state, CURRENT_APPLICANT_ID) };
  return [me, ...state.otherApplicants.map(o => ({ id: o.id, name: o.name, email: o.email, sector: o.sector, country: o.country, joined: o.joined, tier: o.tier, identityVerified: o.verified, current: false, account: accountOf(state, o.id) }))];
}

export const findApplicant = (state: DemoState, applicantId: string) => applicantRecords(state).find(a => a.id === applicantId);

/** Writes tier / verification to wherever that applicant's profile lives. */
export function patchApplicant(state: DemoState, applicantId: string, patch: { tier?: Tier; identityVerified?: boolean }): DemoState {
  if (applicantId === CURRENT_APPLICANT_ID) return { ...state, profile: { ...state.profile, ...patch } };
  return {
    ...state,
    otherApplicants: state.otherApplicants.map(o => o.id !== applicantId ? o : {
      ...o, ...(patch.tier !== undefined ? { tier: patch.tier } : {}), ...(patch.identityVerified !== undefined ? { verified: patch.identityVerified } : {}),
    }),
  };
}

export function patchAccount(state: DemoState, applicantId: string, patch: Partial<AccountControls>): DemoState {
  return { ...state, accounts: { ...state.accounts, [applicantId]: { ...accountOf(state, applicantId), ...patch } } };
}

/** Why the demo applicant can't act right now because staff locked the account, or null. */
export function accountLockReason(state: DemoState): string | null {
  const account = accountOf(state, CURRENT_APPLICANT_ID);
  return account.status === 'Locked' ? `Your account is locked by the grant team${account.lockReason ? `: ${account.lockReason}` : ''}. Contact support to restore access.` : null;
}
