import { Router, type IRouter } from "express";
import { ROLE_PERMISSIONS } from "@workspace/authz";
import { GetMeResponse } from "@workspace/api-zod";
import { authLocals } from "../middlewares/auth";
import { toStaffMember } from "./staff";

const router: IRouter = Router();

router.get("/me", (_req, res) => {
  const { user, staff } = authLocals(res);
  const permissions = staff?.active ? ROLE_PERMISSIONS[staff.role] : [];
  res.json(GetMeResponse.parse({ user, staff: staff ? toStaffMember(staff) : null, permissions }));
});

export default router;
