import type { AccountControls, Application, DemoState, Notification, Profile } from './model';
import { createSeedState, CURRENT_APPLICANT_ID } from './seed';

/**
 * A rule-ready state holding only the records the server has loaded; every
 * other collection is empty, so no demo data can leak into a server decision.
 * Rules read and return whole states, so the server passes in what it loaded
 * and stores what changed.
 */
export function serverState(loaded: Partial<Pick<DemoState, 'grants' | 'applications' | 'notifications' | 'nextId'>>): DemoState {
  const base = createSeedState();
  return {
    ...base,
    grants: [], applications: [], notifications: [], transactions: [], staffFeed: [], otherApplicants: [],
    accounts: {}, staff: [], actingStaffId: '', audit: [], payoutDestinations: {}, lockdown: null,
    ...loaded,
  };
}

/** One real applicant as the server stores them. */
export type SlotApplicant = {
  id: string;
  profile: Omit<Profile, 'twoFactor'>;
  account: AccountControls;
};

/**
 * The rules were written for one "current applicant" (the portal's user), so
 * the server runs them with the real applicant in that slot: their profile and
 * account take the demo user's place, and their records carry the slot's id.
 * Applicant actions and staff actions on that applicant both use this; staff
 * rules are called with CURRENT_APPLICANT_ID as the applicant id.
 */
export function applicantState(loaded: Parameters<typeof serverState>[0], applicant: SlotApplicant): DemoState {
  const toSlot = <T extends { applicantId: string }>(r: T): T => r.applicantId === applicant.id ? { ...r, applicantId: CURRENT_APPLICANT_ID } : r;
  const state = serverState(loaded);
  return {
    ...state,
    profile: { ...applicant.profile, twoFactor: false },
    accounts: { [CURRENT_APPLICANT_ID]: applicant.account },
    applications: state.applications.map(toSlot),
    notifications: state.notifications.map(toSlot),
  };
}

/** What a rule left in the slot, with the real applicant id put back on their records. */
export function readApplicantSlot(state: DemoState, applicantId: string): {
  profile: Omit<Profile, 'twoFactor'>; account: AccountControls; applications: Application[]; notifications: Notification[];
} {
  const fromSlot = <T extends { applicantId: string }>(r: T): T => r.applicantId === CURRENT_APPLICANT_ID ? { ...r, applicantId } : r;
  const { twoFactor: _twoFactor, ...profile } = state.profile;
  return {
    profile,
    account: state.accounts[CURRENT_APPLICANT_ID]!,
    applications: state.applications.map(fromSlot),
    notifications: state.notifications.map(fromSlot),
  };
}
