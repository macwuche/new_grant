import { Router, type IRouter, type Request, type Response } from "express";
import { auditEntry, type Effects } from "../lib/activity";
import { appName, mailerFor, renderMessageEmail, setAppUrlOverride, type EmailOutbox } from "../lib/email";
import { effectiveConfig, type EmailSettingsPatch, type EmailSettingsRepo } from "../lib/emailSettings";
import type { FileStore } from "../lib/fileStore";
import type { InboxAttachment, InboxFolder, InboxMessage, InboxRepo } from "../lib/inbox";
import { checkInboxAttachments, INBOX_FILES_OWNER, loadInboxAttachment, MAX_INBOX_ATTACHMENTS, type AttachmentSource } from "../lib/inboxAttachments";
import { logger } from "../lib/logger";
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
// and mail sent from it; drafts, each seen only by the person writing it.
//
// The webhook (public, signature-checked) is a separate router mounted before
// sign-in: see emailWebhookRouter.

export type EmailDeps = { outbox: EmailOutbox; settings: EmailSettingsRepo; inbox: InboxRepo; files?: FileStore; fetchImpl?: Fetch; env?: NodeJS.ProcessEnv };

/** A message as staff see it: where an attachment's file is kept stays on the server; `downloadable` says whether it opens here (ours from the disk, received ones from Resend). */
export const inboxView = (m: InboxMessage) => ({
  ...m, attachments: m.attachments.map(({ key, sha256: _sha, ...a }) => ({ ...a, downloadable: !!key || (m.direction === "inbound" && !!m.resendId) })),
});

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const FROM = /^(?:[^<>]{1,80}<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const addressOf = (from: string) => /<([^>]+)>/.exec(from)?.[1] ?? from;
const nameOf = (from: string) => /^([^<]+)</.exec(from)?.[1]?.trim() ?? null;

export function emailRouter({ outbox, settings, inbox, files, fetchImpl = fetch, env = process.env }: EmailDeps): IRouter {
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
    // Scoped and legacy access tokens differ in format, so only the shape is checked here; Supabase checks the token itself below.
    // Project API keys (sb_publishable_…, sb_secret_…, JWT anon/service keys) can't call the Management API.
    if (/^(sb_publishable_|sb_secret_|eyJ)/.test(text("supabaseToken") ?? "")) errors["supabaseToken"] = "That's a project API key. Create an access token in Supabase → Account → Access Tokens.";
    else field("supabaseToken", "Supabase access token", v => /^[A-Za-z0-9_.-]{20,512}$/.test(v), "Paste the whole access token, with no spaces.", true);
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
    if (!DOMAIN.test(name)) { res.status(400).json({ error: "Enter a domain such as yourdomain.org.", fieldErrors: { name: "Enter a domain such as yourdomain.org." } }); return; }
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

  // ---------- Sign-up email confirmation (Supabase) ----------

  // Sign-up confirmation, password reset, and two-step emails: Supabase Auth
  // makes the links and codes, and hands every email to the Send Email Hook
  // (routes/authEmailHook.ts), which sends it through Resend. Supabase itself
  // sends nothing. These routes report whether that chain is ready and switch
  // sign-up confirmation on or off (the switch needs the Supabase access token).

  const management = async (res: Response) => {
    const c = await config();
    const ref = projectRef(env["SUPABASE_URL"]);
    if (!c.supabaseToken || !ref) { res.status(400).json({ error: "Save a Supabase access token first." }); return null; }
    return { c, api: supabaseManagement(c.supabaseToken, ref, fetchImpl) };
  };
  /** The server's side of the hook, plus Supabase's side when the token can read it (null when it can't). */
  const hookState = (c: Awaited<ReturnType<typeof config>>, a: SupabaseAuthConfig | null) => ({
    url: c.appUrl ? `${c.appUrl}/api/auth/email-hook` : null,
    secretSet: !!env["SUPABASE_EMAIL_HOOK_SECRET"]?.trim(),
    sending: !!c.resendKey && !!c.from,
    enabled: a ? !!a.hook_send_email_enabled : null,
    supabaseUrl: a ? a.hook_send_email_uri || null : null,
  });
  const authState = (c: Awaited<ReturnType<typeof config>>, a: SupabaseAuthConfig) => ({ connected: true, emailConfirmation: !a.mailer_autoconfirm, hook: hookState(c, a) });

  router.get("/email/auth-settings", admin, async (_req, res) => {
    const c = await config();
    const ref = projectRef(env["SUPABASE_URL"]);
    if (!c.supabaseToken || !ref) { res.json({ connected: false, emailConfirmation: null, hook: hookState(c, null) }); return; }
    const got = await supabaseManagement(c.supabaseToken, ref, fetchImpl).getAuthConfig();
    if (!got.ok) { res.json({ connected: false, emailConfirmation: null, hook: hookState(c, null), error: got.error }); return; }
    res.json(authState(c, got.data));
  });

  router.put("/email/auth-settings", admin, async (req, res) => {
    const required = req.body?.emailConfirmation;
    if (typeof required !== "boolean") { res.status(400).json({ error: "Say whether email confirmation is required." }); return; }
    const m = await management(res); if (!m) return;
    const done = await m.api.setEmailConfirmation(required);
    if (!done.ok) { res.status(502).json({ error: done.error }); return; }
    await settings.record(audit(req, res, "Change sign-up email confirmation", required ? "New accounts must confirm their email." : "New accounts no longer confirm their email.", [{ field: "email confirmation", before: String(!required), after: String(required) }]));
    res.json(authState(m.c, done.data));
  });

  // ---------- Team inbox ----------

  /** Folders mail can be moved between; Drafts is listed too, but drafts are only saved, sent, or discarded. */
  const FOLDERS: InboxFolder[] = ["inbox", "sent", "archive", "trash"];
  const LISTED: InboxFolder[] = [...FOLDERS, "drafts"];
  /** A message this staff member may open: everything except other people's drafts. */
  const visible = (m: InboxMessage | null, staffId: string) => m && (m.folder !== "drafts" || m.sentBy === staffId) ? m : null;
  const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map(x => String(x).trim()).filter(Boolean);
  /** The sender line for mail from the team: the team mailbox when one is set, else the sender. */
  const senderOf = (c: Awaited<ReturnType<typeof config>>) => c.inboxAddress ? `${nameOf(c.from ?? "") ?? appName()} <${c.inboxAddress}>` : c.from ?? "";

  router.get("/inbox", requireStaff, async (req, res) => {
    const folder = (LISTED as string[]).includes(String(req.query["folder"])) ? req.query["folder"] as InboxFolder : "inbox";
    const c = await config();
    const messages = folder === "drafts" ? await inbox.list("drafts", authLocals(res).staff!.id) : await inbox.list(folder);
    res.json({ address: c.inboxAddress ?? (c.from ? addressOf(c.from) : null), receiving: !!c.webhookSecret, sending: !!c.resendKey && !!c.from, unread: await inbox.unreadCount(), messages: messages.map(inboxView) });
  });

  router.post("/inbox/:id/update", requireStaff, requirePermission("inbox.send"), async (req, res) => {
    const folder = req.body?.folder; const read = req.body?.read;
    if (folder !== undefined && !(FOLDERS as unknown[]).includes(folder)) { res.status(400).json({ error: "Unknown folder." }); return; }
    if (read !== undefined && typeof read !== "boolean") { res.status(400).json({ error: "Say read or unread." }); return; }
    const current = visible(await inbox.get(String(req.params["id"])), authLocals(res).staff!.id);
    if (!current) { res.status(404).json({ error: "That message could not be found." }); return; }
    if (current.folder === "drafts") { res.status(400).json({ error: "Drafts are sent or discarded, not moved." }); return; }
    const updated = await inbox.update(current.id, { ...(folder ? { folder } : {}), ...(read !== undefined ? { read } : {}) });
    if (!updated) { res.status(404).json({ error: "That message could not be found." }); return; }
    res.json(inboxView(updated));
  });

  /** Types a received file is sent back as; anything else goes out as a plain download. */
  const SAFE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/csv"]);

  // Any attachment (any active staff member, like reading): files attached here from the disk, received ones fetched from Resend.
  router.get("/inbox/:id/attachments/:attachmentId", requireStaff, async (req, res) => {
    const message = visible(await inbox.get(String(req.params["id"])), authLocals(res).staff!.id);
    const att = message?.attachments.find(a => a.id === req.params["attachmentId"]);
    if (!message || !att) { res.status(404).json({ error: "That attachment could not be found." }); return; }
    const loaded = await loadInboxAttachment(message, att, { files, resendKey: (await config()).resendKey, fetchImpl });
    if (!loaded.ok) { res.status(loaded.status).json({ error: loaded.error }); return; }
    await settings.record({ notifications: [], staffEvents: [], audit: [auditEntry(auditContext(req, res, "Open email attachment", message.id), `Opened ${att.filename} from "${message.subject}"${att.key ? "" : " (received)"}.`, [], new Date())] });
    const type = att.contentType.toLowerCase().split(";")[0]!.trim();
    res.set({
      "Content-Type": att.key || SAFE_TYPES.has(type) ? type : "application/octet-stream",
      "Content-Length": String(loaded.bytes.length),
      "Content-Disposition": `attachment; filename="${att.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    res.end(loaded.bytes);
  });

  type Carried = { slots: ({ kept: InboxAttachment } | { source: number })[]; kept: (InboxAttachment & { bytes?: Buffer })[]; sources: AttachmentSource[] };
  /**
   * Files carried from other messages (`[{ messageId, attachmentId }]`): forwarded ones are read (from the disk or Resend) to be
   * checked and stored again; the draft's own (`draftId`) are kept as they are, and read only when `read` (to send them).
   */
  async function carried(input: unknown, staffId: string, draftId: string | null, read: boolean): Promise<{ ok: true; value: Carried } | { ok: false; error: string }> {
    if (input === undefined || input === null) return { ok: true, value: { slots: [], kept: [], sources: [] } };
    if (!Array.isArray(input) || input.length > MAX_INBOX_ATTACHMENTS) return { ok: false, error: `Attach at most ${MAX_INBOX_ATTACHMENTS} files.` };
    const resendKey = (await config()).resendKey;
    const value: Carried = { slots: [], kept: [], sources: [] };
    const seen = new Set<string>();
    for (const ref of input as { messageId?: unknown; attachmentId?: unknown }[]) {
      const messageId = typeof ref?.messageId === "string" ? ref.messageId : "", attachmentId = typeof ref?.attachmentId === "string" ? ref.attachmentId : "";
      if (seen.has(`${messageId}/${attachmentId}`)) continue;
      seen.add(`${messageId}/${attachmentId}`);
      const message = visible(await inbox.get(messageId), staffId);
      const att = message?.attachments.find(a => a.id === attachmentId);
      if (!message || !att) return { ok: false, error: "An attached file is no longer there. Remove it and attach it again." };
      if (message.folder === "drafts" && message.id !== draftId) return { ok: false, error: `${att.filename} is on another draft. Attach it again.` };
      if (message.id === draftId) {
        let bytes: Buffer | undefined;
        if (read) { const got = await loadInboxAttachment(message, att, { files, resendKey, fetchImpl }); if (!got.ok) return { ok: false, error: got.error }; bytes = got.bytes; }
        value.kept.push({ ...att, ...(bytes ? { bytes } : {}) }); value.slots.push({ kept: att });
        continue;
      }
      const got = await loadInboxAttachment(message, att, { files, resendKey, fetchImpl });
      if (!got.ok) return { ok: false, error: got.error };
      value.slots.push({ source: value.sources.length }); value.sources.push({ filename: att.filename, bytes: got.bytes });
    }
    return { ok: true, value };
  }

  /**
   * Checks and stores the files of a message being sent or saved: carried ones (in their order), then new ones. Files are
   * stored before anything else happens, so a full disk (507) changes nothing. `discard` removes what this call stored.
   */
  async function prepareFiles(req: Request, res: Response, draftId: string | null, read: boolean, errors: Record<string, string>) {
    const from = await carried(req.body?.existingAttachments, authLocals(res).staff!.id, draftId, read);
    if (!from.ok) { errors["attachments"] = from.error; return null; }
    const { slots, kept, sources } = from.value;
    const attached = await checkInboxAttachments(req.body?.attachments, { sources, kept });
    if (!attached.ok) { errors["attachments"] = attached.error; return null; }
    if (attached.files.length && !files) { errors["attachments"] = "Attachments can't be stored on this server."; return null; }
    const stored = attached.files.map(f => ({ ...f, key: `${INBOX_FILES_OWNER}/${f.id}` }));
    const record = (f: (typeof stored)[number]): InboxAttachment => ({ id: f.id, filename: f.filename, contentType: f.contentType, size: f.size, key: f.key, sha256: f.sha256 });
    // The message's files: carried ones where they were in the list, then the new ones.
    const attachments = [...slots.map(s => "kept" in s ? s.kept : record(stored[s.source]!)), ...stored.slice(sources.length).map(record)];
    const bytesOf = new Map<string, Buffer>([...kept.filter(k => k.bytes).map(k => [k.id, k.bytes!] as const), ...stored.map(f => [f.id, f.bytes] as const)]);
    return { stored, attachments, bytesOf };
  }
  const storeAll = async (stored: { key: string; bytes: Buffer }[]) => {
    const discard = () => Promise.all(stored.map(f => files!.remove(f.key)));
    for (const f of stored) {
      try { await files!.put(f.key, f.bytes); } catch (err) { await discard(); throw err; }
    }
    return discard;
  };
  /** Removes a draft's files that the message it became (or its newer save) no longer has. */
  const dropFiles = async (before: InboxAttachment[], after: InboxAttachment[]) => {
    for (const a of before) if (a.key && !after.some(b => b.id === a.id)) await files?.remove(a.key);
  };
  /** The draft being written, if this staff member owns it. */
  const ownDraft = async (id: unknown, staffId: string) => {
    if (typeof id !== "string") return null;
    const m = visible(await inbox.get(id), staffId);
    return m?.folder === "drafts" ? m : null;
  };

  // Drafts: saved by the composer every few seconds and on close; seen only by their author; not audited (sending is).
  router.post("/inbox/drafts", requireStaff, requirePermission("inbox.send"), async (req, res) => {
    const staff = authLocals(res).staff!;
    const existing = req.body?.id === undefined ? null : await ownDraft(req.body.id, staff.id);
    if (req.body?.id !== undefined && !existing) { res.status(404).json({ error: "That draft could not be found. It may have been sent or discarded." }); return; }
    const to = list(req.body?.to), cc = list(req.body?.cc), bcc = list(req.body?.bcc);
    const subject = typeof req.body?.subject === "string" ? req.body.subject : "";
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const errors: Record<string, string> = {};
    for (const [name, v] of [["to", to], ["cc", cc], ["bcc", bcc]] as const) if (v.length > 50 || v.some(a => a.length > 320)) errors[name] = "That's too many addresses for one message.";
    if (subject.length > 200) errors["subject"] = "Keep the subject to 200 characters or fewer.";
    if (text.length > 20_000) errors["text"] = "Keep the message to 20,000 characters or fewer.";
    const prepared = Object.keys(errors).length ? null : await prepareFiles(req, res, existing?.id ?? null, false, errors);
    if (!prepared) { res.status(400).json({ error: "Fix the highlighted fields.", fieldErrors: errors }); return; }
    const discard = await storeAll(prepared.stored);
    const original = typeof req.body?.inReplyTo === "string" ? visible(await inbox.get(req.body.inReplyTo), staff.id) : null;
    const saved = await inbox.saveDraft({
      direction: "outbound", resendId: null, messageId: null, inReplyTo: original && original.folder !== "drafts" ? original.id : null, from: senderOf(await config()),
      to, cc, bcc, subject, text, html: null, attachments: prepared.attachments, status: null, folder: "drafts", sentBy: staff.id, at: new Date().toISOString(),
    }, existing?.id);
    if (!saved) { await discard(); res.status(404).json({ error: "That draft could not be found. It may have been sent or discarded." }); return; }
    if (existing) await dropFiles(existing.attachments, saved.attachments);
    res.status(existing ? 200 : 201).json(inboxView(saved));
  });

  router.post("/inbox/drafts/:id/delete", requireStaff, requirePermission("inbox.send"), async (req, res) => {
    const draft = await ownDraft(String(req.params["id"]), authLocals(res).staff!.id);
    if (!draft || !(await inbox.removeDraft(draft.id))) { res.status(404).json({ error: "That draft could not be found. It may have been sent or discarded." }); return; }
    await dropFiles(draft.attachments, []);
    res.json({ message: "Draft discarded." });
  });

  router.post("/inbox/send", requireStaff, requirePermission("inbox.send"), async (req, res) => {
    const staff = authLocals(res).staff!;
    const to = list(req.body?.to), cc = list(req.body?.cc), bcc = list(req.body?.bcc);
    // One key per message the composer opened: a double click or a retry after a lost answer sends once.
    const key = typeof req.body?.idempotencyKey === "string" && /^[A-Za-z0-9-]{8,100}$/.test(req.body.idempotencyKey) ? req.body.idempotencyKey : null;
    const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
    const body = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    // Sending a saved draft: its files go with the message as they are, and the draft is removed once Resend accepts it.
    const draft = await ownDraft(req.body?.draftId, staff.id);
    const errors: Record<string, string> = {};
    if (!to.length || to.length > 20 || !to.every(a => EMAIL.test(a))) errors["to"] = "Enter one or more valid addresses, separated by commas.";
    if (cc.length > 20 || !cc.every(a => EMAIL.test(a))) errors["cc"] = "Enter valid addresses, separated by commas.";
    if (bcc.length > 20 || !bcc.every(a => EMAIL.test(a))) errors["bcc"] = "Enter valid addresses, separated by commas.";
    else if (to.length + cc.length + bcc.length > 50) errors["bcc"] = "Send to at most 50 people in all (To, Cc, and Bcc).";
    if (!subject || subject.length > 200) errors["subject"] = "Enter a subject (up to 200 characters).";
    if (!body || body.length > 20_000) errors["text"] = "Write a message (up to 20,000 characters).";
    const c = await config();
    const prepared = Object.keys(errors).length ? null : await prepareFiles(req, res, draft?.id ?? null, true, errors);
    if (!prepared) { res.status(400).json({ error: "Fix the highlighted fields.", fieldErrors: errors }); return; }
    if (!c.resendKey || !c.from) { res.status(400).json({ error: "Email sending isn't set up. A super admin can add the Resend key and sender in Settings." }); return; }
    const original = typeof req.body?.inReplyTo === "string" ? visible(await inbox.get(req.body.inReplyTo), staff.id) : null;
    const address = c.inboxAddress ?? addressOf(c.from);
    const from = senderOf(c);
    const html = renderMessageEmail({ body, footer: `${appName()} · ${address}` });
    // Files are stored before sending, so a full disk refuses the message (507) instead of sending one whose Sent copy lacks them.
    const discard = await storeAll(prepared.stored);
    const sent = await resendApi(c.resendKey, fetchImpl).send({
      from, to, cc, bcc, subject, text: body, html, replyTo: address,
      ...(original?.messageId ? { headers: { "In-Reply-To": original.messageId, References: original.messageId } } : {}),
      ...(prepared.attachments.length ? { attachments: prepared.attachments.map(a => ({ filename: a.filename, content: prepared.bytesOf.get(a.id)!.toString("base64") })) } : {}),
    }, key ? `inbox-${staff.id}-${key}` : undefined);
    if (!sent.ok) { await discard(); res.status(502).json({ error: sent.error }); return; }
    const at = new Date().toISOString();
    const saved = await inbox.addOutbound({
      direction: "outbound", resendId: sent.data.id, messageId: null, inReplyTo: original && original.folder !== "drafts" ? original.id : null, from, to, cc, bcc, subject, text: body, html,
      attachments: prepared.attachments, status: "sent", folder: "sent", sentBy: staff.name, at,
    });
    // A repeat of a send Resend already accepted: same message (its files were kept the first time), so no second audit entry.
    if (saved.at !== at) { await discard(); res.status(201).json(inboxView(saved)); return; }
    if (draft && await inbox.removeDraft(draft.id)) await dropFiles(draft.attachments, saved.attachments);
    if (original && !original.read) await inbox.update(original.id, { read: true });
    const recipients = [...to, ...cc.map(a => `${a} (cc)`), ...bcc.map(a => `${a} (bcc)`)].join(", ");
    const fileNames = saved.attachments.map(f => f.filename).join(", ");
    await settings.record(audit(req, res, "Send email", `Sent "${subject}" to ${recipients}${fileNames ? ` with ${fileNames}` : ""}.`, [
      { field: "to", before: "—", after: recipients }, { field: "subject", before: "—", after: subject },
      ...(fileNames ? [{ field: "attachments", before: "—", after: fileNames }] : []),
    ]));
    res.status(201).json(inboxView(saved));
  });

  return router;
}

/**
 * POST /api/email/webhook: Resend events, signed with the webhook signing
 * secret. Received mail (email.received) is fetched from Resend and stored in
 * the team inbox; delivery events update sent mail. Mounted before sign-in.
 */
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
        from: m?.from ?? meta.from ?? "unknown", to: m?.to ?? meta.to ?? [], cc: m?.cc ?? meta.cc ?? [], bcc: [], subject: m?.subject ?? meta.subject ?? "(no subject)",
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
