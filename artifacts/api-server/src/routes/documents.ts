import { createHash } from "node:crypto";
import express, { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { roleCan, type Permission } from "@workspace/authz";
import type { ApplicationRepo } from "../lib/applicationRepo";
import { auditEntry } from "../lib/activity";
import { newStorageKey, type FileStore } from "../lib/fileStore";
import type { DocumentPurpose, DocumentRecord, DocumentRepo } from "../lib/documentRepo";
import { logger } from "../lib/logger";
import type { ProfileRepo } from "../lib/profileRepo";
import type { ProgramRepo } from "../lib/programRepo";
import { auditContext, authLocals, requireStaff } from "../middlewares/auth";
import { ownProfile } from "./profile";

// Documents applicants upload: identity documents for the identity check, and
// evidence for each requirement of an application. Files go to the server's
// disk (FileStore); the database keeps a record with a SHA-256 of the content,
// checked on every download.
//
// Uploads are the raw file as the request body (not multipart), with the
// purpose, application, and requirement in the query and the file name in the
// X-File-Name header (URI-encoded). The type is detected from the content:
// only PDF, JPEG, and PNG are accepted.
//
// Who may open a document: its owner, and staff whose role covers it (identity
// documents: kyc.review; application evidence: applications.review,
// applications.clearEscalation, or kyc.review). Every staff view is audited.

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_IDENTITY_DOCUMENTS = 5;
const MAX_PER_REQUIREMENT = 5;
const MAX_PER_OWNER = 60;
/** Application statuses in which the applicant may change the evidence. */
const EDITABLE = new Set(["Draft", "Changes requested"]);

const VIEWERS: Record<DocumentPurpose, Permission[]> = {
  identity: ["kyc.review"],
  application: ["applications.review", "applications.clearEscalation", "kyc.review"],
};

/** The file type, from its first bytes; null if it isn't an accepted type. */
export function detectType(bytes: Buffer): "application/pdf" | "image/jpeg" | "image/png" | null {
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return null;
}

/** A display name: no path, no control characters, at most 120 characters. */
export function cleanFileName(raw: string | undefined): string {
  let name = "";
  try { name = decodeURIComponent(raw ?? ""); } catch { name = raw ?? ""; }
  name = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  return name.slice(-120) || "document";
}

export const toDocument = (d: DocumentRecord) => ({
  id: d.id, purpose: d.purpose, applicationId: d.applicationId, requirement: d.requirement,
  fileName: d.fileName, contentType: d.contentType, sizeBytes: d.sizeBytes, uploadedAt: d.uploadedAt,
});

/** Program requirements with no evidence uploaded for this application. */
export const missingEvidence = (requirements: string[], docs: DocumentRecord[]) =>
  requirements.filter(r => !docs.some(d => d.requirement === r));

export type DocumentDeps = { documents: DocumentRepo; files: FileStore; profiles: ProfileRepo; applications: ApplicationRepo; programs: ProgramRepo };

export function documentsRouter({ documents, files, profiles, applications, programs }: DocumentDeps): IRouter {
  const router: IRouter = Router();
  const fail = (res: Response, status: number, error: string) => { res.status(status).json({ error }); };

  router.get("/documents/mine", async (_req, res) => {
    res.json((await documents.listForOwner(authLocals(res).user.id)).map(toDocument));
  });

  /** Why the applicant can't change this evidence right now, or null. */
  async function evidenceLock(ownerId: string, purpose: DocumentPurpose, applicationId: string | null): Promise<string | null> {
    if (purpose === "identity") {
      const kyc = (await profiles.get(ownerId))?.account.kyc.status;
      return kyc === "Pending" ? "Your identity check is with the compliance team; its documents can't change until it's reviewed."
        : kyc === "Verified" ? "Your identity is verified; its documents are kept as the record of the check." : null;
    }
    const app = applicationId ? await applications.get(applicationId) : null;
    if (!app || app.applicantId !== ownerId) return "That application could not be found.";
    return EDITABLE.has(app.status) ? null : "This application has been submitted; its documents can't change unless the reviewer asks for changes.";
  }

  router.post("/documents", express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES }), async (req: Request, res: Response) => {
    const { user } = authLocals(res);
    const profile = await ownProfile(profiles, user);
    if (profile.account.status === "Locked") return fail(res, 403, "Your account is locked. Contact support.");
    const purpose = req.query["purpose"];
    if (purpose !== "identity" && purpose !== "application") return fail(res, 400, "Say what the document is for: identity or application.");
    const applicationId = purpose === "application" && typeof req.query["applicationId"] === "string" ? req.query["applicationId"] : null;
    const requirement = purpose === "application" && typeof req.query["requirement"] === "string" ? req.query["requirement"] : null;
    if (purpose === "application" && (!applicationId || !requirement)) return fail(res, 400, "Say which application and requirement the document supports. Save the application as a draft first.");

    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) return fail(res, 400, "The file is empty.");
    const contentType = detectType(bytes);
    if (!contentType) return fail(res, 415, "Upload a PDF, JPEG, or PNG file.");

    const locked = await evidenceLock(user.id, purpose, applicationId);
    if (locked) return fail(res, locked.includes("could not be found") ? 404 : 409, locked);
    const own = await documents.listForOwner(user.id);
    if (own.length >= MAX_PER_OWNER) return fail(res, 409, `You can keep up to ${MAX_PER_OWNER} documents. Delete ones you no longer need.`);
    if (purpose === "identity" && own.filter(d => d.purpose === "identity").length >= MAX_IDENTITY_DOCUMENTS) return fail(res, 409, `Upload at most ${MAX_IDENTITY_DOCUMENTS} identity documents.`);
    if (purpose === "application") {
      const app = (await applications.get(applicationId!))!;
      const grant = (await programs.list()).find(g => g.id === app.grantId);
      if (!grant?.requirements.includes(requirement!)) return fail(res, 400, "That isn't one of this program's requirements.");
      if (own.filter(d => d.applicationId === applicationId && d.requirement === requirement).length >= MAX_PER_REQUIREMENT) return fail(res, 409, `Upload at most ${MAX_PER_REQUIREMENT} files per requirement.`);
    }

    const storageKey = newStorageKey(user.id);
    await files.put(storageKey, bytes);
    try {
      const saved = await documents.insert({
        ownerId: user.id, purpose, applicationId, requirement, fileName: cleanFileName(req.header("x-file-name")),
        contentType, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), storageKey,
      });
      logger.info({ owner: user.id, document: saved.id, purpose, bytes: bytes.length }, "document uploaded");
      res.status(201).json(toDocument(saved));
    } catch (err) {
      await files.remove(storageKey).catch(() => {});
      throw err;
    }
  });

  router.post("/documents/:id/delete", async (req, res) => {
    const { user } = authLocals(res);
    const doc = await documents.get(String(req.params["id"]));
    if (!doc || doc.deletedAt || doc.ownerId !== user.id) return fail(res, 404, "That document could not be found.");
    const locked = await evidenceLock(user.id, doc.purpose, doc.applicationId);
    if (locked) return fail(res, 409, locked);
    if (await documents.markDeleted(doc.id)) await files.remove(doc.storageKey);
    res.json({ message: `${doc.fileName} deleted.` });
  });

  /** Staff: an applicant's or an application's documents, limited to the kinds the role may open. */
  router.get("/documents", requireStaff, async (req, res) => {
    const { staff } = authLocals(res);
    const { applicantId, applicationId } = req.query;
    const docs = typeof applicationId === "string" ? await documents.listForApplication(applicationId)
      : typeof applicantId === "string" && /^[0-9a-f-]{36}$/i.test(applicantId) ? await documents.listForOwner(applicantId)
      : null;
    if (!docs) return fail(res, 400, "Say which applicant or application.");
    res.json(docs.filter(d => VIEWERS[d.purpose].some(p => roleCan(staff!.role, p))).map(toDocument));
  });

  router.get("/documents/:id/file", async (req, res) => {
    const { user, staff } = authLocals(res);
    const doc = await documents.get(String(req.params["id"]));
    if (!doc || doc.deletedAt) return fail(res, 404, "That document could not be found.");
    const owner = doc.ownerId === user.id;
    const staffMayView = !!staff?.active && VIEWERS[doc.purpose].some(p => roleCan(staff.role, p));
    // Someone else's document reads as not found, never as forbidden.
    if (!owner && !staffMayView) return fail(res, 404, "That document could not be found.");

    const bytes = await files.get(doc.storageKey);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== doc.sha256) {
      logger.error({ document: doc.id, missing: !bytes }, "document file is missing or doesn't match its record");
      return fail(res, 500, "This document can't be opened: the stored file is missing or has changed. The team has been alerted.");
    }
    if (!owner) {
      const ctx = auditContext(req, res, "View document", doc.id);
      await documents.record({ notifications: [], staffEvents: [], audit: [{ ...auditEntry(ctx, `Opened ${doc.purpose === "identity" ? "identity document" : `evidence for ${doc.applicationId}`}: ${doc.fileName}`, [], new Date()), applicantId: doc.ownerId }] });
    }
    res.set({
      "Content-Type": doc.contentType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${doc.fileName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    res.end(bytes);
  });

  router.use("/documents", (err: { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === "entity.too.large") return fail(res, 413, `Files can be at most ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`);
    next(err);
  });

  return router;
}
