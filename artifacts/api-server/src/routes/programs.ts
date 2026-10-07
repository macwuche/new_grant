import { Router, type IRouter, type Request, type Response } from "express";
import { CreateProgramBody, PublishProgramBody as ProgramVersionBody, UpdateProgramBody, UpdateProgramParams as ProgramIdParams } from "@workspace/api-zod";
import type { DemoState, Grant, GrantInput, Result } from "@workspace/domain/model";
import { closeProgram, createProgram, deleteProgram, publishProgram, updateProgram } from "@workspace/domain/programs";
import { serverState } from "@workspace/domain/server";
import { logger } from "../lib/logger";
import type { ApplicationRepo } from "../lib/applicationRepo";
import type { ProgramRepo, WriteOutcome } from "../lib/programRepo";
import { effectsOf } from "../lib/activity";
import { auditContext, authLocals, requirePermission } from "../middlewares/auth";

// Grant programs. Every change runs the same rule functions the portal uses
// (@workspace/domain/programs) against the programs loaded from the database,
// then stores the one program that changed, conditional on its version.
// Changes to an existing program run inside that program's lock with its
// applications loaded, so criteria lock after the first submission, even under
// concurrent requests. Plans have no overall budget (owner's decision, 7 Oct 2026).
// Each change is audited, and closing a program notifies applicants holding
// drafts, in the same transaction.

const STALE = "This program changed since you opened it. Review the latest version and try again.";

type Command = (state: DemoState, by: string, now: Date) => Result;

export function programsRouter(repo: ProgramRepo, apps: ApplicationRepo): IRouter {
  const router: IRouter = Router();

  // Applicants see active plans, plus inactive ones they already have an
  // application on (so their application pages still show the plan). Drafts
  // stay staff-only.
  router.get("/programs", async (_req, res) => {
    const { staff, user } = authLocals(res);
    const all = await repo.list();
    if (staff?.active) { res.json(all); return; }
    const mine = new Set((await apps.listForApplicant(user.id)).map(a => a.grantId));
    res.json(all.filter(g => g.status === "Open" || (g.status === "Closed" && mine.has(g.id))));
  });

  /** Runs a rule for one existing program (or a new one when `id` is null) and stores the result. */
  // Audit labels match the ones the browser demo uses.
  const LABELS: Record<string, string> = { create: "Create program", edit: "Edit program", close: "Make program inactive", delete: "Delete program" };

  async function apply(req: Request, res: Response, action: string, id: string | null, version: string | null, command: Command) {
    const actor = authLocals(res).staff!;
    type Done = { saved?: Grant; message: string } | { status: number; body: object };
    const finish = (done: Done) => {
      if ("status" in done) { res.status(done.status).json(done.body); return; }
      logger.info({ actor: actor.id, program: done.saved?.id ?? id, action }, "program changed");
      if (done.saved) res.status(id ? 200 : 201).json({ program: done.saved, message: done.message });
      else res.json({ message: done.message });
    };
    const failed = (result: Result & { ok: false }): Done => ({ status: 400, body: { error: result.error, ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}) } });
    const refusal = (outcome: Exclude<WriteOutcome, "ok">): Done => outcome === "stale"
      ? { status: 409, body: { error: STALE } }
      : { status: 400, body: { error: "Fix the highlighted fields.", fieldErrors: { name: "Another program already uses this name." } } };

    if (!id) {
      const grants = await repo.list();
      const before = serverState({ grants, nextId: await repo.nextNumber() });
      const now = new Date();
      const result = command(before, actor.name, now);
      if (!result.ok) { finish(failed(result)); return; }
      const saved = result.state.grants.find(g => !grants.some(b => b.id === g.id))!;
      const outcome = await repo.insert(saved, effectsOf(before, result.state, now, { audit: auditContext(req, res, LABELS.create!, saved.id), summary: result.message }));
      finish(outcome === "ok" ? { saved, message: result.message } : refusal(outcome));
      return;
    }

    finish(await apps.withProgram(id, async (scope): Promise<Done> => {
      const existing = scope.grants.find(g => g.id === id);
      if (!existing) return { status: 404, body: { error: "That program could not be found." } };
      if (existing.updatedAt !== version) return { status: 409, body: { error: STALE } };
      const before = serverState({ grants: scope.grants, applications: scope.applications });
      const now = new Date();
      const result = command(before, actor.name, now);
      if (!result.ok) return failed(result);
      const saved = result.state.grants.find(g => g.id === id);
      const outcome = saved ? await scope.saveGrant(saved, version) : await scope.removeGrant(id, version);
      if (outcome !== "ok") return refusal(outcome);
      const label = action === "publish" ? (existing.status === "Closed" ? "Make program active" : "Publish program") : LABELS[action]!;
      await scope.record(effectsOf(before, result.state, now, { audit: auditContext(req, res, label, id), summary: result.message }));
      return { saved, message: result.message };
    }));
  }

  // Reading is open to every signed-in user; every change needs programs.manage.
  router.use("/programs", (req, res, next) => req.method === "GET" ? next() : requirePermission("programs.manage")(req, res, next));

  router.post("/programs", async (req, res) => {
    const body = CreateProgramBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Send a complete program definition." }); return; }
    await apply(req, res, "create", null, null, (s, by, now) => createProgram(s, body.data as GrantInput, by, now));
  });

  router.put("/programs/:id", async (req, res) => {
    const params = ProgramIdParams.safeParse(req.params);
    const body = UpdateProgramBody.safeParse(req.body);
    if (!params.success) { res.status(404).json({ error: "That program could not be found." }); return; }
    if (!body.success) { res.status(400).json({ error: "Send the program's version and a complete program definition." }); return; }
    const { version, program } = body.data;
    await apply(req, res, "edit", params.data.id, version, (s, by, now) => updateProgram(s, params.data.id, version, program as GrantInput, by, now));
  });

  const statusRoute = (path: string, action: string, command: (id: string, version: string) => Command) =>
    router.post(`/programs/:id/${path}`, async (req, res) => {
      const params = ProgramIdParams.safeParse(req.params);
      const body = ProgramVersionBody.safeParse(req.body);
      if (!params.success) { res.status(404).json({ error: "That program could not be found." }); return; }
      if (!body.success) { res.status(400).json({ error: "Send the program's version." }); return; }
      await apply(req, res, action, params.data.id, body.data.version, command(params.data.id, body.data.version));
    });

  statusRoute("publish", "publish", (id, version) => (s, by, now) => publishProgram(s, id, version, by, now));
  statusRoute("close", "close", (id, version) => (s, by, now) => closeProgram(s, id, version, by, now));
  statusRoute("delete", "delete", (id, version) => s => deleteProgram(s, id, version));

  return router;
}
