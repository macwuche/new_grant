import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Email settings a super admin manages in the app, and the team mailbox.
// Secrets (Resend API key, webhook signing secret, Supabase access token) are
// stored encrypted with a key that lives only on the API server (see
// artifacts/api-server/src/lib/secrets.ts). Row-level security is on with no
// policies (see ./staff.ts).

/** One row, id "email". Unset fields fall back to the server's environment variables. */
export const emailSettingsTable = pgTable("email_settings", {
  id: text("id").primaryKey(),
  resendKeyEnc: text("resend_key_enc"),
  resendKeyLast4: text("resend_key_last4"),
  fromAddress: text("from_address"),
  replyTo: text("reply_to"),
  appUrl: text("app_url"),
  /** The team mailbox address shown in the inbox (mail to it arrives through the webhook). */
  inboxAddress: text("inbox_address"),
  domainName: text("domain_name"),
  domainId: text("domain_id"),
  webhookSecretEnc: text("webhook_secret_enc"),
  supabaseTokenEnc: text("supabase_token_enc"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
}).enableRLS();

export type InboxAttachmentJson = { id: string; filename: string; contentType: string; size: number | null };

/** Messages in the team mailbox: received through the Resend webhook, or sent from the inbox. */
export const inboxMessagesTable = pgTable("inbox_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  direction: text("direction").$type<"inbound" | "outbound">().notNull(),
  /** Resend's id: the received email's id, or the sent email's id. Unique per direction. */
  resendId: text("resend_id"),
  messageId: text("message_id"),
  inReplyTo: uuid("in_reply_to"),
  fromAddress: text("from_address").notNull(),
  toAddresses: jsonb("to_addresses").$type<string[]>().notNull(),
  ccAddresses: jsonb("cc_addresses").$type<string[]>().notNull().default([]),
  subject: text("subject").notNull(),
  textBody: text("text_body"),
  htmlBody: text("html_body"),
  attachments: jsonb("attachments").$type<InboxAttachmentJson[]>().notNull().default([]),
  /** Outbound: sent, delivered, bounced, complained, delayed, failed. */
  status: text("status"),
  folder: text("folder").$type<"inbox" | "sent" | "archive" | "trash">().notNull(),
  read: boolean("read").notNull().default(false),
  sentBy: text("sent_by"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("inbox_messages_folder_idx").on(t.folder, t.at), uniqueIndex("inbox_messages_resend_uq").on(t.direction, t.resendId)]).enableRLS();

export type InboxMessageRow = typeof inboxMessagesTable.$inferSelect;
