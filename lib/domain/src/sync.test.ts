import { describe, expect, it } from 'vitest';
import { createSeedState } from './seed';
import { adoptServerProfile, adoptServerProgram, adoptServerPrograms, dropServerProgram } from './sync';

describe('adopting server data', () => {
  it('replaces the catalog, and keeps the same state object when nothing changed', () => {
    const state = createSeedState();
    const same = adoptServerPrograms(state, structuredClone(state.grants));
    expect(same.ok && same.state).toBe(state);
    const fewer = adoptServerPrograms(state, state.grants.slice(0, 2));
    expect(fewer.ok && fewer.state.grants).toHaveLength(2);
  });

  it('adds, replaces, and drops single programs', () => {
    const state = createSeedState();
    const edited = { ...state.grants[0]!, summary: 'Edited on the server.' };
    const replaced = adoptServerProgram(state, edited);
    expect(replaced.ok && replaced.state.grants[0]!.summary).toBe('Edited on the server.');
    expect(replaced.ok && replaced.state.grants).toHaveLength(state.grants.length);
    const added = adoptServerProgram(state, { ...edited, id: 'PRG-3001', name: 'New one' });
    expect(added.ok && added.state.grants.at(-1)!.id).toBe('PRG-3001');
    const dropped = dropServerProgram(state, state.grants[0]!.id);
    expect(dropped.ok && dropped.state.grants.some(g => g.id === state.grants[0]!.id)).toBe(false);
  });

  it('takes contact details from the server profile but keeps tier, verification, and two-step locally', () => {
    const state = createSeedState();
    const result = adoptServerProfile(state, { name: 'Maya Okafor', email: 'maya@example.com', phone: '+44 20 7946 0000', address: '', sector: 'Retail', country: 'United Kingdom', joined: '2026-09-26' });
    if (!result.ok) throw new Error(result.error);
    expect(result.state.profile).toMatchObject({ name: 'Maya Okafor', email: 'maya@example.com', country: 'United Kingdom', joined: '2026-09-26' });
    expect(result.state.profile).toMatchObject({ tier: state.profile.tier, identityVerified: state.profile.identityVerified, twoFactor: state.profile.twoFactor });
  });
});
