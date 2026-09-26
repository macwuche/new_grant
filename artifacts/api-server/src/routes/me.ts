import { Router, type IRouter } from "express";
import { ROLE_PERMISSIONS } from "@workspace/authz";
import { GetMeResponse } from "@workspace/api-zod";
import { authLocals } from "../middlewares/auth";
import { toStaffMember } from "./staff";

// Who is signed in: the account, the staff record (also while two-step sign-in
// is still needed, so the portal can ask for it), and the session's two-step state.

export default function meRouter(staffMfa: boolean): IRouter {
  const router: IRouter = Router();
  router.get("/me", (_req, res) => {
    const { user, staff, pendingStaff } = authLocals(res);
    const record = staff ?? pendingStaff ?? null;
    const permissions = staff?.active ? ROLE_PERMISSIONS[staff.role] : [];
    res.json(GetMeResponse.parse({
      user, staff: record ? toStaffMember(record) : null, permissions,
      twoStep: { level: user.aal ?? "aal1", enrolled: (user.factors?.length ?? 0) > 0, requiredForStaff: staffMfa },
    }));
  });
  return router;
}
