import { logger } from "./logger";

// Outgoing email: what is sent, how it's rendered, and the delivery loop.
// Emails are queued in an outbox in the same transaction as the change that
// causes them (see activity.ts / activity.db.ts), then a worker sends them.
// With RESEND_API_KEY unset, the worker marks queued mail "skipped" rather than
// letting it pile up, so turning email on later doesn't send a stale backlog.

export type EmailKind = "notification" | "staff-invite";
export type NewEmail = { kind: EmailKind; to: string; subject: string; text: string; html: string };

export type OutboxStatus = "queued" | "sending" | "sent" | "failed" | "skipped";
export type OutboxEmail = NewEmail & { seq: number; attempts: number };
export type OutboxEntry = { seq: number; kind: EmailKind; to: string; subject: string; status: OutboxStatus; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null };

export interface EmailOutbox {
  /** Claims up to `limit` due emails for sending (claims expire, so a crashed worker's mail is retried). */
  claim(limit: number, now: Date): Promise<OutboxEmail[]>;
  markSent(seq: number, providerId: string | null, now: Date): Promise<void>;
  /** `retryAt` null means give up. */
  markFailed(seq: number, error: string, retryAt: Date | null): Promise<void>;
  markSkipped(seq: number, reason: string): Promise<void>;
  /** Counts per status and the most recent entries (newest first), for staff. */
  summary(recent: number): Promise<{ counts: Record<OutboxStatus, number>; recent: OutboxEntry[] }>;
}

// ---------- Rendering ----------

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The public address of the portal, for links in emails: APP_URL, else the Replit dev domain. */
export function appUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env["APP_URL"]?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const dev = env["REPLIT_DEV_DOMAIN"]?.trim();
  return dev ? `https://${dev}` : null;
}

/** A plain, accessible message: greeting, paragraphs, an optional button, and a footer. */
export function renderEmail(opts: { greeting: string; paragraphs: string[]; action?: { label: string; href: string }; footer: string }): { text: string; html: string } {
  const { greeting, paragraphs, action, footer } = opts;
  const text = [greeting, "", ...paragraphs.flatMap(p => [p, ""]), ...(action ? [`${action.label}: ${action.href}`, ""] : []), "—", footer].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f4ef;font-family:Arial,Helvetica,sans-serif;color:#1d1d1b">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
<p style="margin:0 0 18px;font-weight:bold;font-size:15px">arc.fund</p>
<p style="margin:0 0 14px;font-size:14px;line-height:1.5">${escape(greeting)}</p>
${paragraphs.map(p => `<p style="margin:0 0 14px;font-size:14px;line-height:1.5">${escape(p)}</p>`).join("\n")}
${action ? `<p style="margin:22px 0"><a href="${escape(action.href)}" style="display:inline-block;background:#1d1d1b;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:14px">${escape(action.label)}</a></p>` : ""}
<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#6b6b66">${escape(footer)}</p>
</div></body></html>`;
  return { text, html };
}

/** The email copy of an in-app notification. */
export function notificationEmail(n: { title: string; body: string; href: string }, recipient: { email: string; name: string }, baseUrl: string | null): NewEmail {
  const { text, html } = renderEmail({
    greeting: `Hello ${recipient.name},`,
    paragraphs: [n.body],
    ...(baseUrl ? { action: { label: "Open arc.fund", href: `${baseUrl}${n.href}` } } : {}),
    footer: "You're receiving this because you have an arc.fund account. You can turn off email copies of notifications in Settings.",
  });
  return { kind: "notification", to: recipient.email, subject: n.title, text, html };
}

/** Tells a newly added staff member how to get in. */
export function staffInviteEmail(member: { email: string; name: string; roleLabel: string }, invitedBy: string, baseUrl: string | null): NewEmail {
  const { text, html } = renderEmail({
    greeting: `Hello ${member.name},`,
    paragraphs: [
      `${invitedBy} added you to the arc.fund grant team as ${member.roleLabel}.`,
      `To get in, create an account with this email address (${member.email}) if you don't have one, confirm it, then sign in to the admin workspace. Your staff access links to the account the first time you sign in.`,
    ],
    ...(baseUrl ? { action: { label: "Sign in to the admin workspace", href: `${baseUrl}/admin/login` } } : {}),
    footer: "If you weren't expecting this, you can ignore this email; nothing happens until you sign in.",
  });
  return { kind: "staff-invite", to: member.email, subject: "You've been added to the arc.fund grant team", text, html };
}

// ---------- Sending ----------

export type SendResult = { ok: true; providerId: string | null } | { ok: false; error: string; retry: boolean };
export type Mailer = { configured: boolean; from: string | null; send(email: OutboxEmail): Promise<SendResult> };

/**
 * Sends through Resend's HTTP API. The idempotency key makes a retried send of
 * the same outbox row a no-op at Resend (keys are kept for 24 hours).
 */
