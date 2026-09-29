import { boolean, index, jsonb, numeric, pgSequence, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { applicantProfilesTable } from "./applicants";

// Money: the ledger, and the system-wide money settings and lockdown. Mirrors
// `Transaction`, `Treasury`, and `Lockdown` in @workspace/domain; the rules in
// @workspace/domain/{money,deposits,payouts,treasury,security} decide every
// change. No payment provider is connected: "paid" and "received" record what
// finance says happened. Balances are always derived from the ledger, never
// stored. Row-level security is on with no policies (see ./staff.ts).

export type ReleaseApprovalJson = { by: string; byId?: string; at: string };

export const ledgerEntriesTable = pgTable("ledger_entries", {
  id: text("id").primaryKey(),
  applicantId: uuid("applicant_id").notNull().references(() => applicantProfilesTable.authUserId),
  type: text("type").$type<"Grant" | "Deposit" | "Withdrawal" | "Card fee" | "Application fee" | "Card top-up" | "Card deduction" | "Grant adjustment" | "Deposit adjustment">().notNull(),
  description: text("description").notNull(),
  /** Signed: credits positive, debits negative. */
  amount: numeric("amount", { precision: 12, scale: 2, mode: "number" }).notNull(),
  status: text("status").$type<"Completed" | "Pending" | "Failed" | "Cancelled">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  method: text("method"),
  fee: numeric("fee", { precision: 12, scale: 2, mode: "number" }),
  destination: text("destination"),
  reference: text("reference").unique(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  processedBy: text("processed_by"),
  failureReason: text("failure_reason"),
  dualControl: boolean("dual_control"),
  releaseApproval: jsonb("release_approval").$type<ReleaseApprovalJson | null>(),
  /** Card top-ups and deductions: the other balance moved (deposit, grant), or none. */
  counterpart: text("counterpart").$type<"deposit" | "grant" | "none">(),
  /** Staff card moves and balance adjustments: the reason shown to the applicant. */
  note: text("note"),
  /** Staff balance adjustments: why (Grant adjustment, Deposit manual override, Card fee refund, Correction, Fraud freeze). */
  category: text("category").$type<"Grant adjustment" | "Deposit manual override" | "Card fee refund" | "Correction" | "Fraud freeze">(),
}, t => [index("ledger_applicant_idx").on(t.applicantId), index("ledger_type_status_idx").on(t.type, t.status)]).enableRLS();

/**
 * Numbers for ledger ids and deposit references. Each request takes one value
 * and may use the next nine, so the sequence advances in blocks of ten.
 */
export const ledgerNumberSeq = pgSequence("ledger_number_seq", { startWith: 100000, increment: 10 });

export type TreasuryJson = {
  channels: { id: "bank" | "wire" | "mobile" | "crypto"; name: string; enabled: boolean; min: number; max: number; feeRate: number; feeFixed: number; feeCap: number }[];
  physicalCardFee: number; cardDeliveryFee: number; minDeposit: number; maxDeposit: number; depositThreshold: number;
  highValueDeposit: number; dualControlThreshold: number; applicationFee: number;
  updatedAt: string; changeLog: { at: string; by: string; summary: string }[];
};
export type LockdownJson = { since: string; by: string; reason: string };

/** One row (id 1): the money settings finance manages and the emergency lockdown. */
export const systemSettingsTable = pgTable("system_settings", {
  id: smallint("id").primaryKey(),
  treasury: jsonb("treasury").$type<TreasuryJson>().notNull(),
  lockdown: jsonb("lockdown").$type<LockdownJson | null>(),
}).enableRLS();

export type LedgerRow = typeof ledgerEntriesTable.$inferSelect;
