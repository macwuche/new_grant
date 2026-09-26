import type { Grant } from "@workspace/domain/model";
import { NO_EFFECTS, type Effects } from "./activity";

// Storage for grant programs, behind an interface so routes can be tested
// without a database. The Drizzle implementation lives in ./programRepo.db.ts.
// Writes are conditional on the version (updatedAt) the rule saw, so two staff
// members editing at once can't overwrite each other.

export type WriteOutcome = "ok" | "stale" | "duplicate-name";

export interface ProgramRepo {
  list(): Promise<Grant[]>;
  /** A fresh number for the next program id. */
  nextNumber(): Promise<number>;
  /** Adds a program and, in the same transaction, its effects (audit entry). */
  insert(grant: Grant, effects?: Effects): Promise<WriteOutcome>;
  update(grant: Grant, expectedVersion: string): Promise<WriteOutcome>;
  remove(id: string, expectedVersion: string): Promise<WriteOutcome>;
}

const clone = (g: Grant): Grant => structuredClone(g);

/** In-memory repo for tests and local experiments. */
export function memoryProgramRepo(seed: Grant[] = [], activity?: { write(effects: Effects): void }): ProgramRepo {
  let rows = seed.map(clone);
  let n = 3000;
  const nameTaken = (g: Grant) => rows.some(r => r.id !== g.id && r.name.toLowerCase() === g.name.toLowerCase());
  return {
    list: async () => rows.map(clone),
    nextNumber: async () => ++n,
    insert: async (grant, effects = NO_EFFECTS) => {
      if (nameTaken(grant)) return "duplicate-name";
      rows.push(clone(grant));
      activity?.write(effects);
      return "ok";
    },
    update: async (grant, expectedVersion) => {
      const i = rows.findIndex(r => r.id === grant.id && r.updatedAt === expectedVersion);
      if (i < 0) return "stale";
      if (nameTaken(grant)) return "duplicate-name";
      rows[i] = clone(grant);
      return "ok";
    },
    remove: async (id, expectedVersion) => {
      const before = rows.length;
      rows = rows.filter(r => !(r.id === id && r.updatedAt === expectedVersion));
      return rows.length < before ? "ok" : "stale";
    },
  };
}

/** Adds the sample catalog when there are no programs yet, keeping its ids so browser demo data still matches. */
export async function ensureSeedPrograms(repo: ProgramRepo, seed: Grant[]): Promise<number> {
  if ((await repo.list()).length) return 0;
  for (const grant of seed) await repo.insert(grant);
  return seed.length;
}
