import { DEFAULT_PERMISSIONS } from "@workspace/domain/applicants";
import type { AccountControls, AccountPermissions } from "@workspace/domain/model";
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
  /** Whether notifications are also emailed. */
  emailNotifications: boolean;
  /** When staff required each pending reset (server-only; null when none is pending). */
  resetsRequiredAt: { password: string | null; twoFactor: string | null };
  /** ISO timestamp the profile was created. */
  createdAt: string;
  /** Record version for account-control writes. */
  updatedAt: string;
};

export type NewProfile = Pick<ProfileRecord, "authUserId" | "name" | "email" | "phone" | "sector" | "country" | "birthDate">;
export type ContactPatch = Partial<Pick<ProfileRecord, "name" | "email" | "phone" | "address" | "emailNotifications">>;
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

/** The account's permission switches as stored: the switches, with email copies from their own field. */
export const permissionsFrom = (stored: Partial<AccountPermissions> | null | undefined, emailNotifications: boolean): AccountPermissions =>
  ({ ...DEFAULT_PERMISSIONS, ...stored, emailNotifications });

export const NEW_ACCOUNT: StoredAccount = { status: "Active", passwordResetRequired: false, twoFactorResetRequired: false, kyc: { status: "Not submitted" } };

/** In-memory repo for tests and local experiments. */
export function memoryProfileRepo(seed: ProfileRecord[] = [], activity?: { write(effects: Effects): void }): ProfileRepo & { peek(id: string): ProfileRecord | undefined } {
  const rows = new Map(seed.map(r => [r.authUserId, structuredClone(r)]));
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  const stamp = () => new Date(tick += 1000).toISOString();
  // Like the database: email copies are their own field, shown in the account's permissions.
  const out = (row: ProfileRecord): ProfileRecord => {
    const copy = structuredClone(row);
    copy.account.permissions = permissionsFrom(copy.account.permissions, copy.emailNotifications);
    return copy;
  };
  return {
    peek: id => rows.get(id),
    get: async id => { const row = rows.get(id); return row ? out(row) : null; },
    list: async () => [...rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(out),
    create: async profile => {
      const existing = rows.get(profile.authUserId);
      if (existing) return structuredClone(existing);
      const at = stamp();
      const row: ProfileRecord = { address: "", tier: 1, identityVerified: false, account: structuredClone(NEW_ACCOUNT), emailNotifications: true, resetsRequiredAt: { password: null, twoFactor: null }, createdAt: at, updatedAt: at, ...profile };
      rows.set(row.authUserId, row);
      return out(row);
    },
    updateContact: async (id, patch) => {
      const row = rows.get(id);
      if (!row) throw new Error("not found");
      Object.assign(row, patch, { updatedAt: stamp() });
      return out(row);
    },
    saveAccount: async (id, patch, expectedVersion, effects = NO_EFFECTS) => {
      const row = rows.get(id);
      if (!row || row.updatedAt !== expectedVersion) return "stale";
      const at = stamp();
      if (patch.account) row.resetsRequiredAt = {
        password: patch.account.passwordResetRequired ? row.resetsRequiredAt.password ?? at : null,
        twoFactor: patch.account.twoFactorResetRequired ? row.resetsRequiredAt.twoFactor ?? at : null,
      };
      Object.assign(row, structuredClone(patch), { updatedAt: at });
      if (patch.account?.permissions) row.emailNotifications = patch.account.permissions.emailNotifications;
      activity?.write(effects);
      return out(row);
    },
  };
}
