import { Router, type IRouter, type Response } from "express";
import { CreateProgramBody, PublishProgramBody as ProgramVersionBody, UpdateProgramBody, UpdateProgramParams as ProgramIdParams } from "@workspace/api-zod";
import type { DemoState, Grant, GrantInput, Result } from "@workspace/domain/model";
import { closeProgram, createProgram, deleteProgram, publishProgram, updateProgram } from "@workspace/domain/programs";
import { serverState } from "@workspace/domain/server";
import { logger } from "../lib/logger";
import type { ProgramRepo, WriteOutcome } from "../lib/programRepo";
import { authLocals, requirePermission } from "../middlewares/auth";

// Grant programs. Every change runs the same rule functions the portal uses
// (@workspace/domain/programs) against the programs loaded from the database,
// then stores the one program that changed, conditional on its version.
//
// Not enforced here until applications move to the server (phase 12, slice 3):
// locking criteria after the first submission, keeping the budget above what's
// awarded, and notifying applicants holding drafts when a program closes.

const STALE = "This program changed since you opened it. Review the latest version and try again.";

type Command = (state: DemoState, by: string, now: Date) => Result;

function refuse(res: Response, outcome: Exclude<WriteOutcome, "ok">) {
  if (outcome === "stale") res.status(409).json({ error: STALE });
  else res.status(400).json({ error: "Fix the highlighted fields.", fieldErrors: { name: "Another program already uses this name." } });
}

export function programsRouter(repo: ProgramRepo): IRouter {
  const router: IRouter = Router();

  router.get("/programs", async (_req, res) => {
    const { staff } = authLocals(res);
    const all = await repo.list();
    res.json(staff?.active ? all : all.filter(g => g.status !== "Draft"));
  });

  /** Runs a rule for one existing program (or a new one when `id` is null) and stores the result. */
  async function apply(res: Response, action: string, id: string | null, version: string | null, command: Command) {
    const actor = authLocals(res).staff!;
    const grants = await repo.list();
    const existing = id ? grants.find(g => g.id === id) : undefined;
    if (id && !existing) { res.status(404).json({ error: "That program could not be found." }); return; }
    if (existing && existing.updatedAt !== version) { res.status(409).json({ error: STALE }); return; }

    const state = serverState({ grants, nextId: id ? 0 : await repo.nextNumber() });
    const result = command(state, actor.name, new Date());
    if (!result.ok) { res.status(400).json({ error: result.error, ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}) }); return; }

    let saved: Grant | undefined;
    let outcome: WriteOutcome;
    if (!id) {
      saved = result.state.grants.find(g => !grants.some(before => before.id === g.id));
      outcome = await repo.insert(saved!);
    } else {
      saved = result.state.grants.find(g => g.id === id);
      outcome = saved ? await repo.update(saved, version!) : await repo.remove(id, version!);
    }
    if (outcome !== "ok") { refuse(res, outcome); return; }

    logger.info({ actor: actor.id, program: saved?.id ?? id, action }, "program changed");
    if (saved) res.status(id ? 200 : 201).json({ program: saved, message: result.message });
    else res.json({ message: result.message });
  }

  // Reading is open to every signed-in user; every change needs programs.manage.
  router.use("/programs", (req, res, next) => req.method === "GET" ? next() : requirePermission("programs.manage")(req, res, next));

  router.post("/programs", async (req, res) => {
    const body = CreateProgramBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Send a complete program definition." }); return; }
    await apply(res, "create", null, null, (s, by, now) => createProgram(s, body.data as GrantInput, by, now));
  });

  router.put("/programs/:id", async (req, res) => {
    const params = ProgramIdParams.safeParse(req.params);
    const body = UpdateProgramBody.safeParse(req.body);
    if (!params.success) { res.status(404).json({ error: "That program could not be found." }); return; }
    if (!body.success) { res.status(400).json({ error: "Send the program's version and a complete program definition." }); return; }
    const { version, program } = body.data;
    await apply(res, "edit", params.data.id, version, (s, by, now) => updateProgram(s, params.data.id, version, program as GrantInput, by, now));
  });

  const statusRoute = (path: string, action: string, command: (id: string, version: string) => Command) =>
    router.post(`/programs/:id/${path}`, async (req, res) => {
      const params = ProgramIdParams.safeParse(req.params);
      const body = ProgramVersionBody.safeParse(req.body);
      if (!params.success) { res.status(404).json({ error: "That program could not be found." }); return; }
      if (!body.success) { res.status(400).json({ error: "Send the program's version." }); return; }
      await apply(res, action, params.data.id, body.data.version, command(params.data.id, body.data.version));
    });

  statusRoute("publish", "publish", (id, version) => (s, by, now) => publishProgram(s, id, version, by, now));
  statusRoute("close", "close", (id, version) => (s, by, now) => closeProgram(s, id, version, by, now));
  statusRoute("delete", "delete", (id, version) => s => deleteProgram(s, id, version));

  return router;
}
