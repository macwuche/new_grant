import type { Application, ApplicationInput, ApplicationStatus, DemoState, Grant, PayoutMethod, Profile, Result, Transaction } from './model';
import { CURRENT_APPLICANT_ID } from './seed';

// Pure business rules. Everything here takes state in and returns state out so it
// can move to the API server unchanged once persistence exists.

export const WITHDRAWAL_FEE_RATE = 0.0125;
export const WITHDRAWAL_FEE_CAP = 14;
export const MIN_WITHDRAWAL = 10;
export const PHYSICAL_CARD_FEE = 8.5;
export const MIN_PURPOSE_LENGTH = 30;

/** Statuses the applicant can still edit and (re)submit. */
export const EDITABLE_STATUSES: ApplicationStatus[] = ['Draft', 'Changes requested'];
/** Statuses that block starting a second application for the same grant. */
const ACTIVE_STATUSES: ApplicationStatus[] = ['Submitted', 'Under review', 'Changes requested', 'Approved'];

const TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  Draft: ['Submitted'],
  Submitted: ['Under review'],
  'Under review': ['Approved', 'Declined', 'Changes requested'],
  'Changes requested': ['Submitted'],
  Approved: [],
  Declined: [],
};

export const roundCents = (value: number) => Math.round(value * 100) / 100;
export const findGrant = (state: DemoState, id: string): Grant | undefined => state.grants.find(g => g.id === id);
export const canTransition = (from: ApplicationStatus, to: ApplicationStatus) => TRANSITIONS[from].includes(to);

export const fail = (error: string, fieldErrors?: Record<string, string>): Result => ({ ok: false, error, fieldErrors });
export const isEditable = (app: Application) => EDITABLE_STATUSES.includes(app.status);

/** Records owned by the signed-in demo applicant. Other applicants' records are staff-only. */
export const ownApplications = (state: DemoState) => state.applications.filter(a => a.applicantId === CURRENT_APPLICANT_ID);
export const ownTransactions = (state: DemoState) => state.transactions.filter(t => t.applicantId === CURRENT_APPLICANT_ID);

export function nextIds(state: DemoState) {
  return { app: `APP-${state.nextId}`, tx: `TX-${80000 + state.nextId}`, notification: `NT-${state.nextId}`, program: `PRG-${state.nextId}`, nextId: state.nextId + 1 };
}

// ---------- Grants & eligibility ----------

export function isBeforeDeadline(grant: Grant, now: Date): boolean {
  return new Date(`${grant.deadline}T23:59:59`).getTime() >= now.getTime();
}

/** Published, not closed by staff, and before its deadline. */
export function isGrantOpen(grant: Grant, now: Date): boolean {
  return grant.status === 'Open' && isBeforeDeadline(grant, now);
}

/** Programs applicants can see: everything except staff-only drafts. */
export const visibleGrants = (state: DemoState) => state.grants.filter(g => g.status !== 'Draft');

export type Eligibility = {
  eligible: boolean;
  reasons: string[];
  /** Existing application for this grant, if any (draft or active). */
  existing?: Application;
};

export function checkEligibility(grant: Grant, profile: Profile, applications: Application[], now: Date, options: { allowClosed?: boolean } = {}): Eligibility {
  const reasons: string[] = [];
  const existing = applications.find(a => a.grantId === grant.id && (a.status === 'Draft' || ACTIVE_STATUSES.includes(a.status)));
  // Closing only stops new work; a reviewer-requested change may still be resubmitted.
  const inFlight = options.allowClosed || existing?.status === 'Changes requested';
  if (grant.status === 'Draft') reasons.push('This program has not been published.');
  else if (grant.status === 'Closed' && !inFlight) reasons.push('This program is not accepting new applications.');
  else if (!isBeforeDeadline(grant, now) && !inFlight) reasons.push(`Applications closed on ${grant.deadline}.`);
  if (profile.tier < grant.minimumTier) reasons.push(`Requires Tier ${grant.minimumTier}; your account is Tier ${profile.tier}.`);
  if (!profile.identityVerified) reasons.push('Identity verification is required before applying.');
  if (existing && !isEditable(existing)) reasons.push(`You already have an application for this grant (${existing.id}, ${existing.status.toLowerCase()}).`);
  return { eligible: reasons.length === 0, reasons, existing };
}

/** Largest single award the applicant can currently apply for. */
export function maxEligibleAward(grants: Grant[], profile: Profile, applications: Application[], now: Date): number {
  return grants.filter(g => checkEligibility(g, profile, applications, now).eligible).reduce((max, g) => Math.max(max, g.maxFunding), 0);
}

// ---------- Applications ----------

export type ApplicationStep = 1 | 2 | 3;

