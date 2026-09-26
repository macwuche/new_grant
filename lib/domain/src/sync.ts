import type { AccountControls, Application, AuditEvent, DemoState, Grant, Notification, Profile, Result, StaffEvent, Transaction } from './model';
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
 * Loads applications from the API. For an applicant (`ownId` = their account
 * id) these are their own, moved into the portal's current-applicant slot; for
 * staff, the review queue as it is. Until money moves to the server (slice 5),
 * an approved award is also credited to the demo grant balance here, once.
 */
export function adoptServerApplications(state: DemoState, apps: Application[], ownId?: string): Result {
  const applications = ownId ? apps.map(a => a.applicantId === ownId ? { ...a, applicantId: CURRENT_APPLICANT_ID } : a) : apps;
  const transactions = ownId ? withAwardCredits(state, applications) : state.transactions;
  if (state.serverApplications && same(applications, state.applications) && transactions === state.transactions) return unchanged(state);
  return { ok: true, message: '', state: { ...state, applications, transactions, serverApplications: true } };
}

/** Puts one application the server just saved into the store (added or replaced). */
export function adoptServerApplication(state: DemoState, app: Application, ownId?: string): Result {
  const inSlot = ownId && app.applicantId === ownId ? { ...app, applicantId: CURRENT_APPLICANT_ID } : app;
  const exists = state.applications.some(a => a.id === app.id);
  const applications = exists ? state.applications.map(a => a.id === app.id ? inSlot : a) : [inSlot, ...state.applications];
  const transactions = ownId ? withAwardCredits(state, applications) : state.transactions;
  return { ok: true, message: '', state: { ...state, applications, transactions, serverApplications: true } };
}

export function dropServerApplication(state: DemoState, id: string): Result {
  return { ok: true, message: '', state: { ...state, applications: state.applications.filter(a => a.id !== id) } };
}

/** Back to the demo applications (after signing out, or when sign-in isn't configured). */
export function leaveServerApplications(state: DemoState): Result {
  if (!state.serverApplications) return unchanged(state);
  return { ok: true, message: '', state: { ...state, applications: createSeedState().applications, serverApplications: false } };
}

/** Adds a demo grant-balance credit for each approved award that doesn't have one yet. */
function withAwardCredits(state: DemoState, applications: Application[]): Transaction[] {
  let n = state.nextId;
  const credits: Transaction[] = [];
  for (const app of applications) {
    if (app.applicantId !== CURRENT_APPLICANT_ID || app.status !== 'Approved' || !app.awardedAmount) continue;
    if (state.transactions.some(t => t.type === 'Grant' && t.description.endsWith(`(${app.id})`))) continue;
    const grant = state.grants.find(g => g.id === app.grantId);
    const approvedAt = [...app.history].reverse().find(h => h.status === 'Approved')?.at ?? app.updatedAt;
    credits.push({ id: `TX-${80000 + n++}`, applicantId: CURRENT_APPLICANT_ID, type: 'Grant', description: `${grant?.name ?? 'Grant'} award (${app.id})`, amount: app.awardedAmount, status: 'Completed', createdAt: approvedAt });
  }
  return credits.length ? [...credits, ...state.transactions] : state.transactions;
}

/** Server notifications, feed items, and audit entries, as the API returns them. */
export type ServerActivity = {
  notifications?: Omit<Notification, 'applicantId'>[];
  staffFeed?: StaffEvent[];
  audit?: AuditEvent[];
};

/**
 * Loads activity from the API: an applicant's notifications (moved into the
 * portal's slot), and for staff the team feed with their own read state and,
 * with audit.view, the audit log.
 */
export function adoptServerActivity(state: DemoState, activity: ServerActivity): Result {
  const next = { ...state, serverActivity: true };
  if (activity.notifications) next.notifications = activity.notifications.map(n => ({ ...n, applicantId: CURRENT_APPLICANT_ID }));
  if (activity.staffFeed) next.staffFeed = activity.staffFeed;
  // The audit log is kept oldest first, like the browser's own.
  if (activity.audit) next.audit = [...activity.audit].reverse();
  if (state.serverActivity && same(next, state)) return unchanged(state);
  return { ok: true, message: '', state: next };
}

/** Back to the demo activity (after signing out, or when sign-in isn't configured). */
export function leaveServerActivity(state: DemoState): Result {
  if (!state.serverActivity) return unchanged(state);
  const seed = createSeedState();
  return { ok: true, message: '', state: { ...state, notifications: seed.notifications, staffFeed: seed.staffFeed, audit: seed.audit, serverActivity: false } };
}

/**
 * What the browser may keep in storage. Real applicants loaded for staff are
 * dropped (they're reloaded from the API on the next visit), so their details
 * don't stay on a staff member's computer after they sign out.
 */
export function forStorage(state: DemoState): DemoState {
  let stored = state;
  if (stored.serverApplicants) stored = { ...stored, otherApplicants: [], accounts: { [CURRENT_APPLICANT_ID]: stored.accounts[CURRENT_APPLICANT_ID]! } };
  if (stored.serverApplications) stored = { ...stored, applications: [] };
  if (stored.serverActivity) stored = { ...stored, notifications: [], staffFeed: [], audit: [] };
  return stored;
}
