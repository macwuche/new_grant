import type { NextFunction, Request, Response } from "express";
import { roleCan, type Permission } from "@workspace/authz";
import { bearerToken, type AuthUser, type TokenVerifier } from "../lib/auth";
import type { AuditContext } from "../lib/activity";
import type { StaffRecord, StaffRepo } from "../lib/staffRepo";
import type { ProfileRepo } from "../lib/profileRepo";

// res.locals.user: the verified user. res.locals.staff: their staff record, if
// any, and only once the session meets the staff sign-in requirements;
// res.locals.pendingStaff: the record while it doesn't (two-step not done).
export type AuthLocals = { user: AuthUser; staff: StaffRecord | null; pendingStaff?: StaffRecord | null };
export const authLocals = (res: Response) => res.locals as AuthLocals;

/** Requires a valid sign-in token. `verifier` is null when sign-in isn't configured on this server. */
export function authenticate(verifier: TokenVerifier | null) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!verifier) { res.status(503).json({ error: "Sign-in isn't configured on this server yet." }); return; }
    const token = bearerToken(req.headers.authorization);
    if (!token) { res.status(401).json({ error: "Sign in to continue." }); return; }
    const user = await verifier(token).catch(() => null);
    if (!user) { res.status(401).json({ error: "Your session has expired or is invalid. Sign in again." }); return; }
    res.locals.user = user;
    // Anyone who has set up two-step sign-in must use it: a session without the second step can only ask who it is.
    if (user.factors?.length && user.aal !== "aal2" && !(req.method === "GET" && req.path === "/me")) {
      res.status(403).json({ error: "Enter the code from your authenticator app to continue.", code: "mfa_required" }); return;
    }
    next();
  };
}

/**
 * Finds the user's staff record. On first sign-in, links a pending record with
 * the same email, but only once that email is confirmed, so nobody can claim a
 * staff seat by signing up with someone else's address.
 */
export async function resolveStaff(repo: StaffRepo, user: AuthUser): Promise<StaffRecord | null> {
  const linked = await repo.findByAuthUserId(user.id);
  if (linked) return linked;
  if (!user.email || !user.emailConfirmed) return null;
  const pending = await repo.findByEmail(user.email);
  if (!pending || pending.authUserId) return null;
  return repo.update(pending.id, { authUserId: user.id });
}

/** Loads the staff record. With `requireTwoStep`, staff access needs a two-step (aal2) session. */
export function loadStaff(repo: StaffRepo, requireTwoStep = true) {
  return async (_req: Request, res: Response, next: NextFunction) => {
    const { user } = authLocals(res);
    const staff = await resolveStaff(repo, user);
    const ready = !staff || !requireTwoStep || user.aal === "aal2";
    res.locals.staff = ready ? staff : null;
    res.locals.pendingStaff = ready ? null : staff;
    next();
  };
}

/** Staff whose session hasn't done two-step sign-in yet: say what to do. */
function twoStepNeeded(res: Response): boolean {
  const { pendingStaff, user } = authLocals(res);
  if (!pendingStaff) return false;
  res.status(403).json(user.factors?.length
    ? { error: "Staff access needs two-step sign-in. Enter the code from your authenticator app.", code: "mfa_required" }
    : { error: "Staff access needs two-step sign-in. Set up an authenticator app first.", code: "mfa_enrollment_required" });
  return true;
}

/** Who is acting and from where, for an audit entry. Call only after a staff check. */
export function auditContext(req: Request, res: Response, action: string, target: string): AuditContext {
  const { id, name, role, active } = authLocals(res).staff!;
  return { actor: { id, name, role, active }, action, target, ip: req.ip ?? null };
}

/** Any active staff member, whatever their role (e.g. read-only directory views). */
export function requireStaff(_req: Request, res: Response, next: NextFunction) {
  if (twoStepNeeded(res)) return;
  const { staff } = authLocals(res);
  if (!staff) { res.status(403).json({ error: "This area is for grant team staff only." }); return; }
  if (!staff.active) { res.status(403).json({ error: "Your staff access is disabled." }); return; }
  next();
}

export function requirePermission(permission: Permission) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (twoStepNeeded(res)) return;
    const { staff } = authLocals(res);
    if (!staff) { res.status(403).json({ error: "This area is for grant team staff only." }); return; }
    if (!staff.active) { res.status(403).json({ error: "Your staff access is disabled." }); return; }
    if (!roleCan(staff.role, permission)) { res.status(403).json({ error: "Your role doesn't allow this." }); return; }
    next();
  };
}

/** What someone with a pending staff-required reset may still do: see who they are, read notifications, and complete the reset. */
const DURING_RESET = new Set(["GET /me", "GET /profile", "POST /profile/credential-reset", "GET /notifications", "GET /profile/email-preference"]);

/**
 * Blocks everything else while staff require a password or two-step reset on
 * this account, so a session from before the reset can't keep being used.
 */
export function resetGate(profiles: ProfileRepo) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (DURING_RESET.has(`${req.method} ${req.path}`)) { next(); return; }
    const profile = await profiles.get(authLocals(res).user.id);
    const account = profile?.account;
    if (account?.passwordResetRequired || account?.twoFactorResetRequired) {
      res.status(403).json({
        error: account.passwordResetRequired ? "The grant team requires a new password. Use the reset link from the sign-in page, then confirm it in Settings." : "The grant team reset your two-step sign-in. Set up your authenticator app again in Settings.",
        code: account.passwordResetRequired ? "password_reset_required" : "two_factor_reset_required",
      });
      return;
    }
    next();
  };
}
