import { index, jsonb, numeric, pgEnum, pgSequence, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { applicantProfilesTable } from "./applicants";
import { programsTable } from "./programs";

// Grant applications. Mirrors `Application` in @workspace/domain; the rules in
// @workspace/domain/rules and /review decide every change. `updated_at` is the
// record version the review rules check (internal notes and escalations
// deliberately don't change it). Every write runs in a transaction holding a
// lock on the program, so budgets and locked criteria can't be raced.
// Row-level security is on with no policies (see ./staff.ts).

export const applicationStatusEnum = pgEnum("application_status", ["Draft", "Submitted", "Under review", "Changes requested", "Approved", "Declined"]);

export type ApplicationEventJson = { status: (typeof applicationStatusEnum.enumValues)[number]; at: string; actor: "Applicant" | "Reviewer"; note: string };
export type InternalNoteJson = { at: string; author: string; text: string };
export type EscalationJson = { at: string; by: string; reason: string; status: "Open" | "Cleared"; clearedAt?: string; clearedBy?: string; resolution?: string };

export const applicationsTable = pgTable("applications", {
  id: text("id").primaryKey(),
  applicantId: uuid("applicant_id").notNull().references(() => applicantProfilesTable.authUserId),
  grantId: text("grant_id").notNull().references(() => programsTable.id),
  status: applicationStatusEnum("status").notNull(),
  businessName: text("business_name").notNull(),
  requestedAmount: numeric("requested_amount", { precision: 12, scale: 2, mode: "number" }).notNull(),
  registrationNumber: text("registration_number").notNull(),
  purpose: text("purpose").notNull(),
  checklist: jsonb("checklist").$type<string[]>().notNull(),
  answers: jsonb("answers").$type<Record<string, string>>().notNull(),
  /** The commission rate charged at approval (the program's rate then; since 5 Oct 2026). Rows submitted earlier may hold the rate at submission until approved. */
  commissionRate: numeric("commission_rate", { precision: 5, scale: 2, mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  reviewer: text("reviewer"),
  awardedAmount: numeric("awarded_amount", { precision: 12, scale: 2, mode: "number" }),
  history: jsonb("history").$type<ApplicationEventJson[]>().notNull(),
  internalNotes: jsonb("internal_notes").$type<InternalNoteJson[]>().notNull(),
  escalation: jsonb("escalation").$type<EscalationJson | null>(),
}, t => [index("applications_applicant_idx").on(t.applicantId), index("applications_grant_idx").on(t.grantId)]).enableRLS();

/** Numbers for new application ids (APP-5001, …); above the browser demo's range. */
export const applicationNumberSeq = pgSequence("application_number_seq", { startWith: 5001 });

export type ApplicationRow = typeof applicationsTable.$inferSelect;
