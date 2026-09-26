import { Router, type IRouter } from "express";
import type { EmailOutbox, Mailer } from "../lib/email";
import { requirePermission } from "../middlewares/auth";

// Email delivery status for super admins: whether sending is configured, the
// sender, and the outbox (counts and the latest messages, without bodies).

export function emailRouter(outbox: EmailOutbox, mailer: Mailer): IRouter {
  const router: IRouter = Router();
  router.get("/email/status", requirePermission("staff.manage"), async (_req, res) => {
    const { counts, recent } = await outbox.summary(25);
    res.json({ configured: mailer.configured, from: mailer.from, counts, recent });
  });
  return router;
}
