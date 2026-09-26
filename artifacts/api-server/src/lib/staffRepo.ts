import type { StaffRole } from "@workspace/authz";
import { NO_EFFECTS, type Effects } from "./activity";

// Storage for staff members, behind an interface so routes can be tested
// without a database. The Drizzle implementation lives in ./staffRepo.db.ts.

export type StaffRecord = { id: string; email: string; name: string; role: StaffRole; active: boolean; authUserId: string | null };

export interface StaffRepo {
  list(): Promise<StaffRecord[]>;
  findById(id: string): Promise<StaffRecord | null>;
  findByAuthUserId(authUserId: string): Promise<StaffRecord | null>;
  findByEmail(email: string): Promise<StaffRecord | null>;
  /** `effects` (an audit entry) are written in the same transaction. */
  create(member: Pick<StaffRecord, "email" | "name" | "role">, effects?: Effects): Promise<StaffRecord>;
  update(id: string, patch: Partial<Pick<StaffRecord, "role" | "active" | "authUserId">>, effects?: Effects): Promise<StaffRecord>;
}

/** In-memory repo for tests and local experiments. */
export function memoryStaffRepo(seed: StaffRecord[] = [], activity?: { write(effects: Effects): void }): StaffRepo {
  const rows = seed.map(r => ({ ...r }));
  let n = rows.length;
  return {
    list: async () => rows.map(r => ({ ...r })),
    findById: async id => rows.find(r => r.id === id) ?? null,
    findByAuthUserId: async authUserId => rows.find(r => r.authUserId === authUserId) ?? null,
    findByEmail: async email => rows.find(r => r.email === email.toLowerCase()) ?? null,
    create: async (member, effects = NO_EFFECTS) => {
      const row: StaffRecord = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, active: true, authUserId: null, ...member, email: member.email.toLowerCase() };
      rows.push(row);
      activity?.write(effects);
      return { ...row };
    },
    update: async (id, patch, effects = NO_EFFECTS) => {
      const row = rows.find(r => r.id === id);
      if (!row) throw new Error("not found");
      Object.assign(row, patch);
      activity?.write(effects);
      return { ...row };
    },
  };
}

/** Creates the first super admin when no staff exist yet (from INITIAL_SUPER_ADMIN_EMAIL). */
export async function ensureInitialSuperAdmin(repo: StaffRepo, email: string, name: string): Promise<StaffRecord | null> {
  if ((await repo.list()).length) return null;
  return repo.create({ email: email.toLowerCase(), name, role: "super" });
}
