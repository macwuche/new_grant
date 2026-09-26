import { eq } from "drizzle-orm";
import { db, staffMembersTable, type StaffMemberRow } from "@workspace/db";
import { NO_EFFECTS } from "./activity";
import { withEffects } from "./activity.db";
import type { StaffRecord, StaffRepo } from "./staffRepo";

const toRecord = (row: StaffMemberRow): StaffRecord => ({ id: row.id, email: row.email, name: row.name, role: row.role, active: row.active, authUserId: row.authUserId });

export const dbStaffRepo: StaffRepo = {
  list: async () => (await db.select().from(staffMembersTable).orderBy(staffMembersTable.createdAt)).map(toRecord),
  findById: async id => { const [row] = await db.select().from(staffMembersTable).where(eq(staffMembersTable.id, id)); return row ? toRecord(row) : null; },
  findByAuthUserId: async authUserId => { const [row] = await db.select().from(staffMembersTable).where(eq(staffMembersTable.authUserId, authUserId)); return row ? toRecord(row) : null; },
  findByEmail: async email => { const [row] = await db.select().from(staffMembersTable).where(eq(staffMembersTable.email, email.toLowerCase())); return row ? toRecord(row) : null; },
  create: (member, effects = NO_EFFECTS) => withEffects(effects, async tx => {
    const [row] = await tx.insert(staffMembersTable).values({ ...member, email: member.email.toLowerCase() }).returning();
    return toRecord(row!);
  }),
  update: (id, patch, effects = NO_EFFECTS) => withEffects(effects, async tx => {
    const [row] = await tx.update(staffMembersTable).set({ ...patch, updatedAt: new Date() }).where(eq(staffMembersTable.id, id)).returning();
    return toRecord(row!);
  }),
};
