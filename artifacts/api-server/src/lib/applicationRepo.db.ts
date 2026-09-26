import { and, desc, eq, ne, sql } from "drizzle-orm";
import { applicationNumberSeq, applicationsTable, db, programsTable, type ApplicationRow } from "@workspace/db";
import type { Application } from "@workspace/domain/model";
import type { ApplicationRepo } from "./applicationRepo";
import { toGrant, toProgramRow } from "./programRepo.db";

// jsonb doesn't keep object key order; rebuild nested objects in the domain's order.
const toApplication = (r: ApplicationRow): Application => ({
  id: r.id, applicantId: r.applicantId, grantId: r.grantId, status: r.status,
  businessName: r.businessName, requestedAmount: r.requestedAmount, registrationNumber: r.registrationNumber, purpose: r.purpose,
  checklist: r.checklist, answers: r.answers,
  createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), submittedAt: r.submittedAt?.toISOString() ?? null,
  reviewer: r.reviewer, awardedAmount: r.awardedAmount,
  history: r.history.map(h => ({ status: h.status, at: h.at, actor: h.actor, note: h.note })),
  internalNotes: r.internalNotes.map(n => ({ at: n.at, author: n.author, text: n.text })),
  escalation: r.escalation ? {
    at: r.escalation.at, by: r.escalation.by, reason: r.escalation.reason, status: r.escalation.status,
    ...(r.escalation.clearedAt ? { clearedAt: r.escalation.clearedAt } : {}),
    ...(r.escalation.clearedBy ? { clearedBy: r.escalation.clearedBy } : {}),
    ...(r.escalation.resolution ? { resolution: r.escalation.resolution } : {}),
  } : null,
});

const toRow = (a: Application) => ({
  id: a.id, applicantId: a.applicantId, grantId: a.grantId, status: a.status,
  businessName: a.businessName, requestedAmount: a.requestedAmount, registrationNumber: a.registrationNumber, purpose: a.purpose,
  checklist: a.checklist, answers: a.answers,
  createdAt: new Date(a.createdAt), updatedAt: new Date(a.updatedAt), submittedAt: a.submittedAt ? new Date(a.submittedAt) : null,
  reviewer: a.reviewer, awardedAmount: a.awardedAmount, history: a.history, internalNotes: a.internalNotes, escalation: a.escalation,
});

const programAtVersion = (id: string, version: string) =>
  and(eq(programsTable.id, id), sql`date_trunc('milliseconds', ${programsTable.updatedAt}) = ${new Date(version)}`);

const isUniqueViolation = (err: unknown) => [(err as { code?: string }).code, (err as { cause?: { code?: string } }).cause?.code].includes("23505");

export const dbApplicationRepo: ApplicationRepo = {
  withProgram: (grantId, fn) => db.transaction(async tx => {
    // Serializes every change to this program and its applications until the transaction ends.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`program:${grantId}`}))`);
    const grants = (await tx.select().from(programsTable).orderBy(programsTable.createdAt, programsTable.id)).map(toGrant);
    const applications = (await tx.select().from(applicationsTable).where(eq(applicationsTable.grantId, grantId))).map(toApplication);
    return fn({
      grants, applications,
      saveApplication: async app => {
        const row = toRow(app);
        await tx.insert(applicationsTable).values(row).onConflictDoUpdate({ target: applicationsTable.id, set: row });
      },
      removeApplication: async id => { await tx.delete(applicationsTable).where(eq(applicationsTable.id, id)); },
      saveGrant: async (grant, version) => {
        try {
          const updated = await tx.update(programsTable).set(toProgramRow(grant)).where(programAtVersion(grant.id, version)).returning({ id: programsTable.id });
          return updated.length ? "ok" : "stale";
        } catch (err) { if (isUniqueViolation(err)) return "duplicate-name"; throw err; }
      },
      removeGrant: async (id, version) => {
        const removed = await tx.delete(programsTable).where(programAtVersion(id, version)).returning({ id: programsTable.id });
        return removed.length ? "ok" : "stale";
      },
    });
  }),
  get: async id => { const [row] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, id)); return row ? toApplication(row) : null; },
  listForApplicant: async applicantId => (await db.select().from(applicationsTable).where(eq(applicationsTable.applicantId, applicantId)).orderBy(desc(applicationsTable.createdAt))).map(toApplication),
  listSubmitted: async () => (await db.select().from(applicationsTable).where(ne(applicationsTable.status, "Draft")).orderBy(applicationsTable.submittedAt)).map(toApplication),
  nextNumber: async () => {
    const { rows } = await db.execute<{ n: string }>(sql`select nextval(${applicationNumberSeq.seqName}) as n`);
    return Number(rows[0]!.n);
  },
};
