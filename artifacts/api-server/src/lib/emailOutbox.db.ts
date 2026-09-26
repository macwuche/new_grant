import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db, emailOutboxTable } from "@workspace/db";
import type { EmailOutbox, OutboxStatus } from "./email";

/** How long a claimed email stays with one worker before another may retry it. */
const CLAIM_MINUTES = 5;

export const dbEmailOutbox: EmailOutbox = {
  // SKIP LOCKED lets several API instances share the outbox without sending the same row twice.
  claim: async (limit, now) => {
    const due = or(eq(emailOutboxTable.status, "queued"), eq(emailOutboxTable.status, "sending"));
    return db.transaction(async tx => {
      const rows = await tx.select({ seq: emailOutboxTable.seq }).from(emailOutboxTable)
        .where(and(due, lte(emailOutboxTable.nextAttemptAt, now))).orderBy(emailOutboxTable.seq).limit(limit).for("update", { skipLocked: true });
      if (!rows.length) return [];
      const claimed = await tx.update(emailOutboxTable)
        .set({ status: "sending", attempts: sql`${emailOutboxTable.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + CLAIM_MINUTES * 60_000) })
        .where(inArray(emailOutboxTable.seq, rows.map(r => r.seq))).returning();
      return claimed.sort((a, b) => a.seq - b.seq).map(r => ({ seq: r.seq, kind: r.kind, to: r.toAddress, subject: r.subject, text: r.textBody, html: r.htmlBody, attempts: r.attempts }));
    });
  },
  markSent: async (seq, providerId, now) => {
    await db.update(emailOutboxTable).set({ status: "sent", providerId, sentAt: now, lastError: null }).where(eq(emailOutboxTable.seq, seq));
  },
  markFailed: async (seq, error, retryAt) => {
    await db.update(emailOutboxTable).set(retryAt ? { status: "queued", lastError: error, nextAttemptAt: retryAt } : { status: "failed", lastError: error }).where(eq(emailOutboxTable.seq, seq));
  },
  recordDelivery: async (providerId, delivery) => {
    await db.update(emailOutboxTable).set({ delivery }).where(eq(emailOutboxTable.providerId, providerId));
  },
  markSkipped: async (seq, reason) => {
    await db.update(emailOutboxTable).set({ status: "skipped", lastError: reason }).where(eq(emailOutboxTable.seq, seq));
  },
  summary: async recent => {
    const counts: Record<OutboxStatus, number> = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const row of await db.select({ status: emailOutboxTable.status, n: sql<number>`count(*)::int` }).from(emailOutboxTable).groupBy(emailOutboxTable.status)) counts[row.status] = row.n;
    const rows = await db.select().from(emailOutboxTable).orderBy(desc(emailOutboxTable.seq)).limit(recent);
    return {
      counts,
      recent: rows.map(r => ({ seq: r.seq, kind: r.kind, to: r.toAddress, subject: r.subject, status: r.status, attempts: r.attempts, lastError: r.lastError, createdAt: r.createdAt.toISOString(), sentAt: r.sentAt?.toISOString() ?? null })),
    };
  },
};
