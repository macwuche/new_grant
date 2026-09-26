import { Router, type IRouter, type Response } from "express";
import { LockApplicantBody, RequireCredentialResetBody, SetApplicantTierBody, UnlockApplicantParams as ApplicantIdParams } from "@workspace/api-zod";
import type { Permission } from "@workspace/authz";
import { approveKyc, lockAccount, rejectKyc, requestReverification, requireCredentialReset, setApplicantTier, unlockAccount } from "@workspace/domain/accounts";
import type { DemoState, Result, Tier } from "@workspace/domain/model";
import { CURRENT_APPLICANT_ID as SLOT } from "@workspace/domain/seed";
import { runAccountRule } from "../lib/applicantRules";
import { logger } from "../lib/logger";
import type { ProfileRecord, ProfileRepo } from "../lib/profileRepo";
import { authLocals, requirePermission, requireStaff } from "../middlewares/auth";
import { toProfile } from "./profile";

// Staff: the applicant directory and account controls. Each action runs the
// shared account rule with the applicant in the rules' current-applicant slot
// (see ../lib/applicantRules.ts) and is permission-checked per role.

export const toEntry = (r: ProfileRecord) => ({ id: r.authUserId, profile: toProfile(r) });

type Command = (state: DemoState, by: string) => Result;

export function applicantsRouter(repo: ProfileRepo): IRouter {
  const router: IRouter = Router();
  router.use("/applicants", requireStaff);

  router.get("/applicants", async (_req, res) => {
    res.json((await repo.list()).map(toEntry));
  });

  const action = (path: string, permission: Permission, parse: (body: unknown) => { ok: true; command: Command } | { ok: false; error: string }) =>
    router.post(`/applicants/:id/${path}`, requirePermission(permission), async (req, res: Response) => {
      const params = ApplicantIdParams.safeParse(req.params);
      const record = params.success ? await repo.get(params.data.id) : null;
      if (!record) { res.status(404).json({ error: "That applicant could not be found." }); return; }
      // Conflict of interest: staff can't approve, re-tier, or unlock their own applicant account.
      if (record.authUserId === authLocals(res).user.id) { res.status(403).json({ error: "You can't change your own applicant account. Ask another team member." }); return; }
      const parsed = parse(req.body);
      if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
      const actor = authLocals(res).staff!;
      const outcome = await runAccountRule(repo, record, s => parsed.command(s, actor.name));
      if (!outcome.ok) { res.status(outcome.status).json(outcome.body); return; }
      logger.info({ actor: actor.id, applicant: record.authUserId, action: path }, "applicant account changed");
      res.json({ applicant: toEntry(outcome.record), message: outcome.message });
    });

  const none = (command: Command) => () => ({ ok: true as const, command });
  const reason = (make: (reason: string) => Command) => (body: unknown) => {
    const parsed = LockApplicantBody.safeParse(body);
    return parsed.success ? { ok: true as const, command: make(parsed.data.reason) } : { ok: false as const, error: "Give a reason." };
  };

  action("tier", "accounts.tier", body => {
    const parsed = SetApplicantTierBody.safeParse(body);
    return parsed.success ? { ok: true, command: s => setApplicantTier(s, SLOT, parsed.data.tier as Tier, parsed.data.reason, new Date()) } : { ok: false, error: "Send a tier (1–3) and a reason." };
  });
  action("lock", "accounts.manage", reason(text => (s, by) => lockAccount(s, SLOT, text, by, new Date())));
  action("unlock", "accounts.manage", none(s => unlockAccount(s, SLOT, new Date())));
  action("credential-reset", "accounts.manage", body => {
    const parsed = RequireCredentialResetBody.safeParse(body);
    return parsed.success ? { ok: true, command: s => requireCredentialReset(s, SLOT, parsed.data.kind, new Date()) } : { ok: false, error: "Say which reset to require." };
  });
  action("identity/approve", "kyc.review", none((s, by) => approveKyc(s, SLOT, by, new Date())));
  action("identity/reject", "kyc.review", reason(text => (s, by) => rejectKyc(s, SLOT, text, by, new Date())));
  action("identity/reverify", "kyc.review", reason(text => (s, by) => requestReverification(s, SLOT, text, by, new Date())));

  return router;
}
