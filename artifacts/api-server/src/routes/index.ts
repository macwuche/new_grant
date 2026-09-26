import { Router, type IRouter } from "express";
import type { TokenVerifier } from "../lib/auth";
import type { StaffRepo } from "../lib/staffRepo";
import { authenticate, loadStaff } from "../middlewares/auth";
import healthRouter from "./health";
import meRouter from "./me";
import { staffRouter } from "./staff";

export type ApiDeps = { verifier: TokenVerifier | null; staffRepo: StaffRepo };

export function apiRouter({ verifier, staffRepo }: ApiDeps): IRouter {
  const router: IRouter = Router();
  router.use(healthRouter);
  // Everything below requires a verified sign-in token.
  router.use(authenticate(verifier), loadStaff(staffRepo));
  router.use(meRouter);
  router.use(staffRouter(staffRepo));
  return router;
}
