import { Router, type IRouter } from "express";
import { GetProfileResponse, UpdateProfileBody } from "@workspace/api-zod";
import { validateProfile } from "@workspace/domain/rules";
import type { AuthUser } from "../lib/auth";
import type { ProfileRecord, ProfileRepo } from "../lib/profileRepo";
import { authLocals } from "../middlewares/auth";

// The signed-in person's applicant profile. Ownership comes only from the
// verified token: there is no way to name another user's profile.

/** A sign-up detail from Supabase metadata, trimmed and capped (the person can edit metadata, so it's untrusted). */
const detail = (metadata: Record<string, unknown> | undefined, key: string, max: number) => {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim().slice(0, max) : "";
};

export const toProfile = (r: ProfileRecord) => GetProfileResponse.parse({
  name: r.name, email: r.email, phone: r.phone, address: r.address, sector: r.sector, country: r.country,
  tier: r.tier, identityVerified: r.identityVerified, joined: r.createdAt.slice(0, 10),
});

/** Loads the profile, creating it from the sign-up details on first use and keeping the email in step with the account. */
export async function ownProfile(repo: ProfileRepo, user: AuthUser): Promise<ProfileRecord> {
  const email = user.email ?? "";
  const existing = await repo.get(user.id);
  if (existing) return existing.email === email ? existing : repo.update(user.id, { email });
  const birthDate = detail(user.metadata, "birth_date", 10);
  return repo.create({
    authUserId: user.id, email,
    name: detail(user.metadata, "full_name", 120) || email.split("@")[0] || "Applicant",
    phone: detail(user.metadata, "phone", 40), country: detail(user.metadata, "country", 80), sector: detail(user.metadata, "sector", 80),
    birthDate: /^\d{4}-\d{2}-\d{2}$/.test(birthDate) ? birthDate : null,
  });
}

export function profileRouter(repo: ProfileRepo): IRouter {
  const router: IRouter = Router();

  router.get("/profile", async (_req, res) => {
    res.json(toProfile(await ownProfile(repo, authLocals(res).user)));
  });

  router.patch("/profile", async (req, res) => {
    const body = UpdateProfileBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Send your name, phone, and address." }); return; }
    const { user } = authLocals(res);
    const current = await ownProfile(repo, user);
    // The email isn't editable here (it's the sign-in account's), so only its three fields are checked.
    const { email: _email, ...fieldErrors } = validateProfile({ ...body.data, email: current.email });
    if (Object.keys(fieldErrors).length) { res.status(400).json({ error: "Fix the highlighted fields.", fieldErrors }); return; }
    const saved = await repo.update(user.id, { name: body.data.name.trim(), phone: body.data.phone.trim(), address: body.data.address.trim() });
    res.json(toProfile(saved));
  });

  return router;
}
