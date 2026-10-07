import type { Application, Grant, Lockdown, Transaction, Treasury } from "@workspace/domain/model";
import type { Effects } from "./activity";
import type { ProgramRepo, WriteOutcome } from "./programRepo";

// Storage for applications. Every change happens inside `withProgram`, which
// holds a lock on one program for the duration: the rules see that program's
// applications (all applicants) and nothing else can change them, or the
// program itself, until the changes are stored. That keeps locked criteria
// and one-application-per-grant correct under concurrent requests.
// The Drizzle implementation lives in ./applicationRepo.db.ts.

export type ProgramScope = {
  /** Every program (rules look programs up by id). */
  grants: Grant[];
  /** This program's applications, every applicant's, drafts included. */
  applications: Application[];
  saveApplication(app: Application): Promise<void>;
  removeApplication(id: string): Promise<void>;
  saveGrant(grant: Grant, expectedVersion: string): Promise<WriteOutcome>;
  removeGrant(id: string, expectedVersion: string): Promise<WriteOutcome>;
  /** Notifications, feed items, and audit entries for this change, in the same transaction. */
  record(effects: Effects): Promise<void>;
  /** Takes the applicant's money lock (after the program's) and loads their ledger and the money settings. */
  money(applicantId: string): Promise<{ transactions: Transaction[]; treasury: Treasury; lockdown: Lockdown | null }>;
  saveTransaction(tx: Transaction): Promise<void>;
};

export interface ApplicationRepo {
  withProgram<T>(grantId: string, fn: (scope: ProgramScope) => Promise<T>): Promise<T>;
  get(id: string): Promise<Application | null>;
  listForApplicant(applicantId: string): Promise<Application[]>;
  /** Everything staff review: every application except drafts. */
  listSubmitted(): Promise<Application[]>;
  nextNumber(): Promise<number>;
}

/** In-memory repo for tests. Programs are kept in the given program repo. */
/** Minimal view of the in-memory money repo that application routes need. */
type MemoryLedger = { ledgerRows: Map<string, Transaction>; settings(): Promise<{ treasury: Treasury; lockdown: Lockdown | null }> };

export function memoryApplicationRepo(programs: ProgramRepo, seed: Application[] = [], activity?: { write(effects: Effects): void }, ledger?: MemoryLedger): ApplicationRepo {
  const rows = new Map(seed.map(a => [a.id, structuredClone(a)]));
  const locks = new Map<string, Promise<unknown>>();
  let n = 5000;
  return {
    withProgram: (grantId, fn) => {
      const previous = locks.get(grantId) ?? Promise.resolve();
      const run = previous.catch(() => {}).then(async () => fn({
        grants: await programs.list(),
        applications: [...rows.values()].filter(a => a.grantId === grantId).map(a => structuredClone(a)),
        saveApplication: async app => { rows.set(app.id, structuredClone(app)); },
        removeApplication: async id => { rows.delete(id); },
        saveGrant: (grant, version) => programs.update(grant, version),
        removeGrant: (id, version) => programs.remove(id, version),
        record: async effects => { activity?.write(effects); },
        money: async applicantId => {
          if (!ledger) throw new Error("memoryApplicationRepo needs a ledger for money");
          const transactions = [...ledger.ledgerRows.values()].filter(t => t.applicantId === applicantId).map(t => structuredClone(t));
          return { transactions, ...(await ledger.settings()) };
        },
        saveTransaction: async tx => { ledger?.ledgerRows.set(tx.id, structuredClone(tx)); },
      }));
      locks.set(grantId, run);
      return run;
    },
    get: async id => { const row = rows.get(id); return row ? structuredClone(row) : null; },
    listForApplicant: async applicantId => [...rows.values()].filter(a => a.applicantId === applicantId).map(a => structuredClone(a)),
    listSubmitted: async () => [...rows.values()].filter(a => a.status !== "Draft").map(a => structuredClone(a)),
    nextNumber: async () => ++n,
  };
}
