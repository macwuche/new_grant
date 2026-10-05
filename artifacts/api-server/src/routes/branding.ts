import { createHash, randomUUID } from "node:crypto";
import express, { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import type { BrandImageJson, BrandingJson } from "@workspace/db";
import { BRAND_IMAGE_KINDS, BRAND_IMAGE_LABELS, brandImagePath, DEFAULT_BRAND_COLOR, DEFAULT_EMAIL_COLOR, MAX_BRAND_IMAGE_BYTES, normalizeHex, type BrandImageKind } from "@workspace/domain/branding";
import { auditEntry, type Effects } from "../lib/activity";
import { appName, appUrl, DEFAULT_APP_NAME, renderEmail, setAppName, setEmailBrand } from "../lib/email";
import type { EmailSettingsRepo, StoredEmailSettings } from "../lib/emailSettings";
import type { FileStore } from "../lib/fileStore";
import { logger } from "../lib/logger";
import { inspectUpload } from "../lib/uploadSafety";
import { auditContext, authLocals, requirePermission } from "../middlewares/auth";
import { detectImage } from "./profile";

// Shared branding (super admins: staff.manage): the application name, the app's
// accent colour, the email accent colour, and the logo, logo for dark
// backgrounds, and favicon. Images are kept on the API server's disk like
// documents and served publicly (logos aren't private, and email clients load
// the logo from here), checked against their SHA-256. Every change is audited.

/** Brand images are stored under this owner id (storage keys are `<uuid>/<uuid>`). */
export const BRAND_IMAGE_OWNER = "5a1e5000-0000-4000-8000-00000000f072";
const PATH: Record<BrandImageKind, string> = { logo: "logo", logoDark: "logo-dark", favicon: "favicon" };
const kindOf = (path: string): BrandImageKind | undefined => BRAND_IMAGE_KINDS.find(k => path.endsWith(`/branding/${PATH[k]}`));
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .&'-]{0,39}$/u;

/** What anyone may see: the name, colours (null: the defaults), and where each image is served. */
export function brandingView(s: StoredEmailSettings) {
  const b = s.branding;
  const image = (k: BrandImageKind) => { const f = b[k]; return f ? brandImagePath(k, f.sha256) : null; };
  return { appName: s.appName ?? DEFAULT_APP_NAME, isDefault: !s.appName, brandColor: b.brandColor, emailColor: b.emailColor, logoUrl: image("logo"), logoDarkUrl: image("logoDark"), faviconUrl: image("favicon") };
}

/** Keeps this API instance's emails in step with the saved name, email colour, and logo. */
export function applyBranding(s: StoredEmailSettings) {
  setAppName(s.appName);
  setEmailBrand({ color: s.branding.emailColor, logoPath: s.branding.logo ? brandImagePath("logo", s.branding.logo.sha256) : null });
}

/** Public (before sign-in): the branding, for every page including sign-in, and the images themselves. */
export function brandingRouter(settings: EmailSettingsRepo, files: FileStore): IRouter {
  const router: IRouter = Router();
  router.get("/branding", async (_req, res) => {
    const s = await settings.get();
    applyBranding(s);
    res.json(brandingView(s));
  });
  router.get(BRAND_IMAGE_KINDS.map(k => `/branding/${PATH[k]}`), async (req, res) => {
    const kind = kindOf(req.path);
    const file = kind ? (await settings.get()).branding[kind] : null;
    const bytes = file ? await files.get(file.key) : null;
    if (!file || !bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      if (file) logger.error({ kind, missing: !bytes }, "brand image is missing or doesn't match its record");
      res.status(404).json({ error: "No image." }); return;
    }
    // Cross-origin: webmail shows the logo from its own address.
    res.set({ "Content-Type": file.contentType, "Content-Length": String(bytes.length), "Cache-Control": "public, max-age=86400", "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "cross-origin" });
    res.end(bytes);
  });
  return router;
}

/** Super admins change the branding (mounted after sign-in). */
export function brandingAdminRouter(settings: EmailSettingsRepo, files: FileStore): IRouter {
  const router: IRouter = Router();
  const admin = requirePermission("staff.manage");
  const audit = (req: Request, res: Response, action: string, summary: string, changes: { field: string; before: string; after: string }[]): Effects =>
    ({ notifications: [], staffEvents: [], audit: [auditEntry(auditContext(req, res, action, "branding"), summary, changes, new Date())] });
  const save = async (req: Request, res: Response, patch: { appName?: string | null; branding?: Partial<BrandingJson> }, effects: Effects) => {
    const s = await settings.save(patch, authLocals(res).staff!.name, effects);
    applyBranding(s);
    res.json(brandingView(s));
    return s;
  };

  router.put("/branding", admin, async (req, res) => {
    const raw = req.body?.appName;
    if (typeof raw !== "string") { res.status(400).json({ error: "Enter the application name." }); return; }
    const name = raw.trim().replace(/\s+/g, " ");
    // Empty restores the default. The name goes into email subjects, HTML, and authenticator apps, so keep it plain.
    if (name && !APP_NAME.test(name)) { res.status(400).json({ error: "Use up to 40 letters, numbers, spaces, and . - & ' only.", fieldErrors: { appName: "Use up to 40 letters, numbers, spaces, and . - & ' only." } }); return; }
    const before = appName();
    const next = name && name !== DEFAULT_APP_NAME ? name : null;
    await save(req, res, { appName: next }, audit(req, res, "Change application name", `Application name changed from ${before} to ${next ?? DEFAULT_APP_NAME}.`, [{ field: "Application name", before, after: next ?? DEFAULT_APP_NAME }]));
  });

  // Colours: `#RRGGBB`, or null / "" for the default. Only the colours sent are changed.
  router.put("/branding/colors", admin, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fieldErrors: Record<string, string> = {};
    const patch: Partial<BrandingJson> = {};
    for (const field of ["brandColor", "emailColor"] as const) {
      const v = body[field];
      if (v === undefined) continue;
      if (v === null || v === "") { patch[field] = null; continue; }
      const hex = typeof v === "string" ? normalizeHex(v) : null;
      if (!hex) fieldErrors[field] = "Use a colour like #1D4ED8.";
      else patch[field] = hex;
    }
    if (Object.keys(fieldErrors).length) { res.status(400).json({ error: "Fix the highlighted colours.", fieldErrors }); return; }
    if (!Object.keys(patch).length) { res.status(400).json({ error: "Choose a colour to change." }); return; }
    const before = (await settings.get()).branding;
    const label = { brandColor: ["App colour", DEFAULT_BRAND_COLOR], emailColor: ["Email colour", DEFAULT_EMAIL_COLOR] } as const;
    const changes = (Object.keys(patch) as (keyof typeof label)[]).map(f => ({ field: label[f][0], before: before[f] ?? `${label[f][1]} (default)`, after: patch[f] ?? `${label[f][1]} (default)` }));
    await save(req, res, { branding: patch }, audit(req, res, "Change brand colours", changes.map(c => `${c.field}: ${c.before} → ${c.after}.`).join(" "), changes));
  });

  for (const kind of BRAND_IMAGE_KINDS) {
    const path = `/branding/${PATH[kind]}`;
    const label = BRAND_IMAGE_LABELS[kind];
    router.put(path, admin, express.raw({ type: () => true, limit: MAX_BRAND_IMAGE_BYTES[kind] }), async (req: Request, res: Response) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!bytes.length) { res.status(400).json({ error: "The file is empty." }); return; }
      const contentType = detectImage(bytes);
      if (!contentType) { res.status(415).json({ error: "Upload a PNG, JPG, or WEBP image." }); return; }
      const unsafe = inspectUpload(bytes, contentType);
      if (!unsafe.ok) { res.status(422).json({ error: unsafe.reason }); return; }
      const file: BrandImageJson = { key: `${BRAND_IMAGE_OWNER}/${randomUUID()}`, contentType, sha256: createHash("sha256").update(bytes).digest("hex"), updatedAt: new Date().toISOString() };
      const previous = (await settings.get()).branding[kind];
      await files.put(file.key, bytes);
      try {
        await save(req, res, { branding: { [kind]: file } }, audit(req, res, `Change ${label.toLowerCase()}`, `${label} ${previous ? "replaced" : "uploaded"}.`, [{ field: label, before: previous ? "Uploaded image" : "None", after: `Uploaded image (${contentType}, ${bytes.length} bytes)` }]));
      } catch (err) { await files.remove(file.key).catch(() => {}); throw err; }
      if (previous) await files.remove(previous.key).catch(err => logger.warn({ err, kind }, "couldn't remove the replaced brand image"));
    });
    router.use(path, (err: { type?: string }, _req: Request, res: Response, next: NextFunction) => {
      if (err?.type === "entity.too.large") { res.status(413).json({ error: `The ${label.toLowerCase()} can be at most ${MAX_BRAND_IMAGE_BYTES[kind] / 1024 / 1024} MB.` }); return; }
      next(err);
    });
    router.post(`${path}/delete`, admin, async (req, res) => {
      const previous = (await settings.get()).branding[kind];
      if (!previous) { res.status(404).json({ error: `There's no ${label.toLowerCase()} to remove.` }); return; }
      await save(req, res, { branding: { [kind]: null } }, audit(req, res, `Remove ${label.toLowerCase()}`, `${label} removed.`, [{ field: label, before: "Uploaded image", after: "None" }]));
      await files.remove(previous.key).catch(err => logger.warn({ err, kind }, "couldn't remove a brand image"));
    });
  }

  // A sample email with the saved logo and a colour (a draft one, before saving, or the saved one).
  router.post("/branding/email-preview", admin, async (req, res) => {
    const raw = (req.body ?? {}) as { emailColor?: unknown };
    const draft = typeof raw.emailColor === "string" && raw.emailColor ? normalizeHex(raw.emailColor) : null;
    if (typeof raw.emailColor === "string" && raw.emailColor && !draft) { res.status(400).json({ error: "Use a colour like #1D4ED8.", fieldErrors: { emailColor: "Use a colour like #1D4ED8." } }); return; }
    const s = await settings.get();
    applyBranding(s);
    const name = appName();
    const base = appUrl();
    const { html } = renderEmail({
      greeting: "Hello Maya,",
      paragraphs: ["Your application APP-1042 for Community Roots has been approved for $5,000.00. The award has been added to your grant balance.", "This is a preview of how emails from your team look."],
      action: { label: `Open ${name}`, href: `${base ?? "https://example.org"}/applications` },
      footer: `You're receiving this because you have an account with ${name}. You can turn off email copies of notifications in Settings.`,
    }, { color: draft ?? s.branding.emailColor, logoPath: s.branding.logo ? brandImagePath("logo", s.branding.logo.sha256) : null });
    res.json({ subject: `${name}: Community Roots application approved`, html, logoShown: !!(s.branding.logo && base) });
  });

  return router;
}
