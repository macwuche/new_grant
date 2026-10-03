import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { applicantProfilesTable, db, ledgerEntriesTable, ledgerNumberSeq, systemSettingsTable, type LedgerRow, type TreasuryJson } from "@workspace/db";
import type { Lockdown, SavedPayoutDetails, Transaction, Treasury } from "@workspace/domain/model";
import { builtinDepositMethods, normalizeDepositMethod } from "@workspace/domain/depositMethods";
import { normalizeMethod } from "@workspace/domain/withdrawalMethods";
import { seedTreasury } from "@workspace/domain/seed";
import { writeEffects } from "./activity.db";
import { newCards, type MoneyProfile, type MoneyRepo, type SystemSettings } from "./moneyRepo";
import { toRecord as toProfileRecord } from "./profileRepo.db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const SETTINGS_ID = 1;

// jsonb doesn't keep key order; rebuild settings in the domain's order. Methods saved before
// 29 Sep 2026 (fixed channels) get the method fields they lack (normalizeMethod). Settings saved
// before 30 Sep 2026 had one deposit minimum and maximum: they get the built-in deposit methods
// with those limits, and the deposit two-person threshold starts at the payout one. The application
// fee (removed 3 Oct 2026) is dropped from older rows.
const toTreasury = (t: TreasuryJson): Treasury => ({
  channels: t.channels.map(c => normalizeMethod(c as Parameters<typeof normalizeMethod>[0])),
  physicalCardFee: t.physicalCardFee, cardDeliveryFee: t.cardDeliveryFee,
  depositMethods: t.depositMethods ? t.depositMethods.map(normalizeDepositMethod) : builtinDepositMethods({ min: t.minDeposit ?? 20, max: t.maxDeposit ?? 25000 }),
  depositThreshold: t.depositThreshold, highValueDeposit: t.highValueDeposit, dualControlThreshold: t.dualControlThreshold,
  depositDualControlThreshold: t.depositDualControlThreshold ?? t.dualControlThreshold,
  updatedAt: t.updatedAt, changeLog: t.changeLog.map(c => ({ at: c.at, by: c.by, summary: c.summary })),
});
/** Remembered payout answers; older rows hold masked labels (strings), which can't pre-fill a form and are dropped. */
const toSavedDetails = (raw: Record<string, Record<string, string> | string>): SavedPayoutDetails =>
  Object.fromEntries(Object.entries(raw ?? {}).filter((e): e is [string, Record<string, string>] => !!e[1] && typeof e[1] === "object")
    .map(([method, answers]) => [method, Object.fromEntries(Object.entries(answers).filter(([, v]) => typeof v === "string"))]));
const toLockdown = (l: Lockdown | null): Lockdown | null => l ? { since: l.since, by: l.by, reason: l.reason } : null;

/** A ledger row as the domain's Transaction: optional fields are omitted, not null. */
export const toTransaction = (r: LedgerRow): Transaction => ({
  id: r.id, applicantId: r.applicantId, type: r.type, description: r.description, amount: r.amount, status: r.status,
  createdAt: r.createdAt.toISOString(),
  ...(r.method !== null ? { method: r.method } : {}),
  ...(r.fee !== null ? { fee: r.fee } : {}),
  ...(r.destination !== null ? { destination: r.destination } : {}),
  ...(r.reference !== null ? { reference: r.reference } : {}),
  ...(r.processedAt ? { processedAt: r.processedAt.toISOString() } : {}),
  ...(r.processedBy !== null ? { processedBy: r.processedBy } : {}),
  ...(r.failureReason !== null ? { failureReason: r.failureReason } : {}),
  ...(r.dualControl !== null ? { dualControl: r.dualControl } : {}),
  ...(r.releaseApproval ? { releaseApproval: { by: r.releaseApproval.by, at: r.releaseApproval.at, ...(r.releaseApproval.byId ? { byId: r.releaseApproval.byId } : {}) } } : {}),
  ...(r.counterpart !== null ? { counterpart: r.counterpart } : {}),
  ...(r.note !== null ? { note: r.note } : {}),
  ...(r.category !== null ? { category: r.category } : {}),
  ...(r.source !== null ? { source: r.source } : {}),
  ...(r.payoutDetails ? { payoutDetails: r.payoutDetails.map(d => ({ fieldId: d.fieldId, label: d.label, value: d.value })) } : {}),
  ...(r.payTo ? { payTo: r.payTo.map(d => ({ label: d.label, value: d.value })) } : {}),
  ...(r.depositDetails ? { depositDetails: r.depositDetails.map(d => ({ fieldId: d.fieldId, label: d.label, value: d.value })) } : {}),
  ...(r.proofRequired !== null ? { proofRequired: r.proofRequired } : {}),
  ...(r.proof?.length ? { proof: r.proof.map(p => ({ id: p.id, fileName: p.fileName, contentType: p.contentType, sizeBytes: p.sizeBytes, sha256: p.sha256, uploadedAt: p.uploadedAt })) } : {}),
});

