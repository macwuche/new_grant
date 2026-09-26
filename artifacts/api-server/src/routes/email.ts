import { Router, type IRouter, type Request, type Response } from "express";
import { auditEntry, type Effects } from "../lib/activity";
import { appName, DEFAULT_APP_NAME, mailerFor, setAppName, setAppUrlOverride, type EmailOutbox } from "../lib/email";
import { effectiveConfig, type EmailSettingsPatch, type EmailSettingsRepo } from "../lib/emailSettings";
import type { InboxFolder, InboxRepo } from "../lib/inbox";
import { logger } from "../lib/logger";
import { authEmailTemplateConfig, RESEND_SMTP, usesAppTemplates } from "../lib/authEmails";
import { projectRef, resendApi, supabaseManagement, verifyWebhook, type Fetch, type SupabaseAuthConfig } from "../lib/providers";
import { auditContext, authLocals, requirePermission, requireStaff } from "../middlewares/auth";

// Email administration (super admins: staff.manage): the Resend key, sender,
// portal address, team mailbox address, sending/receiving domain, webhook
// signing secret, and the Supabase access token that switches sign-up email
// confirmation. Secrets are write-only: responses show whether each is set and
// the key's last four characters, never the value. Every change is audited
// without the secret values.
//
// The team inbox (any active staff member): mail received through the webhook
// and mail sent from it.
//
// The webhook (public, signature-checked) is a separate router mounted before
// sign-in: see emailWebhookRouter.