export function validateApplication(input: ApplicationInput, grant: Grant, upToStep: ApplicationStep): Record<string, string> {
  const errors: Record<string, string> = {};
  if (upToStep >= 1) {
    if (input.businessName.trim().length < 2) errors.businessName = 'Enter your business or project name.';
    const amount = input.requestedAmount;
    if (!Number.isFinite(amount) || amount <= 0) errors.requestedAmount = 'Enter the amount you are requesting.';
    else if (roundCents(amount) !== amount) errors.requestedAmount = 'Use at most two decimal places.';
    else if (amount < grant.minimumRequest) errors.requestedAmount = `The minimum request for this grant is $${grant.minimumRequest.toLocaleString('en-US')}.`;
    else if (amount > grant.maxFunding) errors.requestedAmount = `This grant awards up to $${grant.maxFunding.toLocaleString('en-US')}.`;
    if (grant.requiresRegistration && !input.registrationNumber.trim()) errors.registrationNumber = 'A registration number is required for this grant.';
    if (input.purpose.trim().length < MIN_PURPOSE_LENGTH) errors.purpose = `Describe your plan in at least ${MIN_PURPOSE_LENGTH} characters.`;
  }
  if (upToStep >= 2) {
    const missing = grant.requirements.filter(r => !input.checklist.includes(r));
    if (missing.length) errors.checklist = `Confirm you have every requirement ready (${missing.length} remaining).`;
  }
  return errors;
}

function normalizeInput(input: ApplicationInput, grant: Grant): ApplicationInput {
  return {
    businessName: input.businessName.trim(),
    requestedAmount: input.requestedAmount,
    registrationNumber: input.registrationNumber.trim(),
    purpose: input.purpose.trim(),
    checklist: grant.requirements.filter(r => input.checklist.includes(r)),
  };
}

/** Create or update a draft. Drafts may be incomplete, but the grant must be one the applicant can apply for. */
export function saveDraft(state: DemoState, grantId: string, input: ApplicationInput, now: Date, draftId?: string): Result {
  const grant = findGrant(state, grantId);
  if (!grant) return fail('This grant program no longer exists.');
  const at = now.toISOString();
  const fields = normalizeInput(input, grant);

  if (draftId) {
    const draft = ownApplications(state).find(a => a.id === draftId);
    if (!draft || draft.grantId !== grantId) return fail('That draft could not be found.');
    if (!isEditable(draft)) return fail('This application can no longer be edited.');
    const updated: Application = { ...draft, ...fields, updatedAt: at };
    return { ok: true, id: draft.id, message: draft.status === 'Draft' ? 'Draft saved in this browser.' : 'Changes saved. Resubmit when ready.', state: { ...state, applications: state.applications.map(a => a.id === draft.id ? updated : a) } };
  }

  const eligibility = checkEligibility(grant, state.profile, ownApplications(state), now);
  if (eligibility.existing && isEditable(eligibility.existing)) return saveDraft(state, grantId, input, now, eligibility.existing.id);
  if (!eligibility.eligible) return fail(eligibility.reasons[0]);
  const ids = nextIds(state);
  const draft: Application = { id: ids.app, applicantId: CURRENT_APPLICANT_ID, grantId, status: 'Draft', ...fields, createdAt: at, updatedAt: at, submittedAt: null, reviewer: null, awardedAmount: null, history: [{ status: 'Draft', at, actor: 'Applicant', note: 'Draft started.' }], internalNotes: [] };
  return { ok: true, id: draft.id, message: 'Draft saved in this browser.', state: { ...state, nextId: ids.nextId, applications: [draft, ...state.applications] } };
}

export function submitApplication(state: DemoState, grantId: string, input: ApplicationInput, now: Date, draftId?: string): Result {
  const grant = findGrant(state, grantId);
  if (!grant) return fail('This grant program no longer exists.');
  const errors = validateApplication(input, grant, 2);
  if (Object.keys(errors).length) return fail('Fix the highlighted fields before submitting.', errors);

  // Eligibility is re-checked at submission time, ignoring the draft being submitted.
  const others = ownApplications(state).filter(a => a.id !== draftId);
  const resubmitting = ownApplications(state).find(a => a.id === draftId)?.status === 'Changes requested';
  const eligibility = checkEligibility(grant, state.profile, others, now, { allowClosed: resubmitting });
  if (!eligibility.eligible) return fail(eligibility.reasons[0]);

  const saved = saveDraft(state, grantId, input, now, draftId);
  if (!saved.ok) return saved;
  const id = saved.id!;
  const at = now.toISOString();
  const before = saved.state.applications.find(a => a.id === id)!;
  if (!canTransition(before.status, 'Submitted')) return fail('This application can no longer be submitted.');
  const resubmission = before.status === 'Changes requested';
  const next = saved.state.applications.map(a => a.id !== id ? a : {
    ...a, status: 'Submitted' as const, submittedAt: at, updatedAt: at,
    history: [...a.history, { status: 'Submitted' as const, at, actor: 'Applicant' as const, note: resubmission ? 'Application resubmitted with the requested changes.' : 'Application submitted.' }],
  });
  return { ok: true, id, message: `${grant.name} application ${resubmission ? 'resubmitted' : 'submitted'}.`, state: { ...saved.state, applications: next } };
}

export function deleteDraft(state: DemoState, id: string): Result {
  const app = ownApplications(state).find(a => a.id === id);
  if (!app) return fail('That draft could not be found.');
  if (app.status !== 'Draft') return fail('Submitted applications cannot be deleted.');
  return { ok: true, message: 'Draft deleted.', state: { ...state, applications: state.applications.filter(a => a.id !== id) } };
}

