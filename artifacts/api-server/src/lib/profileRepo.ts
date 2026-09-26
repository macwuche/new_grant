// Storage for applicant profiles, one per sign-in account, behind an interface
// so routes can be tested without a database (Drizzle version: ./profileRepo.db.ts).

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
  /** ISO timestamp the profile was created. */
  createdAt: string;
};

export type NewProfile = Pick<ProfileRecord, "authUserId" | "name" | "email" | "phone" | "sector" | "country" | "birthDate">;
export type ProfilePatch = Partial<Pick<ProfileRecord, "name" | "email" | "phone" | "address">>;

export interface ProfileRepo {
  get(authUserId: string): Promise<ProfileRecord | null>;
  /** Creates the profile, or returns the existing one if two first requests race. */
  create(profile: NewProfile): Promise<ProfileRecord>;
  update(authUserId: string, patch: ProfilePatch): Promise<ProfileRecord>;
}

/** In-memory repo for tests and local experiments. */
export function memoryProfileRepo(seed: ProfileRecord[] = []): ProfileRepo {
  const rows = new Map(seed.map(r => [r.authUserId, { ...r }]));
  return {
    get: async id => { const row = rows.get(id); return row ? { ...row } : null; },
    create: async profile => {
      const existing = rows.get(profile.authUserId);
      if (existing) return { ...existing };
      const row: ProfileRecord = { address: "", tier: 1, identityVerified: false, createdAt: new Date().toISOString(), ...profile };
      rows.set(row.authUserId, row);
      return { ...row };
    },
    update: async (id, patch) => {
      const row = rows.get(id);
      if (!row) throw new Error("not found");
      Object.assign(row, patch);
      return { ...row };
    },
  };
}
