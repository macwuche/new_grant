import { Router, type IRouter } from "express";
import type { ProfileRepo } from "../lib/profileRepo";
import { applicantSignInNotice, deviceHash, deviceLabel, staffSignInEmail, type SignInRepo } from "../lib/signIns";
import { authLocals } from "../middlewares/auth";
import { ownProfile } from "./profile";

const DEVICE_ID = /^[A-Za-z0-9-]{16,100}$/;

/**
 * The portal reports each completed sign-in (after two-step, when needed).
 * Applicants: a notification every time, emailed for a new device. Active
 * staff: an email for a new device. Staff who haven't finished two-step yet
 * aren't recorded; the portal reports again once they have.
 */
export function signInsRouter(signIns: SignInRepo, profiles: ProfileRepo): IRouter {
  const router: IRouter = Router();
  router.post("/sign-ins", async (req, res) => {
    const deviceId = (req.body as { deviceId?: unknown } | undefined)?.deviceId;
    if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId)) { res.status(400).json({ error: "Send this browser's device id." }); return; }
    const { user, staff, pendingStaff } = authLocals(res);
    if (pendingStaff || (staff && !staff.active)) { res.json({ recorded: false, newDevice: false }); return; }
    const now = new Date();
    const label = deviceLabel(req.get("user-agent"));
    const ip = req.ip ?? null;
    const hash = deviceHash(user.id, deviceId);
    const newDevice = staff
      ? await signIns.record(user.id, hash, label, now, isNew => ({ notifications: [], staffEvents: [], audit: [], emails: isNew ? [staffSignInEmail(staff, label, ip, now)] : [] }))
      : await (async () => {
        const profile = await ownProfile(profiles, user);
        return signIns.record(user.id, hash, label, now, isNew => ({ notifications: [applicantSignInNotice(profile.authUserId, isNew, label, ip, now)], staffEvents: [], audit: [] }));
      })();
    res.json({ recorded: true, newDevice });
  });
  return router;
}