export function resendMailer(apiKey: string, from: string, replyTo?: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    configured: true,
    from,
    send: async email => {
      try {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": `email-${email.seq}` },
          body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text, html: email.html, ...(replyTo ? { reply_to: replyTo } : {}) }),
          signal: AbortSignal.timeout(15_000),
        });
        const body = await res.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
        if (res.ok) return { ok: true, providerId: body.id ?? null };
        // 429 and 5xx are worth retrying; other 4xx (bad address, unverified domain) won't fix themselves.
        return { ok: false, error: `Resend ${res.status}: ${body.message ?? body.name ?? res.statusText}`.slice(0, 500), retry: res.status === 429 || res.status >= 500 };
      } catch (err) {
        return { ok: false, error: `Couldn't reach Resend: ${(err as Error).message}`.slice(0, 500), retry: true };
      }
    },
  };
}

/** Used when RESEND_API_KEY isn't set: nothing is sent. */
export const unconfiguredMailer: Mailer = { configured: false, from: null, send: async () => ({ ok: false, error: "Email isn't configured", retry: false }) };

/** The mailer from the environment: RESEND_API_KEY and EMAIL_FROM (optional EMAIL_REPLY_TO). */
export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  const key = env["RESEND_API_KEY"]?.trim();
  const from = env["EMAIL_FROM"]?.trim();
  if (!key || !from) {
    if (key || from) logger.warn("Set both RESEND_API_KEY and EMAIL_FROM to send email; email stays off");
    return unconfiguredMailer;
  }
  return resendMailer(key, from, env["EMAIL_REPLY_TO"]?.trim() || undefined);
}

/** Minutes to wait before attempt n+1 (after n failed attempts); past the end, give up. */
export const RETRY_MINUTES = [1, 5, 30, 120, 360];

/** Sends one batch of due email. Returns how many were claimed. */
export async function deliverBatch(outbox: EmailOutbox, mailer: Mailer, now = new Date(), limit = 20): Promise<number> {
  const batch = await outbox.claim(limit, now);
  for (const email of batch) {
    if (!mailer.configured) { await outbox.markSkipped(email.seq, "Email wasn't configured when this was due (RESEND_API_KEY / EMAIL_FROM)."); continue; }
    const result = await mailer.send(email);
    if (result.ok) { await outbox.markSent(email.seq, result.providerId, new Date()); continue; }
    const wait = result.retry ? RETRY_MINUTES[email.attempts - 1] : undefined;
    await outbox.markFailed(email.seq, result.error, wait === undefined ? null : new Date(now.getTime() + wait * 60_000));
    logger.warn({ seq: email.seq, attempt: email.attempts, retry: wait !== undefined, error: result.error }, "email not sent");
  }
  return batch.length;
}

/** Runs deliverBatch every `intervalMs` (and straight away). Returns a stop function. */
export function startEmailWorker(outbox: EmailOutbox, mailer: Mailer, intervalMs = 15_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { while (await deliverBatch(outbox, mailer) > 0) { /* keep going while there's a backlog */ } }
    catch (err) { logger.error({ err }, "email worker failed"); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** In-memory outbox for tests. */
export function memoryOutbox() {
  type Row = OutboxEmail & { status: OutboxStatus; nextAttemptAt: number; lastError: string | null; providerId: string | null; createdAt: string; sentAt: string | null };
  const rows: Row[] = [];
  let seq = 0;
  const outbox: EmailOutbox & { rows: Row[]; enqueue(emails: NewEmail[]): void } = {
    rows,
    enqueue: emails => { for (const e of emails) rows.push({ ...e, seq: ++seq, attempts: 0, status: "queued", nextAttemptAt: 0, lastError: null, providerId: null, createdAt: new Date().toISOString(), sentAt: null }); },
    claim: async (limit, now) => {
      const due = rows.filter(r => (r.status === "queued" || r.status === "sending") && r.nextAttemptAt <= now.getTime()).slice(0, limit);
      for (const r of due) { r.status = "sending"; r.attempts++; r.nextAttemptAt = now.getTime() + 5 * 60_000; }
      return due.map(r => ({ seq: r.seq, kind: r.kind, to: r.to, subject: r.subject, text: r.text, html: r.html, attempts: r.attempts }));
    },
    markSent: async (s, providerId, now) => { const r = rows.find(x => x.seq === s)!; Object.assign(r, { status: "sent", providerId, sentAt: now.toISOString(), lastError: null }); },
    markFailed: async (s, error, retryAt) => { const r = rows.find(x => x.seq === s)!; Object.assign(r, { status: retryAt ? "queued" : "failed", lastError: error, nextAttemptAt: retryAt?.getTime() ?? r.nextAttemptAt }); },
    markSkipped: async (s, reason) => { const r = rows.find(x => x.seq === s)!; Object.assign(r, { status: "skipped", lastError: reason }); },
    summary: async recent => {
      const counts: Record<OutboxStatus, number> = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
      for (const r of rows) counts[r.status]++;
      return { counts, recent: [...rows].reverse().slice(0, recent).map(r => ({ seq: r.seq, kind: r.kind, to: r.to, subject: r.subject, status: r.status, attempts: r.attempts, lastError: r.lastError, createdAt: r.createdAt, sentAt: r.sentAt })) };
    },
  };
  return outbox;
}
