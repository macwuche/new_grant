import { describe, expect, it } from 'vitest';
import { closeProgram } from './programs';
import { createSeedState } from './seed';
import { serverState } from './server';

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
});
