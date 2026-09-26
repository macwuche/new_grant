import { and, count, desc, eq } from "drizzle-orm";
import { db, inboxMessagesTable, type InboxMessageRow } from "@workspace/db";
import { INBOX_LIMIT, type InboxMessage, type InboxRepo } from "./inbox";

const toMessage = (r: InboxMessageRow): InboxMessage => ({
  id: r.id, direction: r.direction, resendId: r.resendId, messageId: r.messageId, inReplyTo: r.inReplyTo,
  from: r.fromAddress, to: r.toAddresses, cc: r.ccAddresses, subject: r.subject, text: r.textBody, html: r.htmlBody,
  attachments: r.attachments.map(a => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size })),
  status: r.status, folder: r.folder, read: r.read, sentBy: r.sentBy, at: r.at.toISOString(),
});

const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

const values = (m: Omit<InboxMessage, "id">) => ({
  direction: m.direction, resendId: m.resendId, messageId: m.messageId, inReplyTo: m.inReplyTo, fromAddress: m.from, toAddresses: m.to,
  ccAddresses: m.cc, subject: m.subject, textBody: m.text, htmlBody: m.html, attachments: m.attachments, status: m.status,
  folder: m.folder, read: m.read, sentBy: m.sentBy, at: new Date(m.at),
});

export const dbInboxRepo: InboxRepo = {
  list: async folder => (await db.select().from(inboxMessagesTable).where(eq(inboxMessagesTable.folder, folder))
    .orderBy(desc(inboxMessagesTable.at)).limit(INBOX_LIMIT)).map(toMessage),
  get: async id => {
    if (!isUuid(id)) return null;
    const [r] = await db.select().from(inboxMessagesTable).where(eq(inboxMessagesTable.id, id));
    return r ? toMessage(r) : null;
  },
  // Resend may deliver the same webhook more than once: the unique (direction, resend id) index keeps one copy.
  addInbound: async msg => {
    const [r] = await db.insert(inboxMessagesTable).values(values({ ...msg, read: msg.read ?? false })).onConflictDoNothing().returning();
    return r ? toMessage(r) : null;
  },
  addOutbound: async msg => { const [r] = await db.insert(inboxMessagesTable).values(values({ ...msg, read: true })).returning(); return toMessage(r!); },
  update: async (id, patch) => {
    if (!isUuid(id)) return null;
    const [r] = await db.update(inboxMessagesTable).set(patch).where(eq(inboxMessagesTable.id, id)).returning();
    return r ? toMessage(r) : null;
  },
  setStatusByResendId: async (resendId, status) => {
    await db.update(inboxMessagesTable).set({ status }).where(and(eq(inboxMessagesTable.direction, "outbound"), eq(inboxMessagesTable.resendId, resendId)));
  },
  unreadCount: async () => (await db.select({ n: count() }).from(inboxMessagesTable).where(and(eq(inboxMessagesTable.folder, "inbox"), eq(inboxMessagesTable.read, false))))[0]?.n ?? 0,
};