// ---------- Balances & ledger ----------

export type Balances = { grant: number; deposit: number; pendingWithdrawals: number };

/**
 * Balances are derived from the ledger, never stored. Grant awards fund payouts;
 * deposits fund card fees. Pending withdrawals are held (already deducted).
 */
export function computeBalances(transactions: Transaction[]): Balances {
  let grant = 0, deposit = 0, pendingWithdrawals = 0;
  for (const tx of transactions) {
    if (tx.status === 'Failed') continue;
    if (tx.type === 'Grant' && tx.status === 'Completed') grant += tx.amount;
    if (tx.type === 'Withdrawal') { grant += tx.amount; if (tx.status === 'Pending') pendingWithdrawals -= tx.amount; }
    if (tx.type === 'Deposit' && tx.status === 'Completed') deposit += tx.amount;
    if (tx.type === 'Card fee') deposit += tx.amount;
  }
  return { grant: roundCents(grant), deposit: roundCents(deposit), pendingWithdrawals: roundCents(pendingWithdrawals) };
}

export function withdrawalFee(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return roundCents(Math.min(amount * WITHDRAWAL_FEE_RATE, WITHDRAWAL_FEE_CAP));
}

export function validateWithdrawal(amount: number, available: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return 'Enter an amount to withdraw.';
  if (roundCents(amount) !== amount) return 'Use at most two decimal places.';
  if (amount < MIN_WITHDRAWAL) return `The minimum payout is $${MIN_WITHDRAWAL.toFixed(2)}.`;
  if (amount > available) return `You can request up to $${available.toLocaleString('en-US', { minimumFractionDigits: 2 })}.`;
  return null;
}

export function requestWithdrawal(state: DemoState, amount: number, method: PayoutMethod, now: Date): Result {
  const { grant } = computeBalances(ownTransactions(state));
  const error = validateWithdrawal(amount, grant);
  if (error) return fail(error, { amount: error });
  const ids = nextIds(state);
  const tx: Transaction = { id: ids.tx, applicantId: CURRENT_APPLICANT_ID, type: 'Withdrawal', description: `Payout to ${method.type}`, amount: -amount, status: 'Pending', createdAt: now.toISOString(), fee: withdrawalFee(amount), destination: `${method.type} · ${method.label}` };
  return { ok: true, id: tx.id, message: `Payout request ${tx.id} recorded as pending.`, state: { ...state, nextId: ids.nextId, transactions: [tx, ...state.transactions] } };
}

// ---------- Cards ----------

export function toggleCardFreeze(state: DemoState): Result {
  const frozen = !state.cards.virtual.frozen;
  return { ok: true, message: frozen ? 'Virtual card frozen.' : 'Virtual card unfrozen.', state: { ...state, cards: { ...state.cards, virtual: { ...state.cards.virtual, frozen } } } };
}

export function requestPhysicalCard(state: DemoState, now: Date): Result {
  if (state.cards.physical.status !== 'Not requested') return fail('A physical card has already been requested.');
  const { deposit } = computeBalances(ownTransactions(state));
  if (deposit < PHYSICAL_CARD_FEE) return fail(`Your deposit balance must cover the $${PHYSICAL_CARD_FEE.toFixed(2)} issuance fee.`);
  const ids = nextIds(state);
  const fee: Transaction = { id: ids.tx, applicantId: CURRENT_APPLICANT_ID, type: 'Card fee', description: 'Physical card issuance', amount: -PHYSICAL_CARD_FEE, status: 'Completed', createdAt: now.toISOString() };
  return {
    ok: true, message: `Physical card requested. $${PHYSICAL_CARD_FEE.toFixed(2)} fee deducted from your deposit balance.`,
    state: { ...state, nextId: ids.nextId, transactions: [fee, ...state.transactions], cards: { ...state.cards, physical: { ...state.cards.physical, status: 'Requested' } } },
  };
}

// ---------- Profile ----------

export type ProfileInput = Pick<Profile, 'name' | 'email' | 'phone' | 'address'>;

export function validateProfile(input: ProfileInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (input.name.trim().length < 2) errors.name = 'Enter your full name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) errors.email = 'Enter a valid email address.';
  if (input.phone.replace(/\D/g, '').length < 7) errors.phone = 'Enter a valid phone number.';
  if (input.address.trim().length < 5) errors.address = 'Enter your address.';
  return errors;
}

export function updateProfile(state: DemoState, input: ProfileInput): Result {
  const errors = validateProfile(input);
  if (Object.keys(errors).length) return fail('Fix the highlighted fields.', errors);
  const profile = { ...state.profile, name: input.name.trim(), email: input.email.trim(), phone: input.phone.trim(), address: input.address.trim() };
  return { ok: true, message: 'Profile saved in this browser.', state: { ...state, profile } };
}

export function setTwoFactor(state: DemoState, enabled: boolean): Result {
  return { ok: true, message: `Two-step sign-in ${enabled ? 'enabled' : 'disabled'} (preview setting).`, state: { ...state, profile: { ...state.profile, twoFactor: enabled } } };
}
