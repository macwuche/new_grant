import type { DemoState } from './model';
import { createSeedState, CURRENT_APPLICANT_ID, seedAccounts, seedGrants, seedPayoutDestinations, seedStaff, seedTreasury } from './seed';

/**
 * Upgrades older saved shapes instead of discarding the visitor's work.
 * v2 → v3: the grant catalog moved into state and notifications were added.
 * v3 → v4: money settings (treasury) and the staff activity feed were added.
 * v4 → v5: staff roles, audit log, account controls/KYC, lockdown, program
 * questions, escalations, saved payout destinations, and card PIN/limits.
 */
export function migrateState(raw: unknown): DemoState | null {
  const data = raw as Record<string, unknown> | null;
  if (!data || !Array.isArray(data.applications) || !Array.isArray(data.transactions)) return null;
  if (data.version === 5 && Array.isArray(data.grants) && Array.isArray(data.staff) && Array.isArray(data.audit) && data.accounts && data.treasury) return data as unknown as DemoState;
  if (data.version === 4 && Array.isArray(data.grants) && Array.isArray(data.notifications) && Array.isArray(data.staffFeed) && data.treasury) return migrateState(toV5(data as unknown as V4State));
  if (data.version === 3 && Array.isArray(data.grants) && Array.isArray(data.notifications)) return migrateState({ ...data, version: 4, treasury: seedTreasury(), staffFeed: [] });
  if (data.version === 2) return migrateState({ ...data, version: 3, grants: seedGrants(), notifications: [] });
  return null;
}

type V4State = Omit<DemoState, 'version' | 'payoutDestinations' | 'accounts' | 'staff' | 'actingStaffId' | 'audit' | 'lockdown'> & { version: 4 };

function toV5(data: V4State): DemoState {
  const seed = createSeedState();
  const seedTiers = new Map(seed.otherApplicants.map(p => [p.id, p.tier]));
  const accounts = seedAccounts();
  // Programs keep their existing (question-free) definitions so in-flight applications stay valid.
  return {
    ...data, version: 5,
    grants: data.grants.map(g => ({ ...g, questions: g.questions ?? [] })),
    applications: data.applications.map(a => ({ ...a, answers: a.answers ?? {}, escalation: a.escalation ?? null })),
    treasury: { ...data.treasury, dualControlThreshold: data.treasury.dualControlThreshold ?? seedTreasury().dualControlThreshold, applicationFee: data.treasury.applicationFee ?? 0 },
    profile: { ...seed.profile, ...data.profile },
    otherApplicants: data.otherApplicants.map(p => ({ ...p, tier: p.tier ?? seedTiers.get(p.id) ?? 1 })),
    cards: { ...data.cards, virtual: { ...seed.cards.virtual!, ...data.cards.virtual } },
    payoutDestinations: seedPayoutDestinations(),
    // Keep visitors' verification status in step with the seeded KYC records.
    accounts: data.profile.identityVerified ? accounts : { ...accounts, [CURRENT_APPLICANT_ID]: { ...accounts[CURRENT_APPLICANT_ID]!, kyc: { status: 'Not submitted' } } },
    staff: seedStaff(), actingStaffId: seed.actingStaffId, audit: [], lockdown: null,
  };
}
