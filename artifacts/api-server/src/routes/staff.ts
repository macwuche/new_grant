import { Router, type IRouter } from "express";
import { ROLE_LABELS, staffChangeError } from "@workspace/authz";
import { CreateStaffMemberBody, ListStaffResponse, UpdateStaffMemberBody, UpdateStaffMemberParams, UpdateStaffMemberResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import type { StaffRecord, StaffRepo } from "../lib/staffRepo";
import { auditEntry } from "../lib/activity";
import { appUrl, staffInviteEmail } from "../lib/email";
import { auditContext, authLocals, requirePermission } from "../middlewares/auth";

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
    const name = body.data.name.trim();
    // The new member's id doesn't exist yet, so the entry is keyed by their email.
    const audit = auditEntry(auditContext(req, res, "Add staff member", email), `${name} added as ${body.data.role}.`,
      [{ field: "email", before: "—", after: email }, { field: "name", before: "—", after: name }, { field: "role", before: "—", after: body.data.role }], new Date());
    const invite = staffInviteEmail({ email, name, roleLabel: ROLE_LABELS[body.data.role] }, authLocals(res).staff!.name, appUrl());
    const created = await repo.create({ email, name, role: body.data.role }, { notifications: [], staffEvents: [], audit: [audit], emails: [invite] });
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
    const target = all.find(m => m.id === params.data.id)!;
    const changes = [
      ...(body.data.role !== undefined && body.data.role !== target.role ? [{ field: "role", before: target.role, after: body.data.role }] : []),
      ...(body.data.active !== undefined && body.data.active !== target.active ? [{ field: "active", before: String(target.active), after: String(body.data.active) }] : []),
    ];
    const audit = auditEntry(auditContext(req, res, "Change staff access", target.id), `${target.name}: ${changes.map(c => `${c.field} ${c.before} → ${c.after}`).join(", ")}.`, changes, new Date());
    const updated = await repo.update(params.data.id, body.data, { notifications: [], staffEvents: [], audit: [audit] });
    logger.info({ actor: actor.id, target: updated.id, change: body.data }, "staff member updated");
    res.json(UpdateStaffMemberResponse.parse(toStaffMember(updated)));
  });

  return router;
}
