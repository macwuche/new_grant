import { boolean, index, jsonb, numeric, pgSequence, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { applicantProfilesTable } from "./applicants";

// Money: the ledger, and the system-wide money settings and lockdown. Mirrors
// `Transaction`, `Treasury`, and `Lockdown` in @workspace/domain; the rules in
// @workspace/domain/{money,deposits,payouts,treasury,security} decide every
// change. No payment provider is connected: "paid" and "received" record what
// finance says happened. Balances are always derived from the ledger, never
// stored. Row-level security is on with no policies (see ./staff.ts).

export type ReleaseApprovalJson = { by: string; byId?: string; at: string };
export type PayoutDetailJson = { fieldId: string; label: string; value: string };

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
  /** Withdrawals: the balance the money comes from (null on older rows: the grant balance). */
  source: text("source").$type<"grant" | "deposit">(),
  /** Withdrawals: the method's form as the applicant filled it in (full values; finance pays from them). */
  payoutDetails: jsonb("payout_details").$type<PayoutDetailJson[]>(),
}, t => [index("ledger_applicant_idx").on(t.applicantId), index("ledger_type_status_idx").on(t.type, t.status)]).enableRLS();

/**
 * Numbers for ledger ids and deposit references. Each request takes one value
 * and may use the next nine, so the sequence advances in blocks of ten.
 */
export const ledgerNumberSeq = pgSequence("ledger_number_seq", { startWith: 100000, increment: 10 });

/** A withdrawal method as stored. Rows saved before 29 Sep 2026 have only the first eight keys; the API fills in the rest. */
export type WithdrawalMethodJson = {
  id: string; name: string; enabled: boolean; min: number; max: number; feeRate: number; feeFixed: number; feeCap: number;
  processingTime?: string; instructions?: string; photoUrl?: string; photoFile?: { key: string; contentType: string; sha256: string };
  source?: "grant" | "deposit" | "both"; formTitle?: string;
  fields?: { id: string; label: string; type: "text" | "textarea" | "email" | "number" | "select"; required: boolean; placeholder: string; help: string; options: string[] }[];
};

export type TreasuryJson = {
  channels: WithdrawalMethodJson[];
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
