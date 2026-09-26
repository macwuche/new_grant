import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getBranding, setBranding } from '@workspace/api-client-react';
import { supabase } from './supabase';

// The application's name, shown in every wordmark, page title, and message.
// Signed-in mode: saved on the server by a super admin (GET /api/branding is
// public, so sign-in pages show it too) and used in emails as well. Demo mode:
// a preview saved in this browser only, like the brand colour.

export const DEFAULT_APP_NAME = 'arc.fund';
const DEMO_KEY = 'arc.fund.previewAppName';
// The last name the server gave, so pages don't flash the default on load. It's public, not a record.
const CACHE_KEY = 'arc.fund.appName';

const read = (key: string) => { try { return window.localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => {
  try { if (value) window.localStorage.setItem(key, value); else window.localStorage.removeItem(key); return true; } catch { return false; }
};

type AppNameState = {
  name: string;
  isDefault: boolean;
  /** True when the name is saved on the server for everyone; false in demo mode (this browser only). */
  shared: boolean;
  /** Saves a new name ('' restores the default). Resolves to false when the browser couldn't store a demo preview. */
  save: (name: string) => Promise<boolean>;
};

const AppNameContext = createContext<AppNameState>({ name: DEFAULT_APP_NAME, isDefault: true, shared: false, save: async () => false });

export function AppNameProvider({ children }: { children: ReactNode }) {
  const shared = !!supabase;
  const [name, setName] = useState(() => read(shared ? CACHE_KEY : DEMO_KEY) || DEFAULT_APP_NAME);
  const apply = useCallback((next: string | null) => {
    const value = next || DEFAULT_APP_NAME;
    setName(value);
    if (shared) write(CACHE_KEY, value === DEFAULT_APP_NAME ? null : value);
  }, [shared]);

  useEffect(() => {
    if (!shared) {
      const onStorage = (e: StorageEvent) => { if (e.key === DEMO_KEY) setName(read(DEMO_KEY) || DEFAULT_APP_NAME); };
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    }
    let live = true;
    const load = () => { getBranding().then(b => { if (live) apply(b.appName); }).catch(() => {}); };
    load();
    window.addEventListener('focus', load);
    return () => { live = false; window.removeEventListener('focus', load); };
  }, [shared, apply]);

  const save = useCallback(async (next: string) => {
    const trimmed = next.trim().replace(/\s+/g, ' ');
    if (shared) { apply((await setBranding({ appName: trimmed })).appName); return true; }
    const value = trimmed && trimmed !== DEFAULT_APP_NAME ? trimmed : null;
    setName(value ?? DEFAULT_APP_NAME);
    return write(DEMO_KEY, value);
  }, [shared, apply]);

  return <AppNameContext.Provider value={{ name, isDefault: name === DEFAULT_APP_NAME, shared, save }}>{children}</AppNameContext.Provider>;
}

export const useAppName = () => useContext(AppNameContext);

/** The name as a wordmark: the first "." is styled as the accent dot, as in arc.fund. */
export function Wordmark({ name }: { name?: string }) {
  const { name: current } = useAppName();
  const text = name ?? current;
  const dot = text.indexOf('.');
  return dot > 0 && dot < text.length - 1 ? <>{text.slice(0, dot)}<span>.</span>{text.slice(dot + 1)}</> : <>{text}</>;
}

/** The single letter in the square brand mark. */
export const brandLetter = (name: string) => (name.trim()[0] ?? 'a').toLowerCase();

/** The name as plain text, for use inside sentences. */
export function AppNameText() { return <>{useAppName().name}</>; }

/** The letter for the square brand mark. */
export function BrandLetter() { return <>{brandLetter(useAppName().name)}</>; }

/** The name's first word (before any "." or space), for tight spots like the card face. */
export function ShortAppName() { const { name } = useAppName(); return <>{name.split(/[.\s]/)[0] || name}</>; }
