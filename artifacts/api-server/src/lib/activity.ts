import { createHash } from "node:crypto";
import { SECURITY_NOTICE_TITLES } from "@workspace/domain/notifications";
import { recordAudit } from "@workspace/domain/audit";
import type { AuditChange, DemoState, StaffMember } from "@workspace/domain/model";
import { CURRENT_APPLICANT_ID } from "@workspace/domain/seed";
import { appUrl, notificationEmail, type NewEmail } from "./email";

// Notifications, staff activity items, and audit entries that accompany a
// change ("effects"). Rules create notifications and feed items as part of
// their result; the audit entry is built with the same `recordAudit` the
// browser uses. Repos write effects in the same transaction as the change.

/** `email: false`: in-app only, no email copy (e.g. a sign-in from a known device). */
export type NewNotification = { applicantId: string; at: string; title: string; body: string; href: string; email?: false };
export type NewStaffEvent = { at: string; kind: "application" | "deposit" | "withdrawal" | "card" | "security" | "account"; title: string; body: string; href: string; highlight: boolean };
export type NewAudit = {
  at: string; staffId: string; staffName: string; role: string; action: string; target: string;
  applicantId: string | null; summary: string; changes: AuditChange[]; riskScore: number | null; ip: string | null;
};
/** `emails`: messages besides notification copies (which are derived from `notifications` when stored). */
export type Effects = { notifications: NewNotification[]; staffEvents: NewStaffEvent[]; audit: NewAudit[]; emails?: NewEmail[] };

/** Who a notification's email copy goes to; null or opted out means no email. */
export type EmailRecipient = { email: string; name: string; emailNotifications: boolean };

/** The emails a change sends: a copy of each notification to applicants who want them (security notices always), plus any explicit emails. */
export function emailsFor(effects: Effects, recipient: (applicantId: string) => EmailRecipient | null | undefined, baseUrl = appUrl()): NewEmail[] {
  const copies = effects.notifications.flatMap(n => {
    const to = recipient(n.applicantId);
    return n.email !== false && to?.email && (to.emailNotifications || SECURITY_NOTICE_TITLES.has(n.title)) ? [notificationEmail(n, to, baseUrl)] : [];
  });
  return [...copies, ...(effects.emails ?? [])];
}

export const NO_EFFECTS: Effects = { notifications: [], staffEvents: [], audit: [] };

/** Who did a staff action and from where, for the audit entry. */
export type AuditContext = { actor: StaffMember; action: string; target: string; ip: string | null };

/**
 * The effects of one rule run: notifications and feed items it added, plus an
 * audit entry when a staff member acted. `slotId` is the real id of the
 * applicant who was in the rules' current-applicant slot, if any.
 */
export function effectsOf(before: DemoState, after: DemoState, now: Date, opts: { slotId?: string; audit?: AuditContext; summary?: string } = {}): Effects {
  const real = (id: string | null) => id === CURRENT_APPLICANT_ID && opts.slotId ? opts.slotId : id;
  const known = new Set(before.notifications.map(n => n.id));
  const knownFeed = new Set(before.staffFeed.map(e => e.id));
  const notifications = after.notifications.filter(n => !known.has(n.id))
    .map(n => ({ applicantId: real(n.applicantId)!, at: n.at, title: n.title, body: n.body, href: n.href }));
  const staffEvents = after.staffFeed.filter(e => !knownFeed.has(e.id))
    .map(e => ({ at: e.at, kind: e.kind, title: e.title, body: e.body, href: e.href, highlight: e.highlight }));
  const audit: NewAudit[] = [];
  if (opts.audit) {
    const { actor, action, target, ip } = opts.audit;
    const audited = recordAudit(before, after, actor, action, target, opts.summary ?? "", now);
    const e = audited.audit[audited.audit.length - 1]!;
    audit.push({
      at: e.at, staffId: e.staffId, staffName: e.staffName, role: e.role, action: e.action, target: real(e.target)!,
      applicantId: real(e.applicantId), summary: e.summary, changes: e.changes, riskScore: e.riskScore, ip,
    });
  }
  return { notifications, staffEvents, audit };
}

/** An audit entry for an action that doesn't run a rule (e.g. staff role changes). */
export function auditEntry(ctx: AuditContext, summary: string, changes: AuditChange[], now: Date): NewAudit {
  return { at: now.toISOString(), staffId: ctx.actor.id, staffName: ctx.actor.name, role: ctx.actor.role, action: ctx.action, target: ctx.target, applicantId: null, summary, changes, riskScore: null, ip: ctx.ip };
}

export const GENESIS_HASH = "0".repeat(64);

