import { bigserial, index, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Outgoing email. Rows are written in the same transaction as the change that
// causes them (a notification, a staff invitation), and a worker in the API
// server sends them through Resend, retrying with backoff. Each row is sent
// with the idempotency key `email-<seq>`, so a retry after a crash never
// delivers the same message twice. Row-level security is on with no policies
// (see ./staff.ts).

export const emailStatusEnum = pgEnum("email_status", ["queued", "sending", "sent", "failed", "skipped"]);

export const emailOutboxTable = pgTable("email_outbox", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  kind: text("kind").$type<"notification" | "staff-invite">().notNull(),
  toAddress: text("to_address").notNull(),
  subject: text("subject").notNull(),
  textBody: text("text_body").notNull(),
  htmlBody: text("html_body").notNull(),
  status: emailStatusEnum("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  /** When the worker may next try (queued), or when a claim expires (sending). */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  providerId: text("provider_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** What Resend reported after sending (webhook): delivered, bounced, complained, delayed. */
  delivery: text("delivery"),
}, t => [index("email_outbox_due_idx").on(t.status, t.nextAttemptAt)]).enableRLS();

export type EmailOutboxRow = typeof emailOutboxTable.$inferSelect;
