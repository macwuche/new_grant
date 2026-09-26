import { randomUUID } from "node:crypto";

// The team mailbox: mail received through the Resend webhook and mail staff
// send from the inbox. Drizzle version: ./inbox.db.ts.

export type InboxFolder = "inbox" | "sent" | "archive" | "trash";
export type InboxMessage = {
  id: string; direction: "inbound" | "outbound"; resendId: string | null; messageId: string | null; inReplyTo: string | null;
  from: string; to: string[]; cc: string[]; subject: string; text: string | null; html: string | null;
  attachments: { id: string; filename: string; contentType: string; size: number | null }[];
  status: string | null; folder: InboxFolder; read: boolean; sentBy: string | null; at: string;
};
export type NewInboxMessage = Omit<InboxMessage, "id" | "read"> & { read?: boolean };

export interface InboxRepo {
  list(folder: InboxFolder): Promise<InboxMessage[]>;
  get(id: string): Promise<InboxMessage | null>;
  /** Stores a received message once per Resend id; returns null if it was already stored. */
  addInbound(msg: NewInboxMessage): Promise<InboxMessage | null>;
  addOutbound(msg: NewInboxMessage): Promise<InboxMessage>;
  update(id: string, patch: Partial<Pick<InboxMessage, "folder" | "read">>): Promise<InboxMessage | null>;
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
    list: async folder => rows.filter(m => m.folder === folder).sort((a, b) => b.at.localeCompare(a.at)).slice(0, INBOX_LIMIT).map(copy),
    get: async id => { const m = rows.find(r => r.id === id); return m ? copy(m) : null; },
    addInbound: async msg => {
      if (msg.resendId && rows.some(r => r.direction === "inbound" && r.resendId === msg.resendId)) return null;
      const row: InboxMessage = { ...msg, id: randomUUID(), read: msg.read ?? false };
      rows.push(row); return copy(row);
    },
    addOutbound: async msg => { const row: InboxMessage = { ...msg, id: randomUUID(), read: true }; rows.push(row); return copy(row); },
    update: async (id, patch) => { if (!isUuid(id)) return null; const m = rows.find(r => r.id === id); if (!m) return null; Object.assign(m, patch); return copy(m); },
    setStatusByResendId: async (resendId, status) => { for (const m of rows) if (m.direction === "outbound" && m.resendId === resendId) m.status = status; },
    unreadCount: async () => rows.filter(m => m.folder === "inbox" && !m.read).length,
  };
}
