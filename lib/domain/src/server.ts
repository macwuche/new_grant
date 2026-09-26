import type { DemoState } from './model';
import { createSeedState } from './seed';

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
