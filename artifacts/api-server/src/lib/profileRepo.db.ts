import { eq } from "drizzle-orm";
import { applicantProfilesTable, db, type ApplicantProfileRow } from "@workspace/db";
import type { ProfileRecord, ProfileRepo } from "./profileRepo";

const toRecord = (row: ApplicantProfileRow): ProfileRecord => ({
  authUserId: row.authUserId, name: row.name, email: row.email, phone: row.phone, address: row.address,
  sector: row.sector, country: row.country, birthDate: row.birthDate, tier: row.tier as 1 | 2 | 3,
  identityVerified: row.identityVerified, createdAt: row.createdAt.toISOString(),
});

const byId = (id: string) => eq(applicantProfilesTable.authUserId, id);

export const dbProfileRepo: ProfileRepo = {
  get: async id => { const [row] = await db.select().from(applicantProfilesTable).where(byId(id)); return row ? toRecord(row) : null; },
  create: async profile => {
    const [row] = await db.insert(applicantProfilesTable).values(profile).onConflictDoNothing().returning();
    if (row) return toRecord(row);
    const [existing] = await db.select().from(applicantProfilesTable).where(byId(profile.authUserId));
    return toRecord(existing!);
  },
  update: async (id, patch) => {
    const [row] = await db.update(applicantProfilesTable).set({ ...patch, updatedAt: new Date() }).where(byId(id)).returning();
    return toRecord(row!);
  },
};
