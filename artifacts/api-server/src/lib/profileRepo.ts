import type { AccountControls } from "@workspace/domain/model";
import { NO_EFFECTS, type Effects } from "./activity";

// Storage for applicant profiles and their staff-managed account controls, one
// per sign-in account, behind an interface so routes can be tested without a
// database (Drizzle version: ./profileRepo.db.ts).

/** Account controls as stored (risk signals aren't collected yet). */
export type StoredAccount = Omit<AccountControls, "signals" | "destinationChangedAt">;

export type ProfileRecord = {
  authUserId: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  sector: string;
  country: string;
  birthDate: string | null;
  tier: 1 | 2 | 3;
  identityVerified: boolean;
  account: StoredAccount;
  /** ISO timestamp the profile was created. */
  createdAt: string;
  /** Record version for account-control writes. */
  updatedAt: string;
};

export type NewProfile = Pick<ProfileRecord, "authUserId" | "name" | "email" | "phone" | "sector" | "country" | "birthDate">;
export type ContactPatch = Partial<Pick<ProfileRecord, "name" | "email" | "phone" | "address">>;
/** What the account rules may change. */
export type AccountPatch = Partial<Pick<ProfileRecord, "tier" | "identityVerified" | "account">>;

export interface ProfileRepo {
  get(authUserId: string): Promise<ProfileRecord | null>;
  /** Every applicant, newest first (staff directory). */
  list(): Promise<ProfileRecord[]>;
  /** Creates the profile, or returns the existing one if two first requests race. */
  create(profile: NewProfile): Promise<ProfileRecord>;
  /** Contact details: the person's own edits, applied directly. */
  updateContact(authUserId: string, patch: ContactPatch): Promise<ProfileRecord>;
  /** Tier, identity, and account controls: stored only if the record is still at `expectedVersion`. */
  saveAccount(authUserId: string, patch: AccountPatch, expectedVersion: string, effects?: Effects): Promise<ProfileRecord | "stale">;
}

export const NEW_ACCOUNT: StoredAccount = { status: "Active", passwordResetRequired: false, twoFactorResetRequired: false, kyc: { status: "Not submitted" } };

/** In-memory repo for tests and local experiments. */
export function memoryProfileRepo(seed: ProfileRecord[] = [], activity?: { write(effects: Effects): void }): ProfileRepo {
  const rows = new Map(seed.map(r => [r.authUserId, structuredClone(r)]));
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  const stamp = () => new Date(tick += 1000).toISOString();
  return {
    get: async id => { const row = rows.get(id); return row ? structuredClone(row) : null; },
    list: async () => [...rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(r => structuredClone(r)),
    create: async profile => {
      const existing = rows.get(profile.authUserId);
      if (existing) return structuredClone(existing);
      const at = stamp();
      const row: ProfileRecord = { address: "", tier: 1, identityVerified: false, account: structuredClone(NEW_ACCOUNT), createdAt: at, updatedAt: at, ...profile };
      rows.set(row.authUserId, row);
      return structuredClone(row);
    },
    updateContact: async (id, patch) => {
      const row = rows.get(id);
      if (!row) throw new Error("not found");
      Object.assign(row, patch, { updatedAt: stamp() });
      return structuredClone(row);
    },
    saveAccount: async (id, patch, expectedVersion, effects = NO_EFFECTS) => {
      const row = rows.get(id);
      if (!row || row.updatedAt !== expectedVersion) return "stale";
      Object.assign(row, structuredClone(patch), { updatedAt: stamp() });
      activity?.write(effects);
      return structuredClone(row);
    },
  };
}
