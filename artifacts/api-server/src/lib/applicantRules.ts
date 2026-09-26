import type { DemoState, Result } from "@workspace/domain/model";
import { applicantState, readApplicantSlot, type SlotApplicant } from "@workspace/domain/server";
import { effectsOf, type AuditContext } from "./activity";
import type { ProfileRecord, ProfileRepo } from "./profileRepo";

// Runs an account rule (@workspace/domain/accounts) for one real applicant and
// stores what it changed. The rules expect the applicant in the "current
// applicant" slot, so staff rules are called with CURRENT_APPLICANT_ID.
// Notifications and feed items the rule creates, and the audit entry when a
// staff member acted, are stored in the same transaction.

export const slotApplicant = (r: ProfileRecord): SlotApplicant => ({
  id: r.authUserId,
  profile: { name: r.name, email: r.email, phone: r.phone, address: r.address, sector: r.sector, country: r.country, joined: r.createdAt.slice(0, 10), tier: r.tier, identityVerified: r.identityVerified },
  account: { ...r.account, signals: { ipCountry: "Unknown", sharedDeviceWith: [] } },
});

export type RuleOutcome =
  | { ok: true; record: ProfileRecord; message: string }
  | { ok: false; status: 400 | 409; body: { error: string; fieldErrors?: Record<string, string> } };

const STALE = "This account changed while you were working on it. Reload it and try again.";

export async function runAccountRule(repo: ProfileRepo, record: ProfileRecord, command: (state: DemoState) => Result, audit?: AuditContext): Promise<RuleOutcome> {
  const before = applicantState({}, slotApplicant(record));
  const result = command(before);
  if (!result.ok) return { ok: false, status: 400, body: { error: result.error, ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}) } };
  const { profile, account } = readApplicantSlot(result.state, record.authUserId);
  const { signals: _signals, destinationChangedAt: _changed, ...stored } = account;
  const effects = effectsOf(before, result.state, new Date(), { slotId: record.authUserId, audit, summary: result.message });
  const saved = await repo.saveAccount(record.authUserId, { tier: profile.tier, identityVerified: profile.identityVerified, account: stored }, record.updatedAt, effects);
  if (saved === "stale") return { ok: false, status: 409, body: { error: STALE } };
  return { ok: true, record: saved, message: result.message };
}
