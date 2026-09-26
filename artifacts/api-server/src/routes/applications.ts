import { Router, type IRouter, type Response } from "express";
import {
  AddInternalNoteBody, ApproveApplicationBody, ClearEscalationBody, DeclineApplicationBody, EscalateApplicationBody,
  RequestApplicationChangesBody, SaveApplicationDraftBody, StartReviewBody, StartReviewParams as ApplicationIdParams, SubmitApplicationBody,
} from "@workspace/api-zod";
import type { Permission } from "@workspace/authz";
import type { Application, ApplicationInput, DemoState, Result } from "@workspace/domain/model";
import { addInternalNote, approveApplication, clearEscalation, declineApplication, escalateApplication, requestChanges, startReview } from "@workspace/domain/review";
import { deleteDraft, saveDraft, submitApplication } from "@workspace/domain/rules";
import { applicantState, applicantView, readApplicantSlot, serverState } from "@workspace/domain/server";
import type { ApplicationRepo, ProgramScope } from "../lib/applicationRepo";
import type { DocumentRepo } from "../lib/documentRepo";
import type { FileStore } from "../lib/fileStore";
import { storeLedgerChanges } from "../lib/ledger";
import type { MoneyRepo } from "../lib/moneyRepo";
import { slotApplicant } from "../lib/applicantRules";
import { logger } from "../lib/logger";
import type { ProfileRepo } from "../lib/profileRepo";
import { effectsOf } from "../lib/activity";
import { auditContext, authLocals, requirePermission, requireStaff } from "../middlewares/auth";
import { missingEvidence } from "./documents";
import { ownProfile } from "./profile";

// Grant applications. Applicants act on their own records only (ownership comes
// from the sign-in token, via the rules' current-applicant slot); staff review
// with per-role permissions and never on their own applications. Every change
// runs the shared rules inside the program's lock (see ../lib/applicationRepo.ts)
// and stores exactly the applications the rule changed.
//
// The notifications and staff activity items the rules create, an audit entry
// for each staff action, and the ledger entries (the application fee on first
// submission, the award credit on approval) are stored in the same transaction.
// Applicant actions also hold the applicant's money lock, so the fee is checked
// against a balance nothing else can change meanwhile.

const STALE = "This application changed since you opened it. Review the latest version and try again.";

type Failure = { status: 400 | 403 | 404 | 409; body: { error: string; fieldErrors?: Record<string, string> } };
type Outcome = { failure: Failure } | { message: string; saved?: Application };
const refused = (result: Result & { ok: false }): Failure => ({ status: 400, body: { error: result.error, ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}) } });

/** Stores every application the rule added, changed, or removed. */
async function storeChanges(scope: ProgramScope, before: Application[], after: Application[]) {
  const previous = new Map(before.map(a => [a.id, JSON.stringify(a)]));
  for (const app of after) if (previous.get(app.id) !== JSON.stringify(app)) await scope.saveApplication(app);
  for (const app of before) if (!after.some(a => a.id === app.id)) await scope.removeApplication(app.id);
}

