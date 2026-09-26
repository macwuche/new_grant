import { and, eq, sql } from "drizzle-orm";
import { db, programNumberSeq, programsTable, type ProgramRow } from "@workspace/db";
import type { Grant, Tier } from "@workspace/domain/model";
import type { ProgramRepo, WriteOutcome } from "./programRepo";

// jsonb doesn't keep object key order, and the rules compare questions as JSON
// text, so rebuild nested objects with the domain's key order.
const toGrant = (row: ProgramRow): Grant => ({
  id: row.id, status: row.status, name: row.name, summary: row.summary, focus: row.focus,
  maxFunding: row.maxFunding, minimumRequest: row.minimumRequest, budget: row.budget, deadline: row.deadline,
  minimumTier: row.minimumTier as Tier, requirements: row.requirements, requiresRegistration: row.requiresRegistration,
  questions: row.questions.map(q => ({ id: q.id, label: q.label, type: q.type, required: q.required })),
  changeLog: row.changeLog.map(c => ({ at: c.at, by: c.by, summary: c.summary })), updatedAt: row.updatedAt.toISOString(),
});

const toRow = (g: Grant) => ({
  status: g.status, name: g.name, summary: g.summary, focus: g.focus,
  maxFunding: g.maxFunding, minimumRequest: g.minimumRequest, budget: g.budget, deadline: g.deadline,
  minimumTier: g.minimumTier, requirements: g.requirements, requiresRegistration: g.requiresRegistration,
  questions: g.questions, changeLog: g.changeLog, updatedAt: new Date(g.updatedAt),
});

/** Maps the unique-name index violation to an outcome; rethrows anything else. */
async function write(run: () => Promise<number>): Promise<WriteOutcome> {
  try {
    return (await run()) ? "ok" : "stale";
  } catch (err) {
    if ((err as { code?: string; cause?: { code?: string } }).code === "23505" || (err as { cause?: { code?: string } }).cause?.code === "23505") return "duplicate-name";
    throw err;
  }
}

export const dbProgramRepo: ProgramRepo = {
  list: async () => (await db.select().from(programsTable).orderBy(programsTable.createdAt, programsTable.id)).map(toGrant),
  nextNumber: async () => {
    const { rows } = await db.execute<{ n: string }>(sql`select nextval(${programNumberSeq.seqName}) as n`);
    return Number(rows[0]!.n);
  },
  insert: grant => write(async () => (await db.insert(programsTable).values({ id: grant.id, ...toRow(grant) }).returning({ id: programsTable.id })).length),
  update: (grant, expectedVersion) => write(async () => (await db.update(programsTable).set(toRow(grant))
    .where(and(eq(programsTable.id, grant.id), eq(programsTable.updatedAt, new Date(expectedVersion)))).returning({ id: programsTable.id })).length),
  remove: (id, expectedVersion) => write(async () => (await db.delete(programsTable)
    .where(and(eq(programsTable.id, id), eq(programsTable.updatedAt, new Date(expectedVersion)))).returning({ id: programsTable.id })).length),
};