const toRow = (t: Transaction) => ({
  id: t.id, applicantId: t.applicantId, type: t.type, description: t.description, amount: t.amount, status: t.status,
  createdAt: new Date(t.createdAt), method: t.method ?? null, fee: t.fee ?? null, destination: t.destination ?? null,
  reference: t.reference ?? null, processedAt: t.processedAt ? new Date(t.processedAt) : null, processedBy: t.processedBy ?? null,
  failureReason: t.failureReason ?? null, dualControl: t.dualControl ?? null, releaseApproval: t.releaseApproval ?? null,
  counterpart: t.counterpart ?? null, note: t.note ?? null, category: t.category ?? null,
  source: t.source ?? null, payoutDetails: t.payoutDetails ?? null,
  payTo: t.payTo ?? null, depositDetails: t.depositDetails ?? null, proofRequired: t.proofRequired ?? null,
  // Preview-mode data: URLs never reach the server; only the file's record is stored.
  proof: t.proof?.length ? t.proof.map(({ previewUrl: _preview, ...p }) => p) : null,
});

export async function saveTransaction(tx: Tx, t: Transaction) {
  const row = toRow(t);
  await tx.insert(ledgerEntriesTable).values(row).onConflictDoUpdate({ target: ledgerEntriesTable.id, set: row });
}

async function readSettings(tx: Tx | typeof db): Promise<SystemSettings> {
  const [row] = await tx.select().from(systemSettingsTable).where(eq(systemSettingsTable.id, SETTINGS_ID));
  if (!row) throw new Error("system_settings row missing; ensureSettings() runs at startup");
  return { treasury: toTreasury(row.treasury), lockdown: toLockdown(row.lockdown) };
}

/** Holds the applicant's lock (and the system lock shared) for the rest of the transaction. */
export async function lockApplicant(tx: Tx, applicantId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext('system'))`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`applicant:${applicantId}`}))`);
}

/** The applicant's ledger, read inside the caller's transaction. */
export async function ledgerIn(tx: Tx, applicantId: string): Promise<Transaction[]> {
  return (await tx.select().from(ledgerEntriesTable).where(eq(ledgerEntriesTable.applicantId, applicantId))).map(toTransaction);
}

export { readSettings as settingsIn };

/** Creates the settings row from the default money settings if it doesn't exist yet. */
export async function ensureSettings(): Promise<boolean> {
  const inserted = await db.insert(systemSettingsTable).values({ id: SETTINGS_ID, treasury: seedTreasury(), lockdown: null }).onConflictDoNothing().returning();
  return inserted.length > 0;
}

