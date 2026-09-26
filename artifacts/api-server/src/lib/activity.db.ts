import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { applicantProfilesTable, auditEventsTable, db, emailOutboxTable, notificationsTable, staffEventReadsTable, staffEventsTable, type AuditEventRow } from "@workspace/db";
import { auditHash, checkChain, emailsFor, GENESIS_HASH, LIST_LIMIT, type ActivityRepo, type Effects, type NewAudit } from "./activity";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Writes a change's effects inside the caller's transaction. Audit entries are
 * appended under a global lock so each one links to the latest entry's hash.
 */
export async function writeEffects(tx: Tx, effects: Effects): Promise<void> {
  if (effects.notifications.length) {
    await tx.insert(notificationsTable).values(effects.notifications.map(({ email: _email, ...n }) => ({ ...n, at: new Date(n.at) })));
  }
  // Email copies of notifications (for applicants who want them) and explicit emails, queued for the worker.
  const ids = [...new Set(effects.notifications.map(n => n.applicantId))];
  const people = ids.length ? await tx.select({ id: applicantProfilesTable.authUserId, email: applicantProfilesTable.email, name: applicantProfilesTable.name, emailNotifications: applicantProfilesTable.emailNotifications })
    .from(applicantProfilesTable).where(inArray(applicantProfilesTable.authUserId, ids)) : [];
  const emails = emailsFor(effects, id => people.find(p => p.id === id));
  if (emails.length) {
    await tx.insert(emailOutboxTable).values(emails.map(e => ({ kind: e.kind, toAddress: e.to, subject: e.subject, textBody: e.text, htmlBody: e.html })));
  }
  if (effects.staffEvents.length) {
    await tx.insert(staffEventsTable).values(effects.staffEvents.map(e => ({ ...e, at: new Date(e.at) })));
  }
  if (effects.audit.length) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('audit-chain'))`);
    const [last] = await tx.select({ hash: auditEventsTable.hash }).from(auditEventsTable).orderBy(desc(auditEventsTable.seq)).limit(1);
    let prevHash = last?.hash ?? GENESIS_HASH;
    for (const entry of effects.audit) {
      const hash = auditHash(prevHash, entry);
      await tx.insert(auditEventsTable).values({ ...entry, at: new Date(entry.at), prevHash, hash });
      prevHash = hash;
    }
  }
}

/** Runs `write` with the effects in one transaction (for changes that aren't already in one). */
export const withEffects = <T>(effects: Effects, write: (tx: Tx) => Promise<T>): Promise<T> =>
  db.transaction(async tx => { const result = await write(tx); await writeEffects(tx, effects); return result; });

// jsonb doesn't keep key order; rebuild changes in the order the hash covers.
const toEntry = (r: AuditEventRow): NewAudit => ({
  at: r.at.toISOString(), staffId: r.staffId, staffName: r.staffName, role: r.role, action: r.action, target: r.target,
  applicantId: r.applicantId, summary: r.summary, changes: r.changes.map(c => ({ field: c.field, before: c.before, after: c.after })),
  riskScore: r.riskScore, ip: r.ip,
});

export const dbActivityRepo: ActivityRepo = {
  notificationsFor: async applicantId => (await db.select().from(notificationsTable)
    .where(eq(notificationsTable.applicantId, applicantId)).orderBy(desc(notificationsTable.seq)).limit(LIST_LIMIT))
    .map(n => ({ id: `NT-${n.seq}`, at: n.at.toISOString(), title: n.title, body: n.body, href: n.href, read: n.read })),
  markNotificationRead: async (applicantId, seq) => (await db.update(notificationsTable).set({ read: true })
    .where(and(eq(notificationsTable.seq, seq), eq(notificationsTable.applicantId, applicantId))).returning({ seq: notificationsTable.seq })).length > 0,
  markAllNotificationsRead: async applicantId => (await db.update(notificationsTable).set({ read: true })
    .where(and(eq(notificationsTable.applicantId, applicantId), eq(notificationsTable.read, false))).returning({ seq: notificationsTable.seq })).length,
  staffEvents: async staffId => (await db.select({ event: staffEventsTable, readBy: staffEventReadsTable.staffId }).from(staffEventsTable)
    .leftJoin(staffEventReadsTable, and(eq(staffEventReadsTable.eventSeq, staffEventsTable.seq), eq(staffEventReadsTable.staffId, staffId)))
    .orderBy(desc(staffEventsTable.seq)).limit(LIST_LIMIT))
    .map(({ event: { seq, at, ...e }, readBy }) => ({ ...e, id: `FD-${seq}`, at: at.toISOString(), read: readBy !== null })),
  markStaffEventRead: async (staffId, seq) => {
    const [event] = await db.select({ seq: staffEventsTable.seq }).from(staffEventsTable).where(eq(staffEventsTable.seq, seq));
    if (!event) return false;
    await db.insert(staffEventReadsTable).values({ staffId, eventSeq: seq }).onConflictDoNothing();
    return true;
  },
  markAllStaffEventsRead: async staffId => (await db.execute<{ n: number }>(sql`
    insert into ${staffEventReadsTable} (staff_id, event_seq)
    select ${staffId}, e.seq from ${staffEventsTable} e
    on conflict do nothing`)).rowCount ?? 0,
  audit: async () => (await db.select().from(auditEventsTable).orderBy(desc(auditEventsTable.seq)))
    .map(r => ({ ...toEntry(r), id: `AU-${r.seq}` })),
  verifyAudit: async () => checkChain((await db.select().from(auditEventsTable).orderBy(auditEventsTable.seq))
    .map(r => ({ id: `AU-${r.seq}`, entry: toEntry(r), prevHash: r.prevHash, hash: r.hash }))),
};