export type EmailDeps = { outbox: EmailOutbox; settings: EmailSettingsRepo; inbox: InboxRepo; fetchImpl?: Fetch; env?: NodeJS.ProcessEnv };

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const FROM = /^(?:[^<>]{1,80}<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .&'-]{0,39}$/u;
const brandingView = (saved: string | null) => ({ appName: saved ?? DEFAULT_APP_NAME, isDefault: !saved });
const addressOf = (from: string) => /<([^>]+)>/.exec(from)?.[1] ?? from;
const nameOf = (from: string) => /^([^<]+)</.exec(from)?.[1]?.trim() ?? null;
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function emailRouter({ outbox, settings, inbox, fetchImpl = fetch, env = process.env }: EmailDeps): IRouter {
  const router: IRouter = Router();
  const config = async () => effectiveConfig(await settings.get(), env);
  const admin = requirePermission("staff.manage");

  async function view() {
    const s = await settings.get();
    const c = effectiveConfig(s, env);
    return {
      resendKey: { set: !!c.resendKey, last4: s.resendKeyLast4 ?? (c.resendKey ? c.resendKey.slice(-4) : null), source: c.source.resendKey },
      from: c.from, fromSource: c.source.from, replyTo: c.replyTo, appUrl: c.appUrl, inboxAddress: c.inboxAddress,
      domain: s.domainName ? { name: s.domainName, id: s.domainId } : null,
      webhook: { url: c.appUrl ? `${c.appUrl}/api/email/webhook` : null, secretSet: !!c.webhookSecret },
      supabaseToken: { set: !!c.supabaseToken },
      sending: !!c.resendKey && !!c.from,
      updatedAt: s.updatedAt, updatedBy: s.updatedBy,
    };
  }

  const audit = (req: Request, res: Response, action: string, summary: string, changes: { field: string; before: string; after: string }[]): Effects =>
    ({ notifications: [], staffEvents: [], audit: [auditEntry(auditContext(req, res, action, "email-settings"), summary, changes, new Date())] });

  router.get("/email/status", admin, async (_req, res) => {
    const { counts, recent } = await outbox.summary(25);
    const c = await config();
    const mailer = mailerFor(c, fetchImpl);
    res.json({ configured: mailer.configured, from: mailer.from, counts, recent });
  });

  router.get("/email/settings", admin, async (_req, res) => { res.json(await view()); });

  router.put("/email/settings", admin, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors: Record<string, string> = {};
    const patch: EmailSettingsPatch = {};
    const changes: { field: string; before: string; after: string }[] = [];
    const text = (key: string) => typeof body[key] === "string" ? (body[key] as string).trim() : undefined;
    // An empty string clears a saved value (falling back to the environment).
    const field = (key: keyof EmailSettingsPatch, name: string, valid: (v: string) => boolean, message: string, secret = false) => {
      const v = text(key);
      if (v === undefined) return;
      if (v && !valid(v)) { errors[key] = message; return; }
      (patch as Record<string, string | null>)[key] = v || null;
      changes.push({ field: name, before: "—", after: v ? (secret ? `set (…${v.slice(-4)})` : v) : "cleared" });
    };
    field("resendKey", "Resend API key", v => /^re_[A-Za-z0-9_]{8,}$/.test(v), "Resend keys start with re_.", true);
    field("fromAddress", "Sender", v => FROM.test(v), "Use an address such as Grants <grants@yourdomain.org>.");
    field("replyTo", "Reply-to", v => EMAIL.test(v), "Enter an email address.");
    field("appUrl", "Portal address", v => /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(v), "Use the full https:// address of the portal.");
    field("inboxAddress", "Team mailbox", v => EMAIL.test(v), "Enter an email address.");
    field("webhookSecret", "Webhook signing secret", v => /^whsec_[A-Za-z0-9+/=]{16,}$/.test(v), "Resend signing secrets start with whsec_.", true);
    field("supabaseToken", "Supabase access token", v => /^sbp_[A-Za-z0-9]{20,}$/.test(v), "Supabase access tokens start with sbp_.", true);
    if (Object.keys(errors).length) { res.status(400).json({ error: "Fix the highlighted fields.", fieldErrors: errors }); return; }
    if (!changes.length) { res.status(400).json({ error: "Nothing to save." }); return; }

    // Check new credentials before saving them.
    if (patch.resendKey) {
      const check = await resendApi(patch.resendKey, fetchImpl).listDomains();
      // A sending-only key can't list domains; that's fine for sending, so only reject keys Resend doesn't recognise.
      if (!check.ok && !/restricted/i.test(check.error)) { res.status(400).json({ error: "Resend didn't accept this key.", fieldErrors: { resendKey: check.error } }); return; }
    }
    if (patch.supabaseToken) {
      const ref = projectRef(env["SUPABASE_URL"]);
      const check = ref ? await supabaseManagement(patch.supabaseToken, ref, fetchImpl).getAuthConfig() : { ok: false as const, status: 0, error: "SUPABASE_URL isn't set on the server." };
      if (!check.ok) { res.status(400).json({ error: "Supabase didn't accept this token.", fieldErrors: { supabaseToken: check.error } }); return; }
    }
    await settings.save(patch, authLocals(res).staff!.name, audit(req, res, "Change email settings", `Changed ${changes.map(c => c.field).join(", ")}.`, changes));
    if (patch.appUrl !== undefined) setAppUrlOverride(patch.appUrl);
    logger.info({ actor: authLocals(res).staff!.id, fields: changes.map(c => c.field) }, "email settings changed");
    res.json(await view());
  });

  router.post("/email/test", admin, async (req, res) => {
    const to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
    if (!EMAIL.test(to)) { res.status(400).json({ error: "Enter the address to send the test to." }); return; }
    const c = await config();
    if (!c.resendKey || !c.from) { res.status(400).json({ error: "Save a Resend API key and a sender first." }); return; }
    const sent = await resendApi(c.resendKey, fetchImpl).send({ from: c.from, to: [to], subject: `${appName()} test email`, text: `This is a test from the ${appName()} admin settings, sent by ${authLocals(res).staff!.name}. Email is working.`, ...(c.replyTo ? { replyTo: c.replyTo } : {}) });
    if (!sent.ok) { res.status(502).json({ error: sent.error }); return; }
    res.json({ message: `Test email sent to ${to}.` });
  });

  // ---------- Domain (sending and receiving) ----------

  const domainKey = async (res: Response) => {
    const c = await config();
    if (!c.resendKey) { res.status(400).json({ error: "Save a Resend API key first." }); return null; }
    return resendApi(c.resendKey, fetchImpl);
  };

  router.post("/email/domain", admin, async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim().toLowerCase() : "";
    if (!DOMAIN.test(name)) { res.status(400).json({ error: "Enter a domain such as novabridgegrant.org.", fieldErrors: { name: "Enter a domain such as novabridgegrant.org." } }); return; }
    const api = await domainKey(res); if (!api) return;
    // Reuse the domain if it's already in this Resend account.
    const existing = await api.listDomains();
    let domain = existing.ok ? existing.data.data.find(d => d.name === name) : undefined;
    if (!domain) {
      const created = await api.createDomain(name, req.body?.receiving !== false);
      if (!created.ok) { res.status(502).json({ error: created.error }); return; }
      domain = created.data;
    }
    await settings.save({ domainName: name, domainId: domain.id }, authLocals(res).staff!.name, audit(req, res, "Set email domain", `Email domain set to ${name}.`, [{ field: "domain", before: "—", after: name }]));
    const full = await api.getDomain(domain.id);
    res.json(full.ok ? full.data : domain);
  });

  router.get("/email/domain", admin, async (_req, res) => {
    const s = await settings.get();
    if (!s.domainId) { res.json(null); return; }
    const api = await domainKey(res); if (!api) return;
    const got = await api.getDomain(s.domainId);
    if (!got.ok) { res.status(502).json({ error: got.error }); return; }
    res.json(got.data);
  });

  router.post("/email/domain/verify", admin, async (_req, res) => {
    const s = await settings.get();
    if (!s.domainId) { res.status(400).json({ error: "Add a domain first." }); return; }
    const api = await domainKey(res); if (!api) return;
    const verified = await api.verifyDomain(s.domainId);
    if (!verified.ok) { res.status(502).json({ error: verified.error }); return; }
    const got = await api.getDomain(s.domainId);
    res.json(got.ok ? got.data : { id: s.domainId, name: s.domainName, status: "pending" });
  });

  // ---------- Application name ----------

  router.put("/branding", admin, async (req, res) => {
    const raw = req.body?.appName;
    if (typeof raw !== "string") { res.status(400).json({ error: "Enter the application name." }); return; }
    const name = raw.trim().replace(/\s+/g, " ");
    // Empty restores the default. The name goes into email subjects, HTML, and authenticator apps, so keep it plain.
    if (name && !APP_NAME.test(name)) { res.status(400).json({ error: "Use up to 40 letters, numbers, spaces, and . - & ' only.", fieldErrors: { appName: "Use up to 40 letters, numbers, spaces, and . - & ' only." } }); return; }
    const before = appName();
    const next = name && name !== DEFAULT_APP_NAME ? name : null;
    await settings.save({ appName: next }, authLocals(res).staff!.name, audit(req, res, "Change application name", `Application name changed from ${before} to ${next ?? DEFAULT_APP_NAME}.`, [{ field: "Application name", before, after: next ?? DEFAULT_APP_NAME }]));
    setAppName(next);
    res.json(brandingView(next));
  });

  // ---------- Sign-up email confirmation (Supabase) ----------

  // Sign-up confirmation, password reset, and two-step emails come from
  // Supabase Auth, not the outbox. These routes switch confirmation on or off,
  // point Supabase's mailer at Resend's SMTP relay (with the saved Resend key
  // and sender), and install the app's wording for those emails.

  const management = async (res: Response) => {
    const c = await config();
    const ref = projectRef(env["SUPABASE_URL"]);
    if (!c.supabaseToken || !ref) { res.status(400).json({ error: "Save a Supabase access token first." }); return null; }
    return { c, api: supabaseManagement(c.supabaseToken, ref, fetchImpl) };
  };
  const authState = (a: SupabaseAuthConfig) => ({
    connected: true, emailConfirmation: !a.mailer_autoconfirm,
    smtp: { viaResend: a.smtp_host === RESEND_SMTP.host, host: a.smtp_host || null, sender: a.smtp_admin_email ? `${a.smtp_sender_name ? `${a.smtp_sender_name} ` : ""}<${a.smtp_admin_email}>` : null, emailsPerHour: a.rate_limit_email_sent ?? null },
    appTemplates: usesAppTemplates(a),
  });

  router.get("/email/auth-settings", admin, async (_req, res) => {
    const c = await config();
    const ref = projectRef(env["SUPABASE_URL"]);
    if (!c.supabaseToken || !ref) { res.json({ connected: false, emailConfirmation: null }); return; }
    const got = await supabaseManagement(c.supabaseToken, ref, fetchImpl).getAuthConfig();
    if (!got.ok) { res.json({ connected: false, emailConfirmation: null, error: got.error }); return; }
    res.json(authState(got.data));
  });

  router.put("/email/auth-settings", admin, async (req, res) => {
    const required = req.body?.emailConfirmation;
    if (typeof required !== "boolean") { res.status(400).json({ error: "Say whether email confirmation is required." }); return; }
    const m = await management(res); if (!m) return;
    const done = await m.api.setEmailConfirmation(required);
    if (!done.ok) { res.status(502).json({ error: done.error }); return; }
    await settings.record(audit(req, res, "Change sign-up email confirmation", required ? "New accounts must confirm their email." : "New accounts no longer confirm their email.", [{ field: "email confirmation", before: String(!required), after: String(required) }]));
    res.json(authState(done.data));
  });

  router.post("/email/auth-settings/smtp", admin, async (req, res) => {
    const m = await management(res); if (!m) return;
    const { c } = m;
    if (!c.resendKey || !c.from) { res.status(400).json({ error: "Save a Resend API key and a sender first." }); return; }
    // Resend refuses mail from an unverified domain, and Supabase would then fail every sign-up email.
    const s = await settings.get();
    if (s.domainId) {
      const domain = await resendApi(c.resendKey, fetchImpl).getDomain(s.domainId);
      if (domain.ok && domain.data.status !== "verified") { res.status(400).json({ error: `Verify ${domain.data.name} in Resend first (it's ${domain.data.status}).` }); return; }
    }
    const sender = addressOf(c.from);
    const name = nameOf(c.from) ?? appName();
    const done = await m.api.updateAuthConfig({ smtp_host: RESEND_SMTP.host, smtp_port: RESEND_SMTP.port, smtp_user: RESEND_SMTP.user, smtp_pass: c.resendKey, smtp_admin_email: sender, smtp_sender_name: name });
    if (!done.ok) { res.status(502).json({ error: done.error }); return; }
    await settings.record(audit(req, res, "Send sign-in emails through Resend", `Supabase's sign-up, reset, and two-step emails now go through Resend from ${sender}.`, [{ field: "Supabase SMTP", before: "—", after: `${RESEND_SMTP.host} as ${name} <${sender}>, Resend key …${c.resendKey.slice(-4)}` }]));
    logger.info({ actor: authLocals(res).staff!.id }, "supabase smtp set to resend");
    res.json(authState(done.data));
  });

  router.post("/email/auth-settings/templates", admin, async (req, res) => {
    const m = await management(res); if (!m) return;
    const done = await m.api.updateAuthConfig(authEmailTemplateConfig());
    if (!done.ok) { res.status(502).json({ error: done.error }); return; }
    await settings.record(audit(req, res, "Set sign-in email wording", `Supabase's sign-up, reset, invite, email-change, sign-in link, and verification-code emails now use the app's wording as ${appName()}.`, [{ field: "Supabase email templates", before: "—", after: `${appName()} wording` }]));
    res.json(authState(done.data));
  });

  // ---------- Team inbox ----------

  const FOLDERS: InboxFolder[] = ["inbox", "sent", "archive", "trash"];

  router.get("/inbox", requireStaff, async (req, res) => {
    const folder = (FOLDERS as string[]).includes(String(req.query["folder"])) ? req.query["folder"] as InboxFolder : "inbox";
    const c = await config();
    res.json({ address: c.inboxAddress ?? (c.from ? addressOf(c.from) : null), receiving: !!c.webhookSecret, sending: !!c.resendKey && !!c.from, unread: await inbox.unreadCount(), messages: await inbox.list(folder) });
  });

  router.post("/inbox/:id/update", requireStaff, async (req, res) => {
    const folder = req.body?.folder; const read = req.body?.read;
    if (folder !== undefined && !(FOLDERS as unknown[]).includes(folder)) { res.status(400).json({ error: "Unknown folder." }); return; }
    if (read !== undefined && typeof read !== "boolean") { res.status(400).json({ error: "Say read or unread." }); return; }
    const updated = await inbox.update(String(req.params["id"]), { ...(folder ? { folder } : {}), ...(read !== undefined ? { read } : {}) });
    if (!updated) { res.status(404).json({ error: "That message could not be found." }); return; }
    res.json(updated);
  });

  router.post("/inbox/send", requireStaff, async (req, res) => {
    const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map(x => String(x).trim()).filter(Boolean);
    const to = list(req.body?.to), cc = list(req.body?.cc);
    const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
    const body = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const errors: Record<string, string> = {};
    if (!to.length || to.length > 20 || !to.every(a => EMAIL.test(a))) errors["to"] = "Enter one or more valid addresses, separated by commas.";
    if (cc.length > 20 || !cc.every(a => EMAIL.test(a))) errors["cc"] = "Enter valid addresses, separated by commas.";
    if (!subject || subject.length > 200) errors["subject"] = "Enter a subject (up to 200 characters).";
    if (!body || body.length > 20_000) errors["text"] = "Write a message (up to 20,000 characters).";
    if (Object.keys(errors).length) { res.status(400).json({ error: "Fix the highlighted fields.", fieldErrors: errors }); return; }
    const c = await config();
    if (!c.resendKey || !c.from) { res.status(400).json({ error: "Email sending isn't set up. A super admin can add the Resend key and sender in Settings." }); return; }
    const original = typeof req.body?.inReplyTo === "string" ? await inbox.get(req.body.inReplyTo) : null;
    const address = c.inboxAddress ?? addressOf(c.from);
    const from = c.inboxAddress ? `${nameOf(c.from) ?? appName()} <${c.inboxAddress}>` : c.from;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${body.split(/\n{2,}/).map((p: string) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`).join("")}</div>`;
    const staff = authLocals(res).staff!;
    const sent = await resendApi(c.resendKey, fetchImpl).send({
      from, to, subject, text: body, html, replyTo: address,
      ...(original?.messageId ? { headers: { "In-Reply-To": original.messageId, References: original.messageId } } : {}),
    });
    if (!sent.ok) { res.status(502).json({ error: sent.error }); return; }
    const saved = await inbox.addOutbound({
      direction: "outbound", resendId: sent.data.id, messageId: null, inReplyTo: original?.id ?? null, from, to, cc, subject, text: body, html,
      attachments: [], status: "sent", folder: "sent", sentBy: staff.name, at: new Date().toISOString(),
    });
    if (original && !original.read) await inbox.update(original.id, { read: true });
    await settings.record(audit(req, res, "Send email", `Sent "${subject}" to ${to.join(", ")}.`, [{ field: "to", before: "—", after: to.join(", ") }, { field: "subject", before: "—", after: subject }]));
    res.status(201).json(saved);
  });

  return router;
}

/**
 * POST /api/email/webhook: Resend events, signed with the webhook signing
 * secret. Received mail (email.received) is fetched from Resend and stored in
 * the team inbox; delivery events update sent mail. Mounted before sign-in.
 */
/** Public (before sign-in): the application name, so sign-in pages can show it. */
export function brandingRouter(settings: EmailSettingsRepo): IRouter {
  const router: IRouter = Router();
  router.get("/branding", async (_req, res) => {
    const saved = (await settings.get()).appName;
    setAppName(saved);
    res.json(brandingView(saved));
  });
  return router;
}

export function emailWebhookRouter({ outbox, settings, inbox, fetchImpl = fetch, env = process.env }: EmailDeps): IRouter {
  const router: IRouter = Router();
  const DELIVERY: Record<string, string> = { "email.delivered": "delivered", "email.bounced": "bounced", "email.complained": "complained", "email.delivery_delayed": "delayed", "email.failed": "failed" };

  router.post("/email/webhook", async (req, res) => {
    const c = effectiveConfig(await settings.get(), env);
    if (!c.webhookSecret) { res.status(503).json({ error: "The webhook signing secret isn't set." }); return; }
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const ok = !!raw && verifyWebhook(c.webhookSecret, { id: req.header("svix-id"), timestamp: req.header("svix-timestamp"), signature: req.header("svix-signature") }, raw);
    if (!ok) { req.log?.warn("email webhook with a bad signature"); res.status(401).json({ error: "Invalid signature." }); return; }

    const event = req.body as { type?: string; data?: Record<string, unknown> };
    const data = event.data ?? {};
    const emailId = typeof data["email_id"] === "string" ? data["email_id"] : null;
    if (event.type === "email.received" && emailId) {
      const meta = data as { from?: string; to?: string[]; cc?: string[]; subject?: string; message_id?: string; created_at?: string; attachments?: { id: string; filename: string; content_type: string }[] };
      const full = c.resendKey ? await resendApi(c.resendKey, fetchImpl).getReceivedEmail(emailId) : null;
      const m = full?.ok ? full.data : null;
      if (full && !full.ok) logger.warn({ emailId, error: full.error }, "couldn't fetch a received email's content");
      const stored = await inbox.addInbound({
        direction: "inbound", resendId: emailId, messageId: m?.message_id ?? meta.message_id ?? null, inReplyTo: null,
        from: m?.from ?? meta.from ?? "unknown", to: m?.to ?? meta.to ?? [], cc: m?.cc ?? meta.cc ?? [], subject: m?.subject ?? meta.subject ?? "(no subject)",
        text: m?.text ?? null, html: m?.html ?? null,
        attachments: (m?.attachments ?? meta.attachments ?? []).map(a => ({ id: a.id, filename: a.filename, contentType: a.content_type, size: "size" in a && typeof a.size === "number" ? a.size : null })),
        status: null, folder: "inbox", sentBy: null, at: m?.created_at ?? meta.created_at ?? new Date().toISOString(),
      });
      if (stored) logger.info({ id: stored.id }, "email received");
    } else if (event.type && DELIVERY[event.type] && emailId) {
      await outbox.recordDelivery(emailId, DELIVERY[event.type]!);
      await inbox.setStatusByResendId(emailId, DELIVERY[event.type]!);
    }
    res.json({ received: true });
  });
  return router;
}
