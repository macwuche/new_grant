import { and, desc, eq, isNull } from "drizzle-orm";
import { db, documentsTable, type DocumentRow } from "@workspace/db";
import { withEffects } from "./activity.db";
import type { DocumentRecord, DocumentRepo } from "./documentRepo";

const toRecord = (r: DocumentRow): DocumentRecord => ({
  id: r.id, ownerId: r.ownerId, purpose: r.purpose, applicationId: r.applicationId, requirement: r.requirement,
  fileName: r.fileName, contentType: r.contentType, sizeBytes: r.sizeBytes, sha256: r.sha256, storageKey: r.storageKey,
  uploadedAt: r.uploadedAt.toISOString(), deletedAt: r.deletedAt?.toISOString() ?? null,
});

const live = isNull(documentsTable.deletedAt);

export const dbDocumentRepo: DocumentRepo = {
  insert: async doc => { const [row] = await db.insert(documentsTable).values(doc).returning(); return toRecord(row!); },
  get: async id => {
    // Ids are uuids; anything else can't exist (and would make Postgres throw).
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const [row] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    return row ? toRecord(row) : null;
  },
  listForOwner: async ownerId => (await db.select().from(documentsTable)
    .where(and(eq(documentsTable.ownerId, ownerId), live)).orderBy(desc(documentsTable.uploadedAt))).map(toRecord),
  listForApplication: async applicationId => (await db.select().from(documentsTable)
    .where(and(eq(documentsTable.applicationId, applicationId), live)).orderBy(desc(documentsTable.uploadedAt))).map(toRecord),
  markDeleted: async id => {
    const [row] = await db.update(documentsTable).set({ deletedAt: new Date() }).where(and(eq(documentsTable.id, id), live)).returning();
    return row ? toRecord(row) : null;
  },
  record: effects => withEffects(effects, async () => {}),
};
