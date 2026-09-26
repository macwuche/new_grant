import { createHmac, timingSafeEqual } from "node:crypto";

// Calls to Resend (domains, received mail, sending from the inbox) and to the
// Supabase Management API (sign-up email confirmation). `fetchImpl` is
// injectable so tests never reach the network.

export type Fetch = typeof fetch;
export type ProviderResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

async function call<T>(fetchImpl: Fetch, url: string, init: RequestInit, label: string): Promise<ProviderResult<T>> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => ({})) as T & { message?: string; name?: string; error?: string };
    if (res.ok) return { ok: true, data: body };
    return { ok: false, status: res.status, error: `${label} ${res.status}: ${body.message ?? body.error ?? body.name ?? res.statusText}`.slice(0, 400) };
  } catch (err) {
    return { ok: false, status: 0, error: `Couldn't reach ${label}: ${(err as Error).message}`.slice(0, 400) };
  }
}

// ---------- Resend ----------

export type DnsRecord = { record: string; name: string; type: string; value?: string; priority?: number; ttl?: string; status: string };
export type ResendDomain = { id: string; name: string; status: string; region?: string; records?: DnsRecord[]; capabilities?: { sending?: string; receiving?: string } };
export type ReceivedEmail = {
  id: string; from: string; to: string[]; cc?: string[]; subject: string; html: string | null; text: string | null;
  message_id?: string; created_at: string; attachments?: { id: string; filename: string; content_type: string; size?: number }[];
};

export function resendApi(apiKey: string, fetchImpl: Fetch = fetch) {
  const base = "https://api.resend.com";
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  return {
    listDomains: () => call<{ data: ResendDomain[] }>(fetchImpl, `${base}/domains`, { headers }, "Resend"),
    createDomain: (name: string, receiving: boolean) => call<ResendDomain>(fetchImpl, `${base}/domains`, {
      method: "POST", headers, body: JSON.stringify({ name, capabilities: { sending: "enabled", receiving: receiving ? "enabled" : "disabled" } }),
    }, "Resend"),
    getDomain: (id: string) => call<ResendDomain>(fetchImpl, `${base}/domains/${encodeURIComponent(id)}`, { headers }, "Resend"),
    verifyDomain: (id: string) => call<{ id: string }>(fetchImpl, `${base}/domains/${encodeURIComponent(id)}/verify`, { method: "POST", headers }, "Resend"),
    getReceivedEmail: (id: string) => call<ReceivedEmail>(fetchImpl, `${base}/emails/receiving/${encodeURIComponent(id)}`, { headers }, "Resend"),
    send: (email: { from: string; to: string[]; subject: string; text: string; html?: string; replyTo?: string; headers?: Record<string, string> }, idempotencyKey?: string) =>
      call<{ id: string }>(fetchImpl, `${base}/emails`, {
        method: "POST", headers: { ...headers, ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
        body: JSON.stringify({ from: email.from, to: email.to, subject: email.subject, text: email.text, ...(email.html ? { html: email.html } : {}), ...(email.replyTo ? { reply_to: email.replyTo } : {}), ...(email.headers ? { headers: email.headers } : {}) }),
      }, "Resend"),
  };
}

/**
 * Checks a Resend (Svix) webhook signature: HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${raw body}` with the base64 part of the
 * `whsec_` secret, compared with each `v1,<base64>` in svix-signature, and a
 * timestamp within five minutes.
 */
export function verifyWebhook(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, rawBody: Buffer | string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > 300) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(rawBody).digest();
  return signature.split(" ").some(part => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// ---------- Supabase Management API ----------

/** The project ref from SUPABASE_URL (https://<ref>.supabase.co). */
export const projectRef = (supabaseUrl: string | undefined) => /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(supabaseUrl ?? "")?.[1] ?? null;

export function supabaseManagement(token: string, ref: string, fetchImpl: Fetch = fetch) {
  const url = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    getAuthConfig: () => call<{ mailer_autoconfirm?: boolean }>(fetchImpl, url, { headers }, "Supabase"),
    /** Email confirmation at sign-up on (true) or off (false: new accounts are confirmed automatically). */
    setEmailConfirmation: (required: boolean) => call<{ mailer_autoconfirm?: boolean }>(fetchImpl, url, { method: "PATCH", headers, body: JSON.stringify({ mailer_autoconfirm: !required }) }, "Supabase"),
  };
}