/** The chain hash of one audit entry: covers its content (in a fixed order) and the previous entry's hash. */
export function auditHash(prevHash: string, e: NewAudit): string {
  const content = [e.at, e.staffId, e.staffName, e.role, e.action, e.target, e.applicantId, e.summary, e.changes.map(c => [c.field, c.before, c.after]), e.riskScore, e.ip];
  return createHash("sha256").update(prevHash).update(JSON.stringify(content)).digest("hex");
}

// ---------- Reading ----------

export type NotificationRecord = { id: string; at: string; title: string; body: string; href: string; read: boolean };
export type StaffEventRecord = NewStaffEvent & { id: string; read: boolean };
export type AuditRecord = NewAudit & { id: string };
export type ChainCheck = { intact: boolean; checked: number; brokenAt?: string };

export interface ActivityRepo {
  notificationsFor(applicantId: string): Promise<NotificationRecord[]>;
  /** False if the notification isn't this applicant's. */
  markNotificationRead(applicantId: string, seq: number): Promise<boolean>;
  markAllNotificationsRead(applicantId: string): Promise<number>;
  staffEvents(staffId: string): Promise<StaffEventRecord[]>;
  markStaffEventRead(staffId: string, seq: number): Promise<boolean>;
  markAllStaffEventsRead(staffId: string): Promise<number>;
  /** Newest first. */
  audit(): Promise<AuditRecord[]>;
  verifyAudit(): Promise<ChainCheck>;
}

/** Walks entries oldest first and checks each link of the hash chain. */
export function checkChain(rows: { id: string; entry: NewAudit; prevHash: string; hash: string }[]): ChainCheck {
  let prev = GENESIS_HASH;
  for (const row of rows) {
    if (row.prevHash !== prev || auditHash(prev, row.entry) !== row.hash) return { intact: false, checked: rows.length, brokenAt: row.id };
    prev = row.hash;
  }
  return { intact: true, checked: rows.length };
}

export const LIST_LIMIT = 200;

/** In-memory activity store for tests: `write` is what memory repos call with their effects. */
export function memoryActivity(email?: { outbox: { enqueue(emails: NewEmail[]): void }; recipient: (applicantId: string) => EmailRecipient | null | undefined }): ActivityRepo & { write(effects: Effects): void; tamper(seq: number, summary: string): void } {
  const notifications: (NewNotification & { seq: number; read: boolean })[] = [];
  const events: (NewStaffEvent & { seq: number })[] = [];
  const reads = new Set<string>();
  const audit: { seq: number; entry: NewAudit; prevHash: string; hash: string }[] = [];
  let seq = 0;
  return {
    write: effects => {
      if (email) email.outbox.enqueue(emailsFor(effects, email.recipient, "https://app.example.org"));
      for (const { email: _email, ...n } of effects.notifications) notifications.push({ ...n, seq: ++seq, read: false });
      for (const e of effects.staffEvents) events.push({ ...e, seq: ++seq });
      for (const a of effects.audit) {
        const prevHash = audit.at(-1)?.hash ?? GENESIS_HASH;
        audit.push({ seq: ++seq, entry: structuredClone(a), prevHash, hash: auditHash(prevHash, a) });
      }
    },
    tamper: (s, summary) => { const row = audit.find(a => a.seq === s); if (row) row.entry.summary = summary; },
    notificationsFor: async id => notifications.filter(n => n.applicantId === id).reverse().slice(0, LIST_LIMIT)
      .map(n => ({ id: `NT-${n.seq}`, at: n.at, title: n.title, body: n.body, href: n.href, read: n.read })),
    markNotificationRead: async (id, s) => { const n = notifications.find(x => x.seq === s && x.applicantId === id); if (n) n.read = true; return !!n; },
    markAllNotificationsRead: async id => { let count = 0; for (const n of notifications) if (n.applicantId === id && !n.read) { n.read = true; count++; } return count; },
    staffEvents: async staffId => [...events].reverse().slice(0, LIST_LIMIT)
      .map(({ seq: s, ...e }) => ({ ...e, id: `FD-${s}`, read: reads.has(`${staffId}:${s}`) })),
    markStaffEventRead: async (staffId, s) => { if (!events.some(e => e.seq === s)) return false; reads.add(`${staffId}:${s}`); return true; },
    markAllStaffEventsRead: async staffId => { let count = 0; for (const e of events) { const k = `${staffId}:${e.seq}`; if (!reads.has(k)) { reads.add(k); count++; } } return count; },
    audit: async () => [...audit].reverse().map(a => ({ ...a.entry, id: `AU-${a.seq}` })),
    verifyAudit: async () => checkChain(audit.map(a => ({ id: `AU-${a.seq}`, entry: a.entry, prevHash: a.prevHash, hash: a.hash }))),
  };
}
