import { Router, type IRouter } from "express";
import type { TokenVerifier } from "../lib/auth";
import type { ActivityRepo } from "../lib/activity";
import type { ApplicationRepo } from "../lib/applicationRepo";
import type { ProfileRepo } from "../lib/profileRepo";
import type { ProgramRepo } from "../lib/programRepo";
import type { StaffRepo } from "../lib/staffRepo";
import { authenticate, loadStaff } from "../middlewares/auth";
import { activityRouter } from "./activity";
import { applicantsRouter } from "./applicants";
import { applicationsRouter } from "./applications";
import healthRouter from "./health";
import meRouter from "./me";
import { profileRouter } from "./profile";
import { programsRouter } from "./programs";
import { staffRouter } from "./staff";

export type ApiDeps = { verifier: TokenVerifier | null; staffRepo: StaffRepo; programRepo: ProgramRepo; profileRepo: ProfileRepo; applicationRepo: ApplicationRepo; activityRepo: ActivityRepo };

export function apiRouter({ verifier, staffRepo, programRepo, profileRepo, applicationRepo, activityRepo }: ApiDeps): IRouter {
  const router: IRouter = Router();
  router.use(healthRouter);
  // Everything below requires a verified sign-in token.
  router.use(authenticate(verifier), loadStaff(staffRepo));
  router.use(meRouter);
  router.use(staffRouter(staffRepo));
  router.use(programsRouter(programRepo, applicationRepo));
  router.use(profileRouter(profileRepo));
  router.use(applicantsRouter(profileRepo));
  router.use(applicationsRouter(applicationRepo, profileRepo));
  router.use(activityRouter(activityRepo));
  return router;
}
