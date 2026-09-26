import { Router, type IRouter } from "express";
import type { TokenVerifier } from "../lib/auth";
import type { ActivityRepo } from "../lib/activity";
import type { ApplicationRepo } from "../lib/applicationRepo";
import type { DocumentRepo } from "../lib/documentRepo";
import type { FileStore } from "../lib/fileStore";
import type { EmailOutbox } from "../lib/email";
import type { EmailSettingsRepo } from "../lib/emailSettings";
import type { InboxRepo } from "../lib/inbox";
import type { Fetch } from "../lib/providers";
import type { MoneyRepo } from "../lib/moneyRepo";
import type { ProfileRepo } from "../lib/profileRepo";
import type { ProgramRepo } from "../lib/programRepo";
import type { StaffRepo } from "../lib/staffRepo";
import { authenticate, loadStaff, resetGate } from "../middlewares/auth";
import { byUser, failureLimiter, LIMITS, rateLimiter, type Limit } from "../middlewares/protect";
import { activityRouter } from "./activity";
import { applicantsRouter } from "./applicants";
import { applicationsRouter } from "./applications";
import { documentsRouter } from "./documents";
import { brandingRouter, emailRouter, emailWebhookRouter } from "./email";
import { moneyRouter } from "./money";
import healthRouter from "./health";
import meRouter from "./me";
import { profileRouter } from "./profile";
import { programsRouter } from "./programs";
import { staffRouter } from "./staff";

export type ApiDeps = { verifier: TokenVerifier | null; staffRepo: StaffRepo; programRepo: ProgramRepo; profileRepo: ProfileRepo; applicationRepo: ApplicationRepo; activityRepo: ActivityRepo; moneyRepo: MoneyRepo; documentRepo: DocumentRepo; fileStore: FileStore; emailOutbox: EmailOutbox; emailSettings: EmailSettingsRepo; inbox: InboxRepo;
  /** Calls to Resend and Supabase (tests pass a fake). */
  fetchImpl?: Fetch;
  /** Overrides for the rate limits (tests). */
  limits?: Partial<Record<keyof typeof LIMITS, Limit>>;
  /** Staff access needs a two-step (aal2) session (STAFF_MFA_REQUIRED, on unless "false"). */
  staffMfa?: boolean };

export function apiRouter({ verifier, staffRepo, programRepo, profileRepo, applicationRepo, activityRepo, moneyRepo, documentRepo, fileStore, emailOutbox, emailSettings, inbox, fetchImpl, limits = {}, staffMfa = true }: ApiDeps): IRouter {
  const router: IRouter = Router();
  const limit = { ...LIMITS, ...limits };
  const email = { outbox: emailOutbox, settings: emailSettings, inbox, ...(fetchImpl ? { fetchImpl } : {}) };
  router.use(healthRouter);
  // Resend's webhook signs its requests instead of signing in.
  router.use(emailWebhookRouter(email));
  // The application name, for pages shown before sign-in.
  router.use(brandingRouter(emailSettings));
  // Everything below requires a verified sign-in token; requests are rate-limited per address before it and per user after.
  const writes = rateLimiter(limit.writes, byUser);
  const uploads = rateLimiter(limit.uploads, byUser);
  router.use(failureLimiter(limit.anonymous), authenticate(verifier), rateLimiter(limit.user, byUser));
  router.use((req, res, next) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" ? next() : writes(req, res, next));
  router.post("/documents", uploads);
  router.use(loadStaff(staffRepo, staffMfa), resetGate(profileRepo));
  router.use(meRouter(staffMfa));
  router.use(staffRouter(staffRepo));
  router.use(programsRouter(programRepo, applicationRepo));
  router.use(profileRouter(profileRepo, documentRepo));
  router.use(applicantsRouter(profileRepo));
  router.use(applicationsRouter(applicationRepo, profileRepo, moneyRepo, documentRepo, fileStore));
  router.use(documentsRouter({ documents: documentRepo, files: fileStore, profiles: profileRepo, applications: applicationRepo, programs: programRepo }));
  router.use(moneyRouter(moneyRepo, profileRepo));
  router.use(activityRouter(activityRepo));
  router.use(emailRouter(email));
  return router;
}
