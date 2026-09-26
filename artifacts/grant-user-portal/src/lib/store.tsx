import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { migrateState } from '@workspace/domain/migrate';
import type { DemoState, Result } from '@workspace/domain/model';
import { createSeedState } from '@workspace/domain/seed';
import { forStorage } from '@workspace/domain/sync';

// Browser-only persistence until the API and database exist. Every change goes
// through a rule function from @workspace/domain/rules; the store only saves accepted results.

// The key name predates v3; the `version` field inside decides the shape.
export const DEMO_STATE_STORAGE_KEY = 'arc.fund.demoState.v2';

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
  try { window.localStorage.setItem(DEMO_STATE_STORAGE_KEY, JSON.stringify(forStorage(state))); } catch { /* storage unavailable: keep in memory */ }
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
