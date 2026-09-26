import type { Effects } from "./activity";

// Email settings a super admin saves in the app. Saved values win; anything
// not saved falls back to the server's environment variables (RESEND_API_KEY,
// EMAIL_FROM, EMAIL_REPLY_TO, APP_URL, RESEND_WEBHOOK_SECRET,
// SUPABASE_ACCESS_TOKEN). Secrets are kept encrypted by the Drizzle repo
// (./emailSettings.db.ts) and never returned to the browser.

export type StoredEmailSettings = {
  resendKey: string | null;
  resendKeyLast4: string | null;
  fromAddress: string | null;
  replyTo: string | null;
  appUrl: string | null;
  inboxAddress: string | null;
  domainName: string | null;
  domainId: string | null;
  webhookSecret: string | null;
  supabaseToken: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** Fields to change; null clears a field, undefined leaves it. */
export type EmailSettingsPatch = Partial<Omit<StoredEmailSettings, "resendKeyLast4" | "updatedAt" | "updatedBy">>;

export interface EmailSettingsRepo {
  get(): Promise<StoredEmailSettings>;
  save(patch: EmailSettingsPatch, by: string, effects?: Effects): Promise<StoredEmailSettings>;
  /** Stores an audit entry for an email action that changes no setting. */
  record(effects: Effects): Promise<void>;
}

export const EMPTY_SETTINGS: StoredEmailSettings = {
  resendKey: null, resendKeyLast4: null, fromAddress: null, replyTo: null, appUrl: null, inboxAddress: null,
  domainName: null, domainId: null, webhookSecret: null, supabaseToken: null, updatedAt: null, updatedBy: null,
};

export const last4 = (secret: string) => secret.slice(-4);

/** What's in effect: saved settings, else the environment. */
export type EffectiveEmailConfig = {
  resendKey: string | null; from: string | null; replyTo: string | null; appUrl: string | null; inboxAddress: string | null;
  webhookSecret: string | null; supabaseToken: string | null;
  source: { resendKey: "settings" | "environment" | "none"; from: "settings" | "environment" | "none" };
};

export function effectiveConfig(s: StoredEmailSettings, env: NodeJS.ProcessEnv = process.env): EffectiveEmailConfig {
  const pick = (saved: string | null, envName: string) => saved ?? (env[envName]?.trim() || null);
  const src = (saved: string | null, envName: string) => saved ? "settings" as const : env[envName]?.trim() ? "environment" as const : "none" as const;
  const dev = env["REPLIT_DEV_DOMAIN"]?.trim();
  return {
    resendKey: pick(s.resendKey, "RESEND_API_KEY"),
    from: pick(s.fromAddress, "EMAIL_FROM"),
    replyTo: pick(s.replyTo, "EMAIL_REPLY_TO"),
    appUrl: (pick(s.appUrl, "APP_URL") ?? (dev ? `https://${dev}` : null))?.replace(/\/+$/, "") ?? null,
    inboxAddress: s.inboxAddress ?? (env["INBOX_ADDRESS"]?.trim() || null),
    webhookSecret: pick(s.webhookSecret, "RESEND_WEBHOOK_SECRET"),
    supabaseToken: pick(s.supabaseToken, "SUPABASE_ACCESS_TOKEN"),
    source: { resendKey: src(s.resendKey, "RESEND_API_KEY"), from: src(s.fromAddress, "EMAIL_FROM") },
  };
}

/** In-memory repo for tests. */
export function memoryEmailSettingsRepo(activity?: { write(effects: Effects): void }): EmailSettingsRepo {
  let row: StoredEmailSettings = { ...EMPTY_SETTINGS };
  return {
    get: async () => ({ ...row }),
    save: async (patch, by, effects) => {
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      row = { ...row, ...defined, updatedAt: new Date().toISOString(), updatedBy: by };
      if (patch.resendKey !== undefined) row.resendKeyLast4 = patch.resendKey ? last4(patch.resendKey) : null;
      if (effects) activity?.write(effects);
      return { ...row };
    },
    record: async effects => { activity?.write(effects); },
  };
}
