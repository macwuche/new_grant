import type { AccountControls, AccountPermissions, DemoState, Tier } from './model';
import { CURRENT_APPLICANT_ID } from './seed';

// One view of every applicant, whether their profile lives in `profile` (the
// demo user) or `otherApplicants`, joined with the staff-managed account controls.

export type ApplicantRecord = {
  id: string;
  name: string;
  email: string;
  sector: string;
  country: string;
  /** Contact details staff see on the profile page (empty when unknown). */
  phone: string;
  address: string;
  /** ISO date, when given at sign-up. */
  birthDate?: string;
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
  const me: ApplicantRecord = { id: CURRENT_APPLICANT_ID, name: p.name, email: p.email, sector: p.sector, country: p.country, phone: p.phone, address: p.address, ...(p.birthDate ? { birthDate: p.birthDate } : {}), joined: p.joined, tier: p.tier, identityVerified: p.identityVerified, current: true, account: accountOf(state, CURRENT_APPLICANT_ID) };
  const others = state.otherApplicants.map(o => ({ id: o.id, name: o.name, email: o.email, sector: o.sector, country: o.country, phone: o.phone ?? '', address: o.address ?? '', ...(o.birthDate ? { birthDate: o.birthDate } : {}), joined: o.joined, tier: o.tier, identityVerified: o.verified, current: false, account: accountOf(state, o.id) }));
  return state.serverApplicants ? others : [me, ...others];
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

// ---------- Permissions staff switch per applicant ----------

export const DEFAULT_PERMISSIONS: AccountPermissions = { depositKyc: false, emailNotifications: true, cardApplications: true, grantApplications: true, clearBalanceForPayouts: false, payoutIdentityCheck: true, payoutTwoSignOffs: true };
/** Only the known switches: older saved data may still carry retired ones (e.g. `payoutKyc`, removed 3 Oct 2026; its
 * replacement `payoutIdentityCheck` has a new name so old `payoutKyc: false` values don't come back). */
export const knownPermissions = (stored: Partial<AccountPermissions> | null | undefined): AccountPermissions =>
  Object.fromEntries((Object.keys(DEFAULT_PERMISSIONS) as (keyof AccountPermissions)[]).map(k => [k, typeof stored?.[k] === 'boolean' ? stored[k] : DEFAULT_PERMISSIONS[k]])) as AccountPermissions;
export const permissionsOf = (state: DemoState, applicantId = CURRENT_APPLICANT_ID): AccountPermissions => knownPermissions(accountOf(state, applicantId).permissions);

/** Why the demo applicant can't do `what` because of a switch staff set, or null.
 * Payouts need a verified identity unless staff turn that off for the applicant (owner, 9 Oct 2026); applying for grants doesn't. */
export function permissionBlocker(state: DemoState, what: 'payout' | 'deposit' | 'card' | 'application'): string | null {
  const p = permissionsOf(state);
  if (what === 'payout' && p.payoutIdentityCheck && !state.profile.identityVerified) return 'Verify your identity (Settings → Identity check) before requesting a payout.';
  if (what === 'deposit' && p.depositKyc && !state.profile.identityVerified) return 'Verify your identity (Settings → Identity check) before adding funds.';
  if (what === 'card' && !p.cardApplications) return 'Card applications are turned off for your account. Contact support if you need a card.';
  if (what === 'application' && !p.grantApplications) return 'New grant applications are turned off for your account. Contact support to find out why.';
  return null;
}
