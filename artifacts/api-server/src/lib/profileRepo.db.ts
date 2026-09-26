import { and, desc, eq, sql } from "drizzle-orm";
import { applicantProfilesTable, db, type ApplicantProfileRow } from "@workspace/db";
import { NO_EFFECTS } from "./activity";
import { writeEffects } from "./activity.db";
import type { AccountPatch, ProfileRecord, ProfileRepo } from "./profileRepo";

export const toRecord = (row: ApplicantProfileRow): ProfileRecord => ({
  authUserId: row.authUserId, name: row.name, email: row.email, phone: row.phone, address: row.address,
  sector: row.sector, country: row.country, birthDate: row.birthDate, tier: row.tier as 1 | 2 | 3,
  identityVerified: row.identityVerified,
  account: {
    status: row.accountStatus,
    ...(row.lockReason ? { lockReason: row.lockReason } : {}),
    ...(row.lockedAt ? { lockedAt: row.lockedAt.toISOString() } : {}),
    ...(row.lockedBy ? { lockedBy: row.lockedBy } : {}),
    passwordResetRequired: row.passwordResetRequired, twoFactorResetRequired: row.twoFactorResetRequired, kyc: row.kyc,
  },
  emailNotifications: row.emailNotifications,
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
});

const accountColumns = (patch: AccountPatch) => ({
  ...(patch.tier !== undefined ? { tier: patch.tier } : {}),
  ...(patch.identityVerified !== undefined ? { identityVerified: patch.identityVerified } : {}),
  ...(patch.account ? {
    accountStatus: patch.account.status,
    lockReason: patch.account.lockReason ?? null,
    lockedAt: patch.account.lockedAt ? new Date(patch.account.lockedAt) : null,
    lockedBy: patch.account.lockedBy ?? null,
    passwordResetRequired: patch.account.passwordResetRequired,
    twoFactorResetRequired: patch.account.twoFactorResetRequired,
    kyc: patch.account.kyc,
  } : {}),
});

const byId = (id: string) => eq(applicantProfilesTable.authUserId, id);
// Versions are read back as JavaScript dates (milliseconds); Postgres keeps microseconds,
// so compare at millisecond precision or a row stamped by the database never matches.
const atVersion = (version: string) => sql`date_trunc('milliseconds', ${applicantProfilesTable.updatedAt}) = ${new Date(version)}`;

export const dbProfileRepo: ProfileRepo = {
  get: async id => { const [row] = await db.select().from(applicantProfilesTable).where(byId(id)); return row ? toRecord(row) : null; },
  list: async () => (await db.select().from(applicantProfilesTable).orderBy(desc(applicantProfilesTable.createdAt))).map(toRecord),
  create: async profile => {
    const now = new Date();
    const [row] = await db.insert(applicantProfilesTable).values({ ...profile, createdAt: now, updatedAt: now }).onConflictDoNothing().returning();
    if (row) return toRecord(row);
    const [existing] = await db.select().from(applicantProfilesTable).where(byId(profile.authUserId));
    return toRecord(existing!);
  },
  updateContact: async (id, patch) => {
    const [row] = await db.update(applicantProfilesTable).set({ ...patch, updatedAt: new Date() }).where(byId(id)).returning();
    return toRecord(row!);
  },
  saveAccount: async (id, patch, expectedVersion, effects = NO_EFFECTS) => db.transaction(async tx => {
    const [row] = await tx.update(applicantProfilesTable).set({ ...accountColumns(patch), updatedAt: new Date() })
      .where(and(byId(id), atVersion(expectedVersion))).returning();
    if (!row) return "stale" as const;
    await writeEffects(tx, effects);
    return toRecord(row);
  }),
};
