import type { DemoState, Grant, Profile, Result } from './model';

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

/** Contact details owned by the server profile. */
export type ServerProfile = Pick<Profile, 'name' | 'email' | 'phone' | 'address' | 'sector' | 'country' | 'joined'>;

/**
 * Shows the signed-in applicant's server profile. Only contact details come
 * from the server for now: tier, identity status, and the two-step preference
 * stay in this browser, where staff still change them, until account controls
 * move to the server too.
 */
export function adoptServerProfile(state: DemoState, server: ServerProfile): Result {
  const { name, email, phone, address, sector, country, joined } = server;
  const profile = { ...state.profile, name, email, phone, address, sector, country, joined };
  if (same(profile, state.profile)) return unchanged(state);
  return { ok: true, message: '', state: { ...state, profile } };
}
