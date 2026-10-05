import { eq, sql } from "drizzle-orm";
import { db, emailSettingsTable } from "@workspace/db";
import { withEffects, writeEffects } from "./activity.db";
import { NO_EFFECTS } from "./activity";
import { EMPTY_BRANDING, EMPTY_SETTINGS, last4, type EmailSettingsRepo, type StoredEmailSettings } from "./emailSettings";
import type { Cipher } from "./secrets";

const ROW = "email";

/** Settings in Postgres, secrets encrypted with the server's key. */
export function dbEmailSettingsRepo(cipher: Cipher): EmailSettingsRepo {
  const open = (sealed: string | null) => {
    if (!sealed) return null;
    try { return cipher.decrypt(sealed); } catch { return null; }
  };
  const read = async (): Promise<StoredEmailSettings> => {
    const [r] = await db.select().from(emailSettingsTable).where(eq(emailSettingsTable.id, ROW));
    if (!r) return { ...EMPTY_SETTINGS };
    return {
      resendKey: open(r.resendKeyEnc), resendKeyLast4: r.resendKeyLast4, fromAddress: r.fromAddress, replyTo: r.replyTo, appUrl: r.appUrl,
      inboxAddress: r.inboxAddress, domainName: r.domainName, domainId: r.domainId, webhookSecret: open(r.webhookSecretEnc),
      supabaseToken: open(r.supabaseTokenEnc), appName: r.appName, branding: { ...EMPTY_BRANDING, ...r.branding }, updatedAt: r.updatedAt.toISOString(), updatedBy: r.updatedBy,
    };
  };
  return {
    get: read,
    save: async (patch, by, effects = NO_EFFECTS) => {
      const seal = (v: string | null) => v ? cipher.encrypt(v) : null;
      const values = {
        ...(patch.resendKey !== undefined ? { resendKeyEnc: seal(patch.resendKey), resendKeyLast4: patch.resendKey ? last4(patch.resendKey) : null } : {}),
        ...(patch.webhookSecret !== undefined ? { webhookSecretEnc: seal(patch.webhookSecret) } : {}),
        ...(patch.supabaseToken !== undefined ? { supabaseTokenEnc: seal(patch.supabaseToken) } : {}),
        ...(patch.fromAddress !== undefined ? { fromAddress: patch.fromAddress } : {}),
        ...(patch.replyTo !== undefined ? { replyTo: patch.replyTo } : {}),
        ...(patch.appUrl !== undefined ? { appUrl: patch.appUrl } : {}),
        ...(patch.inboxAddress !== undefined ? { inboxAddress: patch.inboxAddress } : {}),
        ...(patch.domainName !== undefined ? { domainName: patch.domainName } : {}),
        ...(patch.domainId !== undefined ? { domainId: patch.domainId } : {}),
        ...(patch.appName !== undefined ? { appName: patch.appName } : {}),
        // Merged in the database, so a change to one branding field never undoes a simultaneous change to another.
        ...(patch.branding !== undefined ? { branding: sql`coalesce(${emailSettingsTable.branding}, '{}'::jsonb) || ${JSON.stringify(patch.branding)}::jsonb` } : {}),
        updatedAt: new Date(), updatedBy: by,
      };
      await db.transaction(async tx => {
        await tx.insert(emailSettingsTable).values({ id: ROW, ...values, ...(patch.branding !== undefined ? { branding: patch.branding } : {}) }).onConflictDoUpdate({ target: emailSettingsTable.id, set: values });
        await writeEffects(tx, effects);
      });
      return read();
    },
    record: effects => withEffects(effects, async () => {}),
  };
}
