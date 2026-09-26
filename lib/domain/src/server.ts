import type { AccountControls, Application, CardsState, DemoState, Notification, PayoutDestinations, Profile, Transaction } from './model';
import { createSeedState, CURRENT_APPLICANT_ID } from './seed';

/**
 * A rule-ready state holding only the records the server has loaded; every
 * other collection is empty, so no demo data can leak into a server decision.
 * Rules read and return whole states, so the server passes in what it loaded
 * and stores what changed.
 */
type Loaded = Partial<Pick<DemoState, 'grants' | 'applications' | 'notifications' | 'transactions' | 'treasury' | 'lockdown' | 'nextId'>>;

export function serverState(loaded: Loaded): DemoState {
  const base = createSeedState();
  return {
    ...base,
    grants: [], applications: [], notifications: [], transactions: [], staffFeed: [], otherApplicants: [],
    accounts: {}, staff: [], actingStaffId: '', audit: [], payoutDestinations: {}, lockdown: null,
    // Callers pass the stored money settings; without them no application fee can be charged.
    treasury: { ...base.treasury, applicationFee: 0 },
    ...loaded,
  };
}

/** What an applicant may see of their own application: no reviewer name, internal notes, or escalation. */
export const applicantView = (app: Application): Application => ({ ...app, reviewer: null, internalNotes: [], escalation: null });

/** One real applicant as the server stores them. */
export type SlotApplicant = {
  id: string;
  profile: Omit<Profile, 'twoFactor'>;
  account: AccountControls;
  /** Money routes only: the applicant's cards and saved payout destinations. */
  cards?: CardsState;
  payoutDestinations?: PayoutDestinations;
};

/**
 * The rules were written for one "current applicant" (the portal's user), so
 * the server runs them with the real applicant in that slot: their profile and
 * account take the demo user's place, and their records carry the slot's id.
 * Applicant actions and staff actions on that applicant both use this; staff
 * rules are called with CURRENT_APPLICANT_ID as the applicant id.
 */
export function applicantState(loaded: Loaded, applicant: SlotApplicant): DemoState {
  const toSlot = <T extends { applicantId: string }>(r: T): T => r.applicantId === applicant.id ? { ...r, applicantId: CURRENT_APPLICANT_ID } : r;
  const state = serverState(loaded);
  return {
    ...state,
    profile: { ...applicant.profile, twoFactor: false },
    accounts: { [CURRENT_APPLICANT_ID]: applicant.account },
    applications: state.applications.map(toSlot),
    notifications: state.notifications.map(toSlot),
    transactions: state.transactions.map(toSlot),
    ...(applicant.cards ? { cards: applicant.cards } : {}),
    payoutDestinations: applicant.payoutDestinations ?? {},
  };
}

/** What a rule left in the slot, with the real applicant id put back on their records. */
export function readApplicantSlot(state: DemoState, applicantId: string): {
  profile: Omit<Profile, 'twoFactor'>; account: AccountControls; applications: Application[]; notifications: Notification[];
  transactions: Transaction[]; cards: CardsState; payoutDestinations: PayoutDestinations;
} {
  const fromSlot = <T extends { applicantId: string }>(r: T): T => r.applicantId === CURRENT_APPLICANT_ID ? { ...r, applicantId } : r;
  const { twoFactor: _twoFactor, ...profile } = state.profile;
  return {
    profile,
    account: state.accounts[CURRENT_APPLICANT_ID]!,
    applications: state.applications.map(fromSlot),
    notifications: state.notifications.map(fromSlot),
    transactions: state.transactions.map(fromSlot),
    cards: state.cards,
    payoutDestinations: state.payoutDestinations,
  };
}
