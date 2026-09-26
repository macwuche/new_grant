import type { NextFunction, Request, Response } from "express";
import { roleCan, type Permission } from "@workspace/authz";
import { bearerToken, type AuthUser, type TokenVerifier } from "../lib/auth";
import type { StaffRecord, StaffRepo } from "../lib/staffRepo";

// res.locals.user: the verified user. res.locals.staff: their staff record, if any.
export type AuthLocals = { user: AuthUser; staff: StaffRecord | null };
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

export function loadStaff(repo: StaffRepo) {
  return async (_req: Request, res: Response, next: NextFunction) => {
    res.locals.staff = await resolveStaff(repo, authLocals(res).user);
    next();
  };
}

export function requirePermission(permission: Permission) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const { staff } = authLocals(res);
    if (!staff) { res.status(403).json({ error: "This area is for grant team staff only." }); return; }
    if (!staff.active) { res.status(403).json({ error: "Your staff access is disabled." }); return; }
    if (!roleCan(staff.role, permission)) { res.status(403).json({ error: "Your role doesn't allow this." }); return; }
    next();
  };
}
