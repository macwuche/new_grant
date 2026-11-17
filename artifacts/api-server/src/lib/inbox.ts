import { randomUUID } from "node:crypto";

// The team mailbox: mail received through the Resend webhook and mail staff
// send from the inbox. Drizzle version: ./inbox.db.ts.

/** `drafts`: unsent mail, each seen only by the staff member writing it (its `sentBy` holds their staff id). */
export type InboxFolder = "inbox" | "sent" | "archive" | "trash" | "drafts";
export type InboxMessage = {
  id: string; direction: "inbound" | "outbound"; resendId: string | null; messageId: string | null; inReplyTo: string | null;
  from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string | null; html: string | null;
  /** `key` and `sha256` only on files attached from the inbox (sent mail and drafts), which are on the API server's disk; received ones stay at Resend. */
  attachments: InboxAttachment[];
  status: string | null; folder: InboxFolder; read: boolean; sentBy: string | null; at: string;
};
export type InboxAttachment = { id: string; filename: string; contentType: string; size: number | null; key?: string; sha256?: string };
export type NewInboxMessage = Omit<InboxMessage, "id" | "read"> & { read?: boolean };

export interface InboxRepo {
  /** `sentBy`: only messages with that author (drafts are listed per person). */
  list(folder: InboxFolder, sentBy?: string): Promise<InboxMessage[]>;
  get(id: string): Promise<InboxMessage | null>;
  /** Stores a received message once per Resend id; returns null if it was already stored. */
  addInbound(msg: NewInboxMessage): Promise<InboxMessage | null>;
  /** Stores a sent message; a retry of a send Resend already accepted (same Resend id) returns the stored copy. */
  addOutbound(msg: NewInboxMessage): Promise<InboxMessage>;
  update(id: string, patch: Partial<Pick<InboxMessage, "folder" | "read">>): Promise<InboxMessage | null>;
  /** Stores a new draft (no `id`) or replaces one; null if the draft is gone. */
  saveDraft(msg: NewInboxMessage, id?: string): Promise<InboxMessage | null>;
  /** Deletes a draft for good (other folders keep their mail); false if it wasn't there. */
  removeDraft(id: string): Promise<boolean>;
  /** Delivery results for sent mail, by Resend id. */
  setStatusByResendId(resendId: string, status: string): Promise<void>;
  unreadCount(): Promise<number>;
}

export const INBOX_LIMIT = 200;
const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export function memoryInboxRepo(): InboxRepo & { rows: InboxMessage[] } {
  const rows: InboxMessage[] = [];
  const copy = (m: InboxMessage) => structuredClone(m);
  return {
    rows,
    list: async (folder, sentBy) => rows.filter(m => m.folder === folder && (sentBy === undefined || m.sentBy === sentBy)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, INBOX_LIMIT).map(copy),
    get: async id => { const m = rows.find(r => r.id === id); return m ? copy(m) : null; },
    addInbound: async msg => {
      if (msg.resendId && rows.some(r => r.direction === "inbound" && r.resendId === msg.resendId)) return null;
      const row: InboxMessage = { ...msg, id: randomUUID(), read: msg.read ?? false };
      rows.push(row); return copy(row);
    },
    addOutbound: async msg => {
      const existing = msg.resendId ? rows.find(r => r.direction === "outbound" && r.resendId === msg.resendId) : undefined;
      if (existing) return copy(existing);
      const row: InboxMessage = { ...msg, id: randomUUID(), read: true }; rows.push(row); return copy(row);
    },
    update: async (id, patch) => { if (!isUuid(id)) return null; const m = rows.find(r => r.id === id); if (!m) return null; Object.assign(m, patch); return copy(m); },
    saveDraft: async (msg, id) => {
      if (id === undefined) { const row: InboxMessage = { ...msg, id: randomUUID(), read: true }; rows.push(row); return copy(row); }
      const m = rows.find(r => r.id === id && r.folder === "drafts"); if (!m) return null;
      Object.assign(m, msg, { read: true }); return copy(m);
    },
    removeDraft: async id => { const i = rows.findIndex(r => r.id === id && r.folder === "drafts"); if (i < 0) return false; rows.splice(i, 1); return true; },
    setStatusByResendId: async (resendId, status) => { for (const m of rows) if (m.direction === "outbound" && m.resendId === resendId) m.status = status; },
    unreadCount: async () => rows.filter(m => m.folder === "inbox" && !m.read).length,
  };
}
