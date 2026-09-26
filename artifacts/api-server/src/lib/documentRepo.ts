import { randomUUID } from "node:crypto";
import type { Effects } from "./activity";

// Records of uploaded documents (the files are in a FileStore, on the server's
// disk). Deleting marks the record deleted and keeps it; listings show only
// documents that still exist. Drizzle version: ./documentRepo.db.ts.

export type DocumentPurpose = "identity" | "application";

export type DocumentRecord = {
  id: string;
  ownerId: string;
  purpose: DocumentPurpose;
  applicationId: string | null;
  requirement: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  uploadedAt: string;
  deletedAt: string | null;
};

export type NewDocument = Omit<DocumentRecord, "id" | "uploadedAt" | "deletedAt">;

export interface DocumentRepo {
  insert(doc: NewDocument): Promise<DocumentRecord>;
  /** Deleted records too. */
  get(id: string): Promise<DocumentRecord | null>;
  /** The owner's documents that haven't been deleted, newest first. */
  listForOwner(ownerId: string): Promise<DocumentRecord[]>;
  /** An application's documents that haven't been deleted, newest first. */
  listForApplication(applicationId: string): Promise<DocumentRecord[]>;
  /** Marks the record deleted; null if it already was. */
  markDeleted(id: string): Promise<DocumentRecord | null>;
  /** Stores an audit entry (e.g. staff opening a document). */
  record(effects: Effects): Promise<void>;
}

const newestFirst = (a: DocumentRecord, b: DocumentRecord) => b.uploadedAt.localeCompare(a.uploadedAt);

/** In-memory repo for tests. */
export function memoryDocumentRepo(activity?: { write(effects: Effects): void }): DocumentRepo {
  const rows = new Map<string, DocumentRecord>();
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  const live = (pick: (d: DocumentRecord) => boolean) => [...rows.values()].filter(d => !d.deletedAt && pick(d)).sort(newestFirst).map(d => ({ ...d }));
  return {
    insert: async doc => {
      const row: DocumentRecord = { ...doc, id: randomUUID(), uploadedAt: new Date(tick += 1000).toISOString(), deletedAt: null };
      rows.set(row.id, row);
      return { ...row };
    },
    get: async id => { const row = rows.get(id); return row ? { ...row } : null; },
    listForOwner: async ownerId => live(d => d.ownerId === ownerId),
    listForApplication: async applicationId => live(d => d.applicationId === applicationId),
    markDeleted: async id => {
      const row = rows.get(id);
      if (!row || row.deletedAt) return null;
      row.deletedAt = new Date(tick += 1000).toISOString();
      return { ...row };
    },
    record: async effects => { activity?.write(effects); },
  };
}
