import { boolean, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Staff who may use the admin workspace. A row is created before the person
// signs in (by email); `authUserId` links it to their Supabase Auth user the
// first time they sign in with that confirmed email. Roles and their
// permissions live in @workspace/authz.
//
// Row-level security is on with no policies: Supabase's public REST API (the
// publishable key) can't read or write this table. The API server connects as
// the table owner, which RLS doesn't restrict.

export const staffRoleEnum = pgEnum("staff_role", ["super", "reviewer", "finance", "compliance", "support"]);

export const staffMembersTable = pgTable("staff_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: staffRoleEnum("role").notNull(),
  active: boolean("active").notNull().default(true),
  authUserId: uuid("auth_user_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const insertStaffMemberSchema = createInsertSchema(staffMembersTable).omit({ id: true, authUserId: true, createdAt: true, updatedAt: true });
export type InsertStaffMember = z.infer<typeof insertStaffMemberSchema>;
export type StaffMemberRow = typeof staffMembersTable.$inferSelect;
