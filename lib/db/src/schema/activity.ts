import { bigint, bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { applicantProfilesTable } from "./applicants";
import { staffMembersTable } from "./staff";

// Records the rules create alongside a change: applicant notifications, the
// staff activity feed, and the audit log. Each is written in the same
// transaction as the change it describes. Row-level security is on with no
// policies (see ./staff.ts).

/** In-app notifications for one applicant. */
export const notificationsTable = pgTable("notifications", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  applicantId: uuid("applicant_id").notNull().references(() => applicantProfilesTable.authUserId),
  at: timestamp("at", { withTimezone: true }).notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  href: text("href").notNull(),
  read: boolean("read").notNull().default(false),
}, t => [index("notifications_applicant_idx").on(t.applicantId, t.seq)]).enableRLS();

/** Applicant actions staff may need to act on, shared by the team. */
export const staffEventsTable = pgTable("staff_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  kind: text("kind").$type<"application" | "deposit" | "withdrawal" | "card" | "security" | "account">().notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  href: text("href").notNull(),
  highlight: boolean("highlight").notNull().default(false),
}).enableRLS();

/** Which feed items each staff member has read. */
export const staffEventReadsTable = pgTable("staff_event_reads", {
  staffId: uuid("staff_id").notNull().references(() => staffMembersTable.id),
  eventSeq: bigint("event_seq", { mode: "number" }).notNull().references(() => staffEventsTable.seq),
}, t => [primaryKey({ columns: [t.staffId, t.eventSeq] })]).enableRLS();

export type AuditChangeJson = { field: string; before: string; after: string };

/**
 * Append-only audit log of staff actions. The API never updates or deletes a
 * row. Each row's `hash` covers its content and the previous row's hash, so any
 * edit, deletion, or reordering breaks the chain, which the API can verify.
 */
export const auditEventsTable = pgTable("audit_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  staffId: text("staff_id").notNull(),
  staffName: text("staff_name").notNull(),
  role: text("role").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  applicantId: text("applicant_id"),
  summary: text("summary").notNull(),
  changes: jsonb("changes").$type<AuditChangeJson[]>().notNull(),
  riskScore: integer("risk_score"),
  ip: text("ip"),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
}).enableRLS();

export type NotificationRow = typeof notificationsTable.$inferSelect;
export type StaffEventRow = typeof staffEventsTable.$inferSelect;
export type AuditEventRow = typeof auditEventsTable.$inferSelect;
