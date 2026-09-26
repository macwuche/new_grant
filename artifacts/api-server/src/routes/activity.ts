import { Router, type IRouter } from "express";
import { MarkNotificationReadParams, MarkStaffFeedReadParams } from "@workspace/api-zod";
import type { ActivityRepo } from "../lib/activity";
import { authLocals, requirePermission, requireStaff } from "../middlewares/auth";

// Notifications (each applicant's own), the staff activity feed (shared items,
// read state per staff member), and the audit log (audit.view).

const seqOf = (id: string) => Number(id.slice(3));

export function activityRouter(repo: ActivityRepo): IRouter {
  const router: IRouter = Router();

  router.get("/notifications", async (_req, res) => {
    res.json(await repo.notificationsFor(authLocals(res).user.id));
  });
  router.post("/notifications/read-all", async (_req, res) => {
    const count = await repo.markAllNotificationsRead(authLocals(res).user.id);
    res.json({ message: count ? `${count} notification${count === 1 ? "" : "s"} marked as read.` : "No unread notifications." });
  });
  router.post("/notifications/:id/read", async (req, res) => {
    const params = MarkNotificationReadParams.safeParse(req.params);
    if (!params.success || !(await repo.markNotificationRead(authLocals(res).user.id, seqOf(params.data.id)))) {
      res.status(404).json({ error: "That notification could not be found." }); return;
    }
    res.json({ message: "Marked as read." });
  });

  router.use("/staff-feed", requireStaff);
  router.get("/staff-feed", async (_req, res) => {
    res.json(await repo.staffEvents(authLocals(res).staff!.id));
  });
  router.post("/staff-feed/read-all", async (_req, res) => {
    const count = await repo.markAllStaffEventsRead(authLocals(res).staff!.id);
    res.json({ message: count ? `${count} item${count === 1 ? "" : "s"} marked as read.` : "Nothing unread." });
  });
  router.post("/staff-feed/:id/read", async (req, res) => {
    const params = MarkStaffFeedReadParams.safeParse(req.params);
    if (!params.success || !(await repo.markStaffEventRead(authLocals(res).staff!.id, seqOf(params.data.id)))) {
      res.status(404).json({ error: "That activity item could not be found." }); return;
    }
    res.json({ message: "Marked as read." });
  });

  router.get("/audit", requirePermission("audit.view"), async (_req, res) => {
    const [events, chain] = await Promise.all([repo.audit(), repo.verifyAudit()]);
    res.json({ events, chain });
  });

  return router;
}