export function applicationsRouter(apps: ApplicationRepo, profiles: ProfileRepo, money: MoneyRepo, documents: DocumentRepo, files: FileStore): IRouter {
  const router: IRouter = Router();

  // ---------- Applicant ----------

  router.get("/applications/mine", async (_req, res) => {
    res.json((await apps.listForApplicant(authLocals(res).user.id)).map(applicantView));
  });

  /** Runs an applicant rule on their own records in one program, and returns their saved application. */
  async function asApplicant(res: Response, grantId: string, needsId: boolean, command: (state: DemoState) => Result) {
    const record = await ownProfile(profiles, authLocals(res).user);
    const nextId = needsId ? await apps.nextNumber() : 0;
    const outcome = await apps.withProgram(grantId, async (scope): Promise<Outcome> => {
      const ledger = await scope.money(record.authUserId);
      const state = applicantState({ grants: scope.grants, applications: scope.applications, nextId, ...ledger }, slotApplicant(record));
      const result = command(state);
      if (!result.ok) return { failure: refused(result) };
      const slot = readApplicantSlot(result.state, record.authUserId);
      const after = slot.applications;
      await storeChanges(scope, scope.applications, after);
      await storeLedgerChanges(ledger.transactions, slot.transactions, scope.saveTransaction, money.nextBlock);
      await scope.record(effectsOf(state, result.state, new Date(), { slotId: record.authUserId }));
      return { message: result.message, saved: after.find(a => a.id === result.id) };
    });
    if ("failure" in outcome) { res.status(outcome.failure.status).json(outcome.failure.body); return; }
    if (outcome.saved) res.json({ application: applicantView(outcome.saved), message: outcome.message });
    else res.json({ message: outcome.message });
  }

  for (const path of ["save", "submit"] as const) {
    router.post(`/applications/${path}`, async (req, res) => {
      const body = (path === "save" ? SaveApplicationDraftBody : SubmitApplicationBody).safeParse(req.body);
      if (!body.success) { res.status(400).json({ error: "Send the program id and your application." }); return; }
      const { grantId, draftId, application } = body.data;
      if (path === "save") { await asApplicant(res, grantId, !draftId, s => saveDraft(s, grantId, application as ApplicationInput, new Date(), draftId)); return; }
      // Server-only rule: every requirement needs an uploaded file, attached to the saved draft.
      const evidence = draftId ? (await documents.listForApplication(draftId)).filter(d => d.ownerId === authLocals(res).user.id) : [];
      await asApplicant(res, grantId, !draftId, s => {
        const missing = missingEvidence(s.grants.find(g => g.id === grantId)?.requirements ?? [], evidence);
        if (missing.length) return { ok: false, error: draftId ? `Upload a file for: ${missing.join(", ")}.` : "Save your application as a draft and upload a file for each requirement first.", fieldErrors: { checklist: `Upload a file for: ${missing.join(", ")}.` } };
        return submitApplication(s, grantId, application as ApplicationInput, new Date(), draftId);
      });
    });
  }

  router.post("/applications/:id/delete", async (req, res) => {
    const params = ApplicationIdParams.safeParse(req.params);
    const app = params.success ? await apps.get(params.data.id) : null;
    // Someone else's application reads as not found, never as forbidden.
    if (!app || app.applicantId !== authLocals(res).user.id) { res.status(404).json({ error: "That draft could not be found." }); return; }
    await asApplicant(res, app.grantId, false, s => deleteDraft(s, app.id));
    // The draft is gone: remove its evidence files too.
    if (res.statusCode === 200) {
      for (const doc of await documents.listForApplication(app.id)) if (await documents.markDeleted(doc.id)) await files.remove(doc.storageKey);
    }
  });

  // ---------- Staff ----------

  router.get("/applications", requireStaff, async (_req, res) => {
    res.json(await apps.listSubmitted());
  });

  type Parsed = { ok: true; version?: string; command: (state: DemoState, by: string) => Result } | { ok: false; error: string };

  const staffAction = (path: string, permission: Permission, label: string, parse: (body: unknown, id: string) => Parsed) =>
    router.post(`/applications/:id/${path}`, requireStaff, requirePermission(permission), async (req, res) => {
      const params = ApplicationIdParams.safeParse(req.params);
      const found = params.success ? await apps.get(params.data.id) : null;
      if (!found || found.status === "Draft") { res.status(404).json({ error: "That application is not in the review queue." }); return; }
      // Conflict of interest: nobody reviews, notes, or escalates their own application.
      if (found.applicantId === authLocals(res).user.id) { res.status(403).json({ error: "You can't act on your own application. Ask another team member." }); return; }
      const parsed = parse(req.body, found.id);
      if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
      const actor = authLocals(res).staff!;
      const outcome = await apps.withProgram(found.grantId, async (scope): Promise<Outcome> => {
        const current = scope.applications.find(a => a.id === found.id);
        if (!current) return { failure: { status: 404, body: { error: "That application is not in the review queue." } } };
        if (parsed.version !== undefined && current.updatedAt !== parsed.version) return { failure: { status: 409, body: { error: STALE } } };
        const before = serverState({ grants: scope.grants, applications: scope.applications });
        const result = parsed.command(before, actor.name);
        if (!result.ok) return { failure: refused(result) };
        await storeChanges(scope, scope.applications, result.state.applications);
        await storeLedgerChanges([], result.state.transactions, scope.saveTransaction, money.nextBlock);
        await scope.record(effectsOf(before, result.state, new Date(), { audit: auditContext(req, res, label, found.id), summary: result.message }));
        return { message: result.message, saved: result.state.applications.find(a => a.id === found.id)! };
      });
      if ("failure" in outcome) { res.status(outcome.failure.status).json(outcome.failure.body); return; }
      logger.info({ actor: actor.id, application: found.id, action: path }, "application reviewed");
      res.json({ application: outcome.saved!, message: outcome.message });
    });

  const invalid = (error: string): Parsed => ({ ok: false, error });

  staffAction("start-review", "applications.review", "Start review", (body, id) => {
    const b = StartReviewBody.safeParse(body);
    return b.success ? { ok: true, version: b.data.version, command: (s, by) => startReview(s, id, b.data.version, by, new Date()) } : invalid("Send the application's version.");
  });
  staffAction("approve", "applications.review", "Approve application", (body, id) => {
    const b = ApproveApplicationBody.safeParse(body);
    return b.success ? { ok: true, version: b.data.version, command: (s, by) => approveApplication(s, id, b.data.version, b.data.award, by, new Date()) } : invalid("Send the application's version and the award amount.");
  });
  staffAction("request-changes", "applications.review", "Request changes", (body, id) => {
    const b = RequestApplicationChangesBody.safeParse(body);
    return b.success ? { ok: true, version: b.data.version, command: (s, by) => requestChanges(s, id, b.data.version, b.data.message, by, new Date()) } : invalid("Send the application's version and a message.");
  });
  staffAction("decline", "applications.review", "Decline application", (body, id) => {
    const b = DeclineApplicationBody.safeParse(body);
    return b.success ? { ok: true, version: b.data.version, command: (s, by) => declineApplication(s, id, b.data.version, b.data.reason, by, new Date()) } : invalid("Send the application's version and a reason.");
  });
  staffAction("notes", "notes.add", "Add internal note", (body, id) => {
    const b = AddInternalNoteBody.safeParse(body);
    return b.success ? { ok: true, command: (s, by) => addInternalNote(s, id, b.data.text, by, new Date()) } : invalid("Write a note.");
  });
  staffAction("escalate", "applications.escalate", "Escalate to security", (body, id) => {
    const b = EscalateApplicationBody.safeParse(body);
    return b.success ? { ok: true, command: (s, by) => escalateApplication(s, id, b.data.reason, by, new Date()) } : invalid("Explain what compliance should check.");
  });
  staffAction("clear-escalation", "applications.clearEscalation", "Clear escalation", (body, id) => {
    const b = ClearEscalationBody.safeParse(body);
    return b.success ? { ok: true, command: (s, by) => clearEscalation(s, id, b.data.resolution, by, new Date()) } : invalid("Record what the check found.");
  });

  return router;
}
