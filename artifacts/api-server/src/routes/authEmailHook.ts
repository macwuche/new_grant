import { Router, type IRouter, type Request } from "express";
import { hookEmails, type SendEmailHook } from "../lib/authEmails";
import { effectiveConfig } from "../lib/emailSettings";
import { logger } from "../lib/logger";
import { resendApi, verifyWebhook } from "../lib/providers";
import type { EmailDeps } from "./email";

// POST /api/auth/email-hook: Supabase's Send Email Hook. With the hook on,
// Supabase sends no auth email itself (sign-up confirmation, password reset,
// sign-in links, invites, email change, codes); it calls this route instead,
// signed with the hook secret (SUPABASE_EMAIL_HOOK_SECRET, "v1,whsec_…" from
// Supabase → Authentication → Hooks). The email is sent through Resend straight
// away, from the sender saved in Settings → Email, so the person gets it while
// they wait. A non-200 answer makes Supabase show the sign-up or reset as failed.
// Mounted before sign-in.

/** Supabase waits only a few seconds for a hook, so give Resend less than that. */
const SEND_TIMEOUT_MS = 4_000;

export function authEmailHookRouter({ settings, fetchImpl = fetch, env = process.env }: Omit<EmailDeps, "outbox" | "inbox">): IRouter {
  const router: IRouter = Router();
  // Supabase reads errors in this shape and shows the message.
  const fail = (status: number, message: string) => ({ error: { http_code: status, message } });

  router.post("/auth/email-hook", async (req, res) => {
    const secret = env["SUPABASE_EMAIL_HOOK_SECRET"]?.trim();
    const supabaseUrl = env["SUPABASE_URL"]?.trim();
    if (!secret || !supabaseUrl) { res.status(503).json(fail(503, "The email hook isn't set up on the server.")); return; }
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const id = req.header("webhook-id");
    const signed = !!raw && verifyWebhook(secret, { id, timestamp: req.header("webhook-timestamp"), signature: req.header("webhook-signature") }, raw);
    if (!signed) { req.log?.warn("auth email hook with a bad signature"); res.status(401).json(fail(401, "Invalid signature.")); return; }

    const c = effectiveConfig(await settings.get(), env);
    if (!c.resendKey || !c.from) { logger.error("auth email hook called but no Resend key and sender are saved"); res.status(503).json(fail(503, "Email sending isn't set up yet.")); return; }

    const payload = req.body as SendEmailHook;
    const type = payload.email_data?.email_action_type ?? "unknown";
    const emails = hookEmails(payload, supabaseUrl);
    if (!emails.length) { logger.warn({ type }, "auth email hook: nothing to send for this email type"); res.json({}); return; }

    const api = resendApi(c.resendKey, (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) }));
    for (const [i, email] of emails.entries()) {
      // Supabase retries a failed hook with the same webhook-id: the key keeps Resend from sending twice.
      const sent = await api.send({ from: c.from, to: [email.to], subject: email.subject, text: email.text, html: email.html, ...(c.replyTo ? { replyTo: c.replyTo } : {}) }, `auth-${id}-${i}`);
      if (!sent.ok) { logger.error({ type, error: sent.error }, "auth email not sent"); res.status(502).json(fail(502, "We couldn't send the email. Try again in a minute.")); return; }
      logger.info({ type, resendId: sent.data.id }, "auth email sent");
    }
    res.json({});
  });
  return router;
}
