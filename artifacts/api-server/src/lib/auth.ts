import { createClient } from "@supabase/supabase-js";

// Sign-in tokens are issued by Supabase Auth. The API never trusts a user id or
// role sent by the client: it verifies the bearer token and derives the user.

export type AuthUser = { id: string; email: string | null; emailConfirmed: boolean };

/** Resolves a bearer token to its user, or null if the token is invalid or expired. */
export type TokenVerifier = (token: string) => Promise<AuthUser | null>;

/** Verifies tokens with Supabase (this also catches revoked sessions). */
export function supabaseVerifier(url: string, anonKey: string): TokenVerifier {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return async (token) => {
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email?.toLowerCase() ?? null, emailConfirmed: !!data.user.email_confirmed_at };
  };
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match ? match[1]! : null;
}
