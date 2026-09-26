import { createClient } from "@supabase/supabase-js";

// Sign-in tokens are issued by Supabase Auth. The API never trusts a user id or
// role sent by the client: it verifies the bearer token and derives the user.

export type AuthUser = {
  id: string;
  email: string | null;
  emailConfirmed: boolean;
  /** Details the person gave at sign-up (Supabase user metadata). They can edit these, so treat as untrusted input. */
  metadata?: Record<string, unknown>;
  /** The session's assurance level: aal2 once a second factor (authenticator code) was checked in this session. */
  aal?: "aal1" | "aal2";
  /** How this session was authenticated (Supabase `amr` claim), e.g. password, recovery (reset link), totp. Unix seconds. */
  amr?: { method: string; timestamp: number }[];
  /** Verified second factors on the account, with when each was set up. */
  factors?: { id: string; createdAt: string }[];
  /** When the account was last updated (a password change updates it). */
  updatedAt?: string;
};

/** The claims of a JWT that has already been verified (no signature check here). */
export function jwtClaims(token: string): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>; }
  catch { return {}; }
}

/** Resolves a bearer token to its user, or null if the token is invalid or expired. */
export type TokenVerifier = (token: string) => Promise<AuthUser | null>;

/** Verifies tokens with Supabase (this also catches revoked sessions). */
export function supabaseVerifier(url: string, anonKey: string): TokenVerifier {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return async (token) => {
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) return null;
    // getUser has confirmed the token with Supabase, so its claims can be read.
    const claims = jwtClaims(token);
    const amr = Array.isArray(claims["amr"]) ? (claims["amr"] as { method?: unknown; timestamp?: unknown }[])
      .filter(a => typeof a.method === "string" && typeof a.timestamp === "number").map(a => ({ method: a.method as string, timestamp: a.timestamp as number })) : [];
    return {
      id: data.user.id, email: data.user.email?.toLowerCase() ?? null, emailConfirmed: !!data.user.email_confirmed_at, metadata: data.user.user_metadata ?? {},
      aal: claims["aal"] === "aal2" ? "aal2" : "aal1", amr,
      factors: (data.user.factors ?? []).filter(f => f.status === "verified").map(f => ({ id: f.id, createdAt: f.created_at })),
      updatedAt: data.user.updated_at,
    };
  };
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match ? match[1]! : null;
}
