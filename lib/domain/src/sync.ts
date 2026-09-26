import type { AccountControls, DemoState, Grant, Profile, Result } from './model';
import { createSeedState, CURRENT_APPLICANT_ID } from './seed';

// Merging server records into the browser store. While only some data lives on
// the server (phase 12), signed-in pages load it into the same store the rest
// of the app reads, so pages don't need to know where each record came from.

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unchanged = (state: DemoState): Result => ({ ok: true, message: '', state });

/** Replaces the program catalog with the server's. */
export function adoptServerPrograms(state: DemoState, grants: Grant[]): Result {
  if (same(state.grants, grants)) return unchanged(state);
  return { ok: true, message: '', state: { ...state, grants } };
}

/** Puts one program the server just saved into the catalog (added or replaced in place). */
export function adoptServerProgram(state: DemoState, grant: Grant): Result {
  const exists = state.grants.some(g => g.id === grant.id);
  const grants = exists ? state.grants.map(g => g.id === grant.id ? grant : g) : [...state.grants, grant];
  return adoptServerPrograms(state, grants);
}

export function dropServerProgram(state: DemoState, id: string): Result {
  return adoptServerPrograms(state, state.grants.filter(g => g.id !== id));
}

/** The applicant profile as the API returns it. */
export type ServerProfile = Pick<Profile, 'name' | 'email' | 'phone' | 'address' | 'sector' | 'country' | 'joined' | 'tier' | 'identityVerified'>;
/** Account controls as the API returns them (risk signals aren't collected yet). */
export type ServerAccount = Omit<AccountControls, 'signals' | 'destinationChangedAt'>;
export type ServerApplicant = { id: string; profile: ServerProfile; account: ServerAccount };

const NO_SIGNALS: AccountControls['signals'] = { ipCountry: 'Unknown', sharedDeviceWith: [] };
const withSignals = (account: ServerAccount, local?: AccountControls): AccountControls => ({ ...account, signals: local?.signals ?? NO_SIGNALS, destinationChangedAt: local?.destinationChangedAt });

/**
 * Shows the signed-in applicant's server profile and account controls. The
 * server decides tier, identity status, lock, and pending resets; the two-step
 * preference is still only a browser setting.
 */
export function adoptServerProfile(state: DemoState, server: ServerProfile, account?: ServerAccount): Result {
  const { name, email, phone, address, sector, country, joined, tier, identityVerified } = server;
  const profile = { ...state.profile, name, email, phone, address, sector, country, joined, tier, identityVerified };
  const accounts = account ? { ...state.accounts, [CURRENT_APPLICANT_ID]: withSignals(account, state.accounts[CURRENT_APPLICANT_ID]) } : state.accounts;
  if (same(profile, state.profile) && same(accounts, state.accounts)) return unchanged(state);
  return { ok: true, message: '', state: { ...state, profile, accounts } };
}

const toSummary = ({ id, profile: p }: ServerApplicant) => ({ id, name: p.name, email: p.email, sector: p.sector, country: p.country, verified: p.identityVerified, joined: p.joined, tier: p.tier });

/** Staff side: replaces the demo directory with the real applicants from the API. */
export function adoptServerApplicants(state: DemoState, applicants: ServerApplicant[]): Result {
  const otherApplicants = applicants.map(toSummary);
  const accounts: DemoState['accounts'] = { [CURRENT_APPLICANT_ID]: state.accounts[CURRENT_APPLICANT_ID]! };
  for (const a of applicants) accounts[a.id] = withSignals(a.account);
  if (state.serverApplicants && same(otherApplicants, state.otherApplicants) && same(accounts, state.accounts)) return unchanged(state);
  return { ok: true, message: '', state: { ...state, otherApplicants, accounts, serverApplicants: true } };
}

/** Puts one applicant the server just changed into the directory. */
export function adoptServerApplicant(state: DemoState, applicant: ServerApplicant): Result {
  const summary = toSummary(applicant);
  const exists = state.otherApplicants.some(o => o.id === applicant.id);
  const otherApplicants = exists ? state.otherApplicants.map(o => o.id === applicant.id ? summary : o) : [...state.otherApplicants, summary];
  const accounts = { ...state.accounts, [applicant.id]: withSignals(applicant.account, state.accounts[applicant.id]) };
  return { ok: true, message: '', state: { ...state, otherApplicants, accounts, serverApplicants: true } };
}

/** Back to the demo directory (after signing out, or when sign-in isn't configured). */
export function leaveServerApplicants(state: DemoState): Result {
  if (!state.serverApplicants) return unchanged(state);
  const seed = createSeedState();
  return { ok: true, message: '', state: { ...state, otherApplicants: seed.otherApplicants, accounts: { ...seed.accounts, [CURRENT_APPLICANT_ID]: state.accounts[CURRENT_APPLICANT_ID]! }, serverApplicants: false } };
}

/**
 * What the browser may keep in storage. Real applicants loaded for staff are
 * dropped (they're reloaded from the API on the next visit), so their details
 * don't stay on a staff member's computer after they sign out.
 */
export function forStorage(state: DemoState): DemoState {
  if (!state.serverApplicants) return state;
  return { ...state, otherApplicants: [], accounts: { [CURRENT_APPLICANT_ID]: state.accounts[CURRENT_APPLICANT_ID]! } };
}
