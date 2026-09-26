import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DemoState, Result } from './model';
import { createSeedState, CURRENT_APPLICANT_ID, seedAccounts, seedGrants, seedPayoutDestinations, seedStaff, seedTreasury } from './seed';

// Browser-only persistence until the API and database exist. Every change goes
// through a rule function from ./rules; the store only saves accepted results.

// The key name predates v3; the `version` field inside decides the shape.
export const DEMO_STATE_STORAGE_KEY = 'arc.fund.demoState.v2';

/**
 * Upgrades older saved shapes instead of discarding the visitor's work.
 * v2 → v3: the grant catalog moved into state and notifications were added.
 * v3 → v4: money settings (treasury) and the staff activity feed were added.
 * v4 → v5: staff roles, audit log, account controls/KYC, lockdown, program
 * questions, escalations, saved payout destinations, and card PIN/limits.
 */
export function migrateState(raw: unknown): DemoState | null {
  const data = raw as Record<string, unknown> | null;
  if (!data || !Array.isArray(data.applications) || !Array.isArray(data.transactions)) return null;
  if (data.version === 5 && Array.isArray(data.grants) && Array.isArray(data.staff) && Array.isArray(data.audit) && data.accounts && data.treasury) return data as unknown as DemoState;
  if (data.version === 4 && Array.isArray(data.grants) && Array.isArray(data.notifications) && Array.isArray(data.staffFeed) && data.treasury) return migrateState(toV5(data as unknown as V4State));
  if (data.version === 3 && Array.isArray(data.grants) && Array.isArray(data.notifications)) return migrateState({ ...data, version: 4, treasury: seedTreasury(), staffFeed: [] });
  if (data.version === 2) return migrateState({ ...data, version: 3, grants: seedGrants(), notifications: [] });
  return null;
}

type V4State = Omit<DemoState, 'version' | 'payoutDestinations' | 'accounts' | 'staff' | 'actingStaffId' | 'audit' | 'lockdown'> & { version: 4 };

function toV5(data: V4State): DemoState {
  const seed = createSeedState();
  const seedTiers = new Map(seed.otherApplicants.map(p => [p.id, p.tier]));
  const accounts = seedAccounts();
  // Programs keep their existing (question-free) definitions so in-flight applications stay valid.
  return {
    ...data, version: 5,
    grants: data.grants.map(g => ({ ...g, questions: g.questions ?? [] })),
    applications: data.applications.map(a => ({ ...a, answers: a.answers ?? {}, escalation: a.escalation ?? null })),
    treasury: { ...data.treasury, dualControlThreshold: data.treasury.dualControlThreshold ?? seedTreasury().dualControlThreshold, applicationFee: data.treasury.applicationFee ?? 0 },
    profile: { ...seed.profile, ...data.profile },
    otherApplicants: data.otherApplicants.map(p => ({ ...p, tier: p.tier ?? seedTiers.get(p.id) ?? 1 })),
    cards: { ...data.cards, virtual: { ...seed.cards.virtual, ...data.cards.virtual } },
    payoutDestinations: seedPayoutDestinations(),
    // Keep visitors' verification status in step with the seeded KYC records.
    accounts: data.profile.identityVerified ? accounts : { ...accounts, [CURRENT_APPLICANT_ID]: { ...accounts[CURRENT_APPLICANT_ID]!, kyc: { status: 'Not submitted' } } },
    staff: seedStaff(), actingStaffId: seed.actingStaffId, audit: [], lockdown: null,
  };
}

function parseState(raw: string | null): DemoState | null {
  try {
    return raw ? migrateState(JSON.parse(raw)) : null;
  } catch { /* ignore corrupt data */ }
  return null;
}

function loadState(): DemoState {
  try {
    const stored = parseState(window.localStorage.getItem(DEMO_STATE_STORAGE_KEY));
    if (stored) return stored;
    window.localStorage.removeItem('arc.fund.applicantDemoState.v1'); // pre-review schema
  } catch { /* storage unavailable */ }
  return createSeedState();
}

function saveState(state: DemoState): void {
  try { window.localStorage.setItem(DEMO_STATE_STORAGE_KEY, JSON.stringify(state)); } catch { /* storage unavailable: keep in memory */ }
}

type Store = {
  state: DemoState;
  /** Apply a rule; persists and re-renders only when it succeeds. */
  run: (command: (state: DemoState) => Result) => Result;
  reset: () => void;
};

const StoreContext = createContext<Store | null>(null);

export function DemoStoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(loadState);
  const current = useRef(state);

  // The applicant portal and /admin are often open in separate tabs; keep them in step.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== DEMO_STATE_STORAGE_KEY) return;
      const next = parseState(event.newValue) ?? createSeedState();
      current.current = next;
      setState(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const run = useCallback((command: (state: DemoState) => Result) => {
    const result = command(current.current);
    if (result.ok) {
      current.current = result.state;
      setState(result.state);
      saveState(result.state);
    }
    return result;
  }, []);

  const reset = useCallback(() => {
    const seed = createSeedState();
    current.current = seed;
    setState(seed);
    try { window.localStorage.removeItem(DEMO_STATE_STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  return <StoreContext.Provider value={{ state, run, reset }}>{children}</StoreContext.Provider>;
}

export function useDemoStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useDemoStore must be used inside DemoStoreProvider');
  return store;
}
