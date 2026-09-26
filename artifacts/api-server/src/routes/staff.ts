import { Router, type IRouter } from "express";
import { staffChangeError } from "@workspace/authz";
import { CreateStaffMemberBody, ListStaffResponse, UpdateStaffMemberBody, UpdateStaffMemberParams, UpdateStaffMemberResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import type { StaffRecord, StaffRepo } from "../lib/staffRepo";
import { authLocals, requirePermission } from "../middlewares/auth";

export const toStaffMember = (r: StaffRecord) => ({ id: r.id, email: r.email, name: r.name, role: r.role, active: r.active, linked: !!r.authUserId });

export function staffRouter(repo: StaffRepo): IRouter {
  const router: IRouter = Router();
  router.use("/staff", requirePermission("staff.manage"));

  router.get("/staff", async (_req, res) => {
    res.json(ListStaffResponse.parse((await repo.list()).map(toStaffMember)));
  });

  router.post("/staff", async (req, res) => {
    const body = CreateStaffMemberBody.strict().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Enter a valid email, a name of 2–80 characters, and a role." }); return; }
    const email = body.data.email.trim().toLowerCase();
    if (await repo.findByEmail(email)) { res.status(409).json({ error: "A staff member with this email already exists." }); return; }
    const created = await repo.create({ email, name: body.data.name.trim(), role: body.data.role });
    logger.info({ actor: authLocals(res).staff!.id, target: created.id, role: created.role }, "staff member added");
    res.status(201).json(toStaffMember(created));
  });

  router.patch("/staff/:id", async (req, res) => {
    const params = UpdateStaffMemberParams.safeParse(req.params);
    const body = UpdateStaffMemberBody.strict().safeParse(req.body);
    if (!params.success) { res.status(404).json({ error: "That staff member could not be found." }); return; }
    if (!body.success || (body.data.role === undefined && body.data.active === undefined)) { res.status(400).json({ error: "Send a role and/or an active flag." }); return; }
    const all = await repo.list();
    if (!all.some(m => m.id === params.data.id)) { res.status(404).json({ error: "That staff member could not be found." }); return; }
    const actor = authLocals(res).staff!;
    const error = staffChangeError(all, params.data.id, body.data, actor.id);
    if (error) { res.status(400).json({ error }); return; }
    const updated = await repo.update(params.data.id, body.data);
    logger.info({ actor: actor.id, target: updated.id, change: body.data }, "staff member updated");
    res.json(UpdateStaffMemberResponse.parse(toStaffMember(updated)));
  });

  return router;
}
