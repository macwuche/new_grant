import { boolean, jsonb, pgEnum, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

// One profile per applicant account, keyed by their Supabase Auth user id.
// Created on first use from the details given at sign-up. The email comes
// from the sign-in account. Tier, identity status, the lock, and required
// credential resets are staff-controlled (rules: @workspace/domain/accounts).
// `updated_at` is the record version: writes succeed only if it's unchanged.
// Row-level security is on with no policies (see ./staff.ts).

export const accountStatusEnum = pgEnum("account_status", ["Active", "Locked"]);

/** Identity check; only the last four characters of the document number are kept. Mirrors `Kyc` in @workspace/domain. */
export type KycJson = {
  status: "Not submitted" | "Pending" | "Verified" | "Rejected";
  documentType?: "Passport" | "National ID" | "Driver's licence";
  documentLast4?: string;
  nameOnDocument?: string;
  submittedAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  rejectionReason?: string;
};

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
  accountStatus: accountStatusEnum("account_status").notNull().default("Active"),
  lockReason: text("lock_reason"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
  passwordResetRequired: boolean("password_reset_required").notNull().default(false),
  twoFactorResetRequired: boolean("two_factor_reset_required").notNull().default(false),
  kyc: jsonb("kyc").$type<KycJson>().notNull().default({ status: "Not submitted" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export type ApplicantProfileRow = typeof applicantProfilesTable.$inferSelect;
