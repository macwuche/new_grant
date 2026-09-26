import { Router, type IRouter } from "express";
import type { TokenVerifier } from "../lib/auth";
import type { ActivityRepo } from "../lib/activity";
import type { ApplicationRepo } from "../lib/applicationRepo";
import type { DocumentRepo } from "../lib/documentRepo";
import type { FileStore } from "../lib/fileStore";
import type { MoneyRepo } from "../lib/moneyRepo";
import type { ProfileRepo } from "../lib/profileRepo";
import type { ProgramRepo } from "../lib/programRepo";
import type { StaffRepo } from "../lib/staffRepo";
import { authenticate, loadStaff } from "../middlewares/auth";
import { activityRouter } from "./activity";
import { applicantsRouter } from "./applicants";
import { applicationsRouter } from "./applications";
import { documentsRouter } from "./documents";
import { moneyRouter } from "./money";
import healthRouter from "./health";
import meRouter from "./me";
import { profileRouter } from "./profile";
import { programsRouter } from "./programs";
import { staffRouter } from "./staff";

export type ApiDeps = { verifier: TokenVerifier | null; staffRepo: StaffRepo; programRepo: ProgramRepo; profileRepo: ProfileRepo; applicationRepo: ApplicationRepo; activityRepo: ActivityRepo; moneyRepo: MoneyRepo; documentRepo: DocumentRepo; fileStore: FileStore };

export function apiRouter({ verifier, staffRepo, programRepo, profileRepo, applicationRepo, activityRepo, moneyRepo, documentRepo, fileStore }: ApiDeps): IRouter {
  const router: IRouter = Router();
  router.use(healthRouter);
  // Everything below requires a verified sign-in token.
  router.use(authenticate(verifier), loadStaff(staffRepo));
  router.use(meRouter);
  router.use(staffRouter(staffRepo));
  router.use(programsRouter(programRepo, applicationRepo));
  router.use(profileRouter(profileRepo, documentRepo));
  router.use(applicantsRouter(profileRepo));
  router.use(applicationsRouter(applicationRepo, profileRepo, moneyRepo, documentRepo, fileStore));
  router.use(documentsRouter({ documents: documentRepo, files: fileStore, profiles: profileRepo, applications: applicationRepo, programs: programRepo }));
  router.use(moneyRouter(moneyRepo, profileRepo));
  router.use(activityRouter(activityRepo));
  return router;
}