export const dbMoneyRepo: MoneyRepo = {
  settings: () => readSettings(db),
  withApplicant: (applicantId, fn) => db.transaction(async tx => {
    await lockApplicant(tx, applicantId);
    const [row] = await tx.select().from(applicantProfilesTable).where(eq(applicantProfilesTable.authUserId, applicantId));
    if (!row) throw new Error("no such applicant");
    let cards = row.cards;
    if (!cards) {
      cards = newCards();
      await tx.update(applicantProfilesTable).set({ cards }).where(eq(applicantProfilesTable.authUserId, applicantId));
    }
    const money: MoneyProfile = { cards, savedPayoutDetails: toSavedDetails(row.payoutDestinations), ...(row.destinationChangedAt ? { destinationChangedAt: row.destinationChangedAt.toISOString() } : {}) };
    return fn({
      ...(await readSettings(tx)), applicant: toProfileRecord(row), money, transactions: await ledgerIn(tx, applicantId),
      saveTransaction: t => saveTransaction(tx, t),
      saveMoney: async m => {
        await tx.update(applicantProfilesTable).set({
          cards: m.cards, payoutDestinations: m.savedPayoutDetails, destinationChangedAt: m.destinationChangedAt ? new Date(m.destinationChangedAt) : null,
        }).where(eq(applicantProfilesTable.authUserId, applicantId));
      },
      record: effects => writeEffects(tx, effects),
    });
  }),
  withSystem: fn => db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('system'))`);
    const pending = await tx.select().from(ledgerEntriesTable)
      .where(and(eq(ledgerEntriesTable.type, "Withdrawal"), eq(ledgerEntriesTable.status, "Pending")));
    return fn({
      ...(await readSettings(tx)), pendingWithdrawals: pending.map(toTransaction),
      saveTreasury: async treasury => { await tx.update(systemSettingsTable).set({ treasury }).where(eq(systemSettingsTable.id, SETTINGS_ID)); },
      saveLockdown: async lockdown => { await tx.update(systemSettingsTable).set({ lockdown }).where(eq(systemSettingsTable.id, SETTINGS_ID)); },
      record: effects => writeEffects(tx, effects),
    });
  }),
  ledgerFor: async applicantId => (await db.select().from(ledgerEntriesTable).where(eq(ledgerEntriesTable.applicantId, applicantId)).orderBy(desc(ledgerEntriesTable.createdAt))).map(toTransaction),
  ledger: async () => (await db.select().from(ledgerEntriesTable).orderBy(desc(ledgerEntriesTable.createdAt))).map(toTransaction),
  moneyProfile: async applicantId => {
    const [row] = await db.select({ cards: applicantProfilesTable.cards, payoutDestinations: applicantProfilesTable.payoutDestinations, destinationChangedAt: applicantProfilesTable.destinationChangedAt })
      .from(applicantProfilesTable).where(eq(applicantProfilesTable.authUserId, applicantId));
    if (!row?.cards) return null;
    return { cards: row.cards, savedPayoutDetails: toSavedDetails(row.payoutDestinations), ...(row.destinationChangedAt ? { destinationChangedAt: row.destinationChangedAt.toISOString() } : {}) };
  },
  findTransaction: async id => { const [row] = await db.select().from(ledgerEntriesTable).where(eq(ledgerEntriesTable.id, id)); return row ? toTransaction(row) : null; },
  cardHolders: async () => {
    const rows = await db.select({ applicantId: applicantProfilesTable.authUserId, name: applicantProfilesTable.name, email: applicantProfilesTable.email, cards: applicantProfilesTable.cards, funding: applicantProfilesTable.cardFunding, kycRequired: applicantProfilesTable.cardKycRequired })
      .from(applicantProfilesTable).where(isNotNull(applicantProfilesTable.cards));
    return rows.map(r => ({ applicantId: r.applicantId, name: r.name, email: r.email, cards: r.cards!, settings: { funding: r.funding, kycRequired: r.kycRequired } }));
  },
  nextBlock: async () => {
    const { rows } = await db.execute<{ n: string }>(sql`select nextval(${ledgerNumberSeq.seqName}) as n`);
    return Number(rows[0]!.n);
  },
};
