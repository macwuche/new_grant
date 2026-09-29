import type { CardSettings, CardsState, Lockdown, SavedPayoutDetails, Transaction, Treasury } from "@workspace/domain/model";
import { DEFAULT_CARD_SETTINGS } from "@workspace/domain/cards";
import type { Effects } from "./activity";
import type { ProfileRecord, ProfileRepo } from "./profileRepo";

// Storage for money: the ledger, each applicant's cards and remembered payout
// answers, and the system money settings (with the withdrawal methods) and lockdown. Balances are never
// stored; the rules derive them from the ledger.
//
// Locking (the Drizzle version uses Postgres advisory locks):
// - `withApplicant` holds the system lock shared and the applicant's lock
//   exclusively, so one applicant's balance checks and ledger writes never
//   interleave, and a lockdown or settings change can't start halfway through.
// - `withSystem` holds the system lock exclusively (settings, lockdown).
// Application routes that touch money take the applicant lock through
// `ProgramScope.money` (program lock first, then the applicant's).

/** An applicant's money profile: what the money rules read and change besides the ledger. */
export type MoneyProfile = { cards: CardsState; savedPayoutDetails: SavedPayoutDetails; destinationChangedAt?: string };

export type SystemSettings = { treasury: Treasury; lockdown: Lockdown | null };

export type ApplicantMoneyScope = SystemSettings & {
  /** The applicant as stored (account controls, tier), read inside the lock. */
  applicant: ProfileRecord;
  money: MoneyProfile;
  /** This applicant's ledger, every status. */
  transactions: Transaction[];
  saveTransaction(tx: Transaction): Promise<void>;
  saveMoney(money: MoneyProfile): Promise<void>;
  record(effects: Effects): Promise<void>;
};

export type SystemScope = SystemSettings & {
  /** Every applicant's pending withdrawals (lockdown notifies their owners). */
  pendingWithdrawals: Transaction[];
  saveTreasury(treasury: Treasury): Promise<void>;
  saveLockdown(lockdown: Lockdown | null): Promise<void>;
  record(effects: Effects): Promise<void>;
};

export interface MoneyRepo {
  settings(): Promise<SystemSettings>;
  withApplicant<T>(applicantId: string, fn: (scope: ApplicantMoneyScope) => Promise<T>): Promise<T>;
  withSystem<T>(fn: (scope: SystemScope) => Promise<T>): Promise<T>;
  ledgerFor(applicantId: string): Promise<Transaction[]>;
  /** Staff: every ledger entry (payout and deposit queues, overview totals, risk signals). */
  ledger(): Promise<Transaction[]>;
  moneyProfile(applicantId: string): Promise<MoneyProfile | null>;
  findTransaction(id: string): Promise<Transaction | null>;
  /** Staff: every applicant who has cards (created on their first money visit). */
  cardHolders(): Promise<{ applicantId: string; name: string; email: string; cards: CardsState; settings: CardSettings }[]>;
  /** Start of a block of ten ids for one request (see ledger_number_seq). */
  nextBlock(): Promise<number>;
}

/** A new account's cards: none yet. The applicant or staff create the virtual card; a physical card needs it. */
export function newCards(): CardsState {
  return { virtual: null, physical: { status: "Not requested", dailyLimit: 500 } };
}

/** Serializes async work per key (the in-memory stand-in for advisory locks). */
function mutex() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    tails.set(key, run);
    return run;
  };
}

/** In-memory repo for tests. Account controls come from the given profile repo. */
export function memoryMoneyRepo(profiles: ProfileRepo, seed: SystemSettings, activity?: { write(effects: Effects): void }): MoneyRepo & { ledgerRows: Map<string, Transaction> } {
  const ledgerRows = new Map<string, Transaction>();
  const moneyRows = new Map<string, MoneyProfile>();
  let settings = structuredClone(seed);
  const lock = mutex();
  let block = 100000;
  const record = async (effects: Effects) => { activity?.write(effects); };
  const newestFirst = (a: Transaction, b: Transaction) => b.createdAt.localeCompare(a.createdAt);
  const own = (id: string) => [...ledgerRows.values()].filter(t => t.applicantId === id).sort(newestFirst).map(t => structuredClone(t));
  return {
    ledgerRows,
    settings: async () => structuredClone(settings),
    withApplicant: (applicantId, fn) => lock("system", () => lock(`applicant:${applicantId}`, async () => {
      const profile = await profiles.get(applicantId);
      if (!profile) throw new Error("no such applicant");
      if (!moneyRows.has(applicantId)) moneyRows.set(applicantId, { cards: newCards(), savedPayoutDetails: {} });
      return fn({
        ...structuredClone(settings), applicant: profile, money: structuredClone(moneyRows.get(applicantId)!), transactions: own(applicantId),
        saveTransaction: async tx => { ledgerRows.set(tx.id, structuredClone(tx)); },
        saveMoney: async money => { moneyRows.set(applicantId, structuredClone(money)); },
        record,
      });
    })),
    withSystem: fn => lock("system", () => fn({
      ...structuredClone(settings),
      pendingWithdrawals: [...ledgerRows.values()].filter(t => t.type === "Withdrawal" && t.status === "Pending").map(t => structuredClone(t)),
      saveTreasury: async treasury => { settings = { ...settings, treasury: structuredClone(treasury) }; },
      saveLockdown: async lockdown => { settings = { ...settings, lockdown: structuredClone(lockdown) }; },
      record,
    })),
    ledgerFor: async id => own(id),
    ledger: async () => [...ledgerRows.values()].sort(newestFirst).map(t => structuredClone(t)),
    moneyProfile: async id => structuredClone(moneyRows.get(id) ?? null),
    findTransaction: async id => structuredClone(ledgerRows.get(id) ?? null),
    cardHolders: async () => {
      const holders = await Promise.all([...moneyRows.entries()].map(async ([applicantId, m]) => {
        const p = await profiles.get(applicantId);
        return p ? { applicantId, name: p.name, email: p.email, cards: structuredClone(m.cards), settings: p.account.cardSettings ?? DEFAULT_CARD_SETTINGS } : null;
      }));
      return holders.filter(h => h !== null);
    },
    nextBlock: async () => (block += 10),
  };
}
