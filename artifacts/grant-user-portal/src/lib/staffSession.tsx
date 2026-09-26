import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getMe, setAuthTokenGetter, type Me } from '@workspace/api-client-react';
import { supabase } from './supabase';

// Staff sign-in state for /admin. The server decides who is staff (GET /api/me);
// the browser only holds the Supabase session.

export type SessionStatus = 'unconfigured' | 'loading' | 'signedOut' | 'signedIn';

type StaffSession = {
  status: SessionStatus;
  me: Me | null;
  /** Set when the session is valid but /api/me failed (e.g. the API is down). */
  meError: string | null;
  /** True after arriving from a password-reset link. */
  recovery: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  sendReset: (email: string) => Promise<string | null>;
  setNewPassword: (password: string) => Promise<string | null>;
  reloadMe: () => void;
};

const Ctx = createContext<StaffSession | null>(null);

const basePath = () => import.meta.env.BASE_URL.replace(/\/$/, '');

/** Plain-language versions of Supabase Auth errors. */
export function authErrorMessage(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'That email and password don\'t match an account.';
  if (/email not confirmed/i.test(message)) return 'Confirm your email address first, using the link we sent you.';
  if (/rate limit|too many/i.test(message)) return 'Too many attempts. Wait a minute and try again.';
  if (/password should be|weak password/i.test(message)) return 'Choose a stronger password: at least 8 characters.';
  if (/failed to fetch|network/i.test(message)) return 'Couldn\'t reach the sign-in service. Check your connection and try again.';
  return message;
}

function apiErrorMessage(err: unknown): string {
  const data = (err as { data?: { error?: unknown } }).data;
  if (data && typeof data.error === 'string') return data.error;
  return 'Couldn\'t load your staff access. Try again in a moment.';
}

export function StaffSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>(supabase ? 'loading' : 'unconfigured');
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);
  const token = useRef<string | null>(null);
  const request = useRef(0);

  const loadMe = useCallback(async (session: Session | null) => {
    const id = ++request.current;
    token.current = session?.access_token ?? null;
    if (!session) { setMe(null); setMeError(null); setStatus('signedOut'); return; }
    setStatus('loading');
    try {
      // Pass the token directly: calling back into supabase.auth here can deadlock inside onAuthStateChange.
      const result = await getMe({ headers: { authorization: `Bearer ${session.access_token}` } });
      if (id !== request.current) return;
      setMe(result); setMeError(null); setStatus('signedIn');
    } catch (err) {
      if (id !== request.current) return;
      if ((err as { status?: number }).status === 401) { await supabase?.auth.signOut(); return; }
      setMe(null); setMeError(apiErrorMessage(err)); setStatus('signedIn');
    }
  }, []);

  useEffect(() => {
    if (!supabase) return;
    setAuthTokenGetter(() => token.current);
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      if (event === 'TOKEN_REFRESHED') { token.current = session?.access_token ?? null; return; }
      void loadMe(session);
    });
    return () => { data.subscription.unsubscribe(); setAuthTokenGetter(null); };
  }, [loadMe]);

  const value: StaffSession = {
    status, me, meError, recovery,
    signIn: async (email, password) => {
      if (!supabase) return 'Sign-in isn\'t set up yet.';
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      return error ? authErrorMessage(error.message) : null;
    },
    signOut: async () => { await supabase?.auth.signOut(); setRecovery(false); },
    sendReset: async email => {
      if (!supabase) return 'Sign-in isn\'t set up yet.';
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}${basePath()}/admin/reset-password` });
      return error ? authErrorMessage(error.message) : null;
    },
    setNewPassword: async password => {
      if (!supabase) return 'Sign-in isn\'t set up yet.';
      const { error } = await supabase.auth.updateUser({ password });
      if (!error) setRecovery(false);
      return error ? authErrorMessage(error.message) : null;
    },
    reloadMe: () => { void supabase?.auth.getSession().then(({ data }) => loadMe(data.session)); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStaffSession(): StaffSession {
  const value = useContext(Ctx);
  if (!value) throw new Error('useStaffSession must be used inside StaffSessionProvider');
  return value;
}
