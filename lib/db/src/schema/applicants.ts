import { boolean, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

// One profile per applicant account, keyed by their Supabase Auth user id.
// Created on first use from the details given at sign-up. The email comes
// from the sign-in account; tier and identity status are staff-controlled.
// Row-level security is on with no policies (see ./staff.ts).

export const applicantProfilesTable = pgTable("applicant_profiles", {
  authUserId: uuid("auth_user_id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull().default(""),
  address: text("address").notNull().default(""),
  sector: text("sector").notNull().default(""),
  country: text("country").notNull().default(""),
  birthDate: text("birth_date"),
  tier: smallint("tier").notNull().default(1),
  identityVerified: boolean("identity_verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export type ApplicantProfileRow = typeof applicantProfilesTable.$inferSelect;
