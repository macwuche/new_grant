import { createHash } from "node:crypto";
import express, { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { CheckPasswordBody, CompleteCredentialResetBody, GetProfileResponse, ReportSecurityEventBody, SetPrivacyBody, SubmitIdentityCheckBody, UpdateProfileBody } from "@workspace/api-zod";
import { completeCredentialReset, recordPasswordChange, submitKyc } from "@workspace/domain/accounts";
import type { DemoState, Result } from "@workspace/domain/model";
import { cleanPersonalDetails, validatePersonalDetails } from "@workspace/domain/profile";
import { NO_EFFECTS, type ActivityRepo, type Effects } from "../lib/activity";
import type { AuthUser } from "../lib/auth";
import { runAccountRule } from "../lib/applicantRules";
import type { DocumentRepo } from "../lib/documentRepo";
import { newStorageKey, type FileStore } from "../lib/fileStore";
import { logger } from "../lib/logger";
import type { ProfileRecord, ProfileRepo } from "../lib/profileRepo";
import { requestOrigin, securityEvent } from "../lib/securityEvents";
import { authLocals } from "../middlewares/auth";
import { inspectUpload } from "../lib/uploadSafety";
import { rebuildImage } from "../lib/imageRebuild";

// The signed-in person's applicant profile. Ownership comes only from the
// verified token: there is no way to name another user's profile.

/** A sign-up detail from Supabase metadata, trimmed and capped (the person can edit metadata, so it's untrusted). */
const detail = (metadata: Record<string, unknown> | undefined, key: string, max: number) => {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim().slice(0, max) : "";
};

export const toProfile = (r: ProfileRecord) => GetProfileResponse.parse({
  name: r.name, email: r.email, phone: r.phone, address: r.address, sector: r.sector, country: r.country,
  tier: r.tier, identityVerified: r.identityVerified, joined: r.createdAt.slice(0, 10), birthDate: r.birthDate, account: r.account,
  displayName: r.displayName, telegram: r.telegram, privacy: r.privacy, avatarUpdatedAt: r.avatar?.updatedAt ?? null,
});

/**
 * The email changed at Supabase (the person confirmed a new address): a
 * security event and an in-app notice. The change isn't seen from a request
 * of its own, so the event has no device or IP address.
 */
const emailChangedEffects = (r: ProfileRecord, email: string, now: Date): Effects => ({
  ...NO_EFFECTS,
  notifications: [{ applicantId: r.authUserId, at: now.toISOString(), href: "/profile", email: false, title: "Email address changed",
    body: `Your sign-in email is now ${email}. If this wasn't you, contact the grant team straight away.` }],
  security: [securityEvent(r.authUserId, "email_changed", r.privacy, null, now)],
});

/** Loads the profile, creating it from the sign-up details on first use and keeping the email in step with the account. */
export async function ownProfile(repo: ProfileRepo, user: AuthUser): Promise<ProfileRecord> {
  const email = user.email ?? "";
  const existing = await repo.get(user.id);
  if (existing) return existing.email === email ? existing : repo.updateContact(user.id, { email }, existing.email ? emailChangedEffects(existing, email, new Date()) : NO_EFFECTS);
  const birthDate = detail(user.metadata, "birth_date", 10);
  return repo.create({
    authUserId: user.id, email,
    name: detail(user.metadata, "full_name", 120) || email.split("@")[0] || "Applicant",
    phone: detail(user.metadata, "phone", 40), country: detail(user.metadata, "country", 80), sector: detail(user.metadata, "sector", 80),
    birthDate: /^\d{4}-\d{2}-\d{2}$/.test(birthDate) ? birthDate : null,
  });
}

/**
 * Why a staff-required reset can't be marked done yet, or null. A new password
 * needs a session from the reset-password email sent after the reset was
 * required (and the account updated since); two-step needs a two-step session
 * and an authenticator set up after the reset was required.
 */
export function resetProof(user: AuthUser, record: ProfileRecord, kind: "password" | "twoFactor"): string | null {
  const required = record.resetsRequiredAt[kind];
  if (!required) return null;
  const since = Date.parse(required);
  if (kind === "password") {
    const recovery = user.amr?.find(a => a.method === "recovery" && a.timestamp * 1000 >= since);
    const changed = !!recovery && !!user.updatedAt && Date.parse(user.updatedAt) >= recovery.timestamp * 1000;
    return changed ? null : "Use “Forgot password?” on the sign-in page, open the link we email you, and choose a new password. Then confirm here.";
  }
  const fresh = user.factors?.some(f => Date.parse(f.createdAt) >= since);
  return user.aal === "aal2" && fresh ? null : "Set up your authenticator app again (remove the old one and add a new one), sign in with a code, then confirm here.";
}

/** Profile photos: JPEG, PNG, or WEBP, at most 5 MB. */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** The image type, from its first bytes; null if it isn't an accepted type. */
export function detectImage(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Supabase Auth, for checking a current password from the server. */
export type PasswordChecker = (email: string, password: string) => Promise<"ok" | "wrong" | "limited" | "unavailable">;

/**
 * Checks a password with Supabase's password grant, then signs that throwaway
 * session out at once (scope=local: only that session), so the browser's own
 * session and its two-step level are untouched.
 */
export function supabasePasswordChecker(url: string, anonKey: string, fetchImpl: typeof fetch = fetch): PasswordChecker {
  const base = url.replace(/\/+$/, "");
  return async (email, password) => {
    let res: globalThis.Response;
    try {
      res = await fetchImpl(`${base}/auth/v1/token?grant_type=password`, {
        method: "POST", headers: { apikey: anonKey, "content-type": "application/json" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(8_000),
      });
    } catch { return "unavailable"; }
    if (res.status === 429) return "limited";
    if (res.status === 400 || res.status === 401) return "wrong";
    if (!res.ok) return "unavailable";
    const token = ((await res.json().catch(() => ({}))) as { access_token?: unknown }).access_token;
    if (typeof token === "string") {
      await fetchImpl(`${base}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: anonKey, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) })
        .catch(err => logger.warn({ err }, "couldn't sign out the password-check session"));
    }
    return "ok";
  };
}

export type ProfileDeps = { repo: ProfileRepo; documents: DocumentRepo; activity: ActivityRepo; files: FileStore; passwordChecker: PasswordChecker | null };

export function profileRouter({ repo, documents, activity, files, passwordChecker }: ProfileDeps): IRouter {
  const router: IRouter = Router();

  router.get("/profile", async (_req, res) => {
    res.json(toProfile(await ownProfile(repo, authLocals(res).user)));
  });

  router.patch("/profile", async (req, res) => {
    const body = UpdateProfileBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Send your name, phone, and address." }); return; }
    const { user } = authLocals(res);
    const current = await ownProfile(repo, user);
    // Fields an older portal doesn't send keep their saved values. The email isn't editable here (it's the sign-in account's).
    const input = {
      name: body.data.name, phone: body.data.phone, address: body.data.address,
      displayName: body.data.displayName ?? current.displayName, telegram: body.data.telegram ?? current.telegram, birthDate: body.data.birthDate ?? current.birthDate ?? "",
    };
    const fieldErrors = validatePersonalDetails(input, new Date());
    if (Object.keys(fieldErrors).length) { res.status(400).json({ error: "Fix the highlighted fields.", fieldErrors }); return; }
    const d = cleanPersonalDetails(input);
    const saved = await repo.updateContact(user.id, { name: d.name, phone: d.phone, address: d.address, displayName: d.displayName, telegram: d.telegram, birthDate: d.birthDate || null });
    res.json(toProfile(saved));
  });

  router.put("/profile/privacy", async (req, res) => {
    const body = SetPrivacyBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Say whether activity logging and unusual-activity email are on or off." }); return; }
    const { user } = authLocals(res);
    await ownProfile(repo, user);
    res.json(toProfile(await repo.updateContact(user.id, { privacy: body.data })));
  });

  // ---------- Profile photo (on the API server's disk, like documents) ----------

  router.get("/profile/avatar", async (_req, res) => {
    const record = await ownProfile(repo, authLocals(res).user);
    const avatar = record.avatar;
    if (!avatar) { res.status(404).json({ error: "No profile photo." }); return; }
    const bytes = await files.get(avatar.key);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== avatar.sha256) {
      logger.error({ owner: record.authUserId, missing: !bytes }, "profile photo is missing or doesn't match its record");
      res.status(404).json({ error: "Your profile photo couldn't be loaded. Upload it again." }); return;
    }
    res.set({ "Content-Type": avatar.contentType, "Content-Length": String(bytes.length), "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; sandbox" });
    res.end(bytes);
  });

  router.put("/profile/avatar", express.raw({ type: () => true, limit: MAX_AVATAR_BYTES }), async (req: Request, res: Response) => {
    const { user } = authLocals(res);
    const current = await ownProfile(repo, user);
    let bytes: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) { res.status(400).json({ error: "The file is empty." }); return; }
    const contentType = detectImage(bytes);
    if (!contentType) { res.status(415).json({ error: "Upload a JPG, PNG, or WEBP image." }); return; }
    const unsafe = inspectUpload(bytes, contentType);
    if (!unsafe.ok) { res.status(422).json({ error: unsafe.reason }); return; }
    // Pictures are stored as a copy rebuilt from their pixels; PDFs as they are (../lib/imageRebuild.ts).
    const rebuilt = await rebuildImage(bytes, contentType);
    if (!rebuilt.ok) { res.status(422).json({ error: rebuilt.reason }); return; }
    bytes = rebuilt.bytes;
    const key = newStorageKey(user.id);
    await files.put(key, bytes);
    let saved: ProfileRecord;
    try {
      saved = await repo.updateContact(user.id, { avatar: { key, contentType, sha256: createHash("sha256").update(bytes).digest("hex") } });
    } catch (err) {
      await files.remove(key).catch(() => {});
      throw err;
    }
    if (current.avatar) await files.remove(current.avatar.key).catch(err => logger.warn({ err }, "couldn't remove the old profile photo"));
    logger.info({ owner: user.id, bytes: bytes.length }, "profile photo updated");
    res.json(toProfile(saved));
  });

  router.post("/profile/avatar/delete", async (_req, res) => {
    const { user } = authLocals(res);
    const current = await ownProfile(repo, user);
    if (!current.avatar) { res.json(toProfile(current)); return; }
    const saved = await repo.updateContact(user.id, { avatar: null });
    await files.remove(current.avatar.key).catch(err => logger.warn({ err }, "couldn't remove the profile photo file"));
    res.json(toProfile(saved));
  });

  router.use("/profile/avatar", (err: { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === "entity.too.large") { res.status(413).json({ error: `Photos can be at most ${MAX_AVATAR_BYTES / 1024 / 1024} MB.` }); return; }
    next(err);
  });

  // ---------- Security activity ----------

  router.get("/profile/security-events", async (_req, res) => {
    res.json(await activity.securityEvents(authLocals(res).user.id));
  });

  // Changes Supabase makes straight from the browser. Two-step changes are recorded only if the verified account agrees.
  router.post("/profile/security-events", async (req, res) => {
    const body = ReportSecurityEventBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Say which security change to record." }); return; }
    const { user } = authLocals(res);
    const record = await ownProfile(repo, user);
    const factors = user.factors?.length ?? 0;
    const { kind } = body.data;
    if ((kind === "two_step_on" && factors === 0) || (kind === "two_step_off" && factors > 0)) { res.json({ recorded: false }); return; }
    await activity.recordSecurity([securityEvent(user.id, kind, record.privacy, requestOrigin(req), new Date())]);
    res.json({ recorded: true });
  });

  router.post("/profile/check-password", async (req, res) => {
    const body = CheckPasswordBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Enter your current password.", fieldErrors: { currentPassword: "Enter your current password." } }); return; }
    if (!passwordChecker) { res.status(503).json({ error: "Sign-in isn't set up on the server." }); return; }
    const { user } = authLocals(res);
    const record = await ownProfile(repo, user);
    const result = await passwordChecker(record.email, body.data.password);
    if (result === "wrong") {
      await activity.recordSecurity([securityEvent(user.id, "failed_password_check", record.privacy, requestOrigin(req), new Date())]);
      res.status(400).json({ error: "That isn't your current password.", fieldErrors: { currentPassword: "That isn't your current password." } }); return;
    }
    if (result === "limited") { res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." }); return; }
    if (result === "unavailable") { res.status(503).json({ error: "Couldn't check your password right now. Try again in a minute." }); return; }
    res.json({ message: "Password confirmed." });
  });

  async function ownRule(res: Response, command: (state: DemoState) => Result, security: Effects["security"] = []) {
    const outcome = await runAccountRule(repo, await ownProfile(repo, authLocals(res).user), command, undefined, security);
    if (!outcome.ok) { res.status(outcome.status).json(outcome.body); return; }
    res.json(toProfile(outcome.record));
  }

  router.post("/profile/identity", async (req, res) => {
    const body = SubmitIdentityCheckBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Send a document type, document number, and the name on the document." }); return; }
    // Server-only rule: compliance reviews the document itself, so at least one must be uploaded.
    const uploaded = (await documents.listForOwner(authLocals(res).user.id)).some(d => d.purpose === "identity");
    if (!uploaded) { res.status(400).json({ error: "Upload a photo or scan of your document first.", fieldErrors: { documents: "Upload a photo or scan of your document." } }); return; }
    await ownRule(res, s => submitKyc(s, body.data, new Date()));
  });

  router.get("/profile/email-preference", async (_req, res) => {
    res.json({ enabled: (await ownProfile(repo, authLocals(res).user)).emailNotifications });
  });

  router.put("/profile/email-preference", async (req, res) => {
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== "boolean") { res.status(400).json({ error: "Say whether email copies are on or off." }); return; }
    const { user } = authLocals(res);
    await ownProfile(repo, user);
    const saved = await repo.updateContact(user.id, { emailNotifications: enabled });
    res.json({ enabled: saved.emailNotifications });
  });

  router.post("/profile/credential-reset", async (req, res) => {
    const body = CompleteCredentialResetBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Say which reset you completed." }); return; }
    const { user } = authLocals(res);
    const record = await ownProfile(repo, user);
    const proof = resetProof(user, record, body.data.kind);
    if (proof) { res.status(400).json({ error: proof }); return; }
    await ownRule(res, s => completeCredentialReset(s, body.data.kind));
  });

  // The portal reports a password change after Supabase accepted it, so the applicant gets a notification
  // and an email copy. It only ever notifies the signed-in account's own address.
  router.post("/profile/password-changed", async (req, res) => {
    const { user } = authLocals(res);
    const record = await ownProfile(repo, user);
    const now = new Date();
    await ownRule(res, s => recordPasswordChange(s, now), [securityEvent(user.id, "password_changed", record.privacy, requestOrigin(req), now)]);
  });

  return router;
}
