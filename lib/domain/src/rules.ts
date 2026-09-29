import type { Application, ApplicationInput, ApplicationStatus, DemoState, Grant, Profile, Result, Transaction } from './model';
import { fail, nextIds, roundCents, usd } from './core';
import { logStaff } from './activity';
import { accountLockReason, permissionBlocker } from './applicants';
import { notify } from './notifications';
import { CURRENT_APPLICANT_ID } from './seed';

// Pure business rules. Everything here takes state in and returns state out so it
// can move to the API server unchanged once persistence exists.

// Shared helpers live in ./core; re-exported so existing imports keep working.
export { fail, nextIds, roundCents };

export const MIN_PURPOSE_LENGTH = 30;
export const MAX_ANSWER_LENGTH = 500;

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

export const findGrant = (state: DemoState, id: string): Grant | undefined => state.grants.find(g => g.id === id);
export const canTransition = (from: ApplicationStatus, to: ApplicationStatus) => TRANSITIONS[from].includes(to);

export const isEditable = (app: Application) => EDITABLE_STATUSES.includes(app.status);

/** Records owned by the signed-in demo applicant. Other applicants' records are staff-only. */
export const ownApplications = (state: DemoState) => state.applications.filter(a => a.applicantId === CURRENT_APPLICANT_ID);
export const ownTransactions = (state: DemoState) => state.transactions.filter(t => t.applicantId === CURRENT_APPLICANT_ID);

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
    for (const q of grant.questions) {
      const value = (input.answers?.[q.id] ?? '').trim();
      const key = `answers.${q.id}`;
      if (!value) { if (q.required) errors[key] = 'Answer this question.'; continue; }
      if (q.type === 'number' && !/^\d+(\.\d{1,2})?$/.test(value.replace(/,/g, ''))) errors[key] = 'Enter a number (digits only).';
      else if (q.type === 'yesno' && value !== 'Yes' && value !== 'No') errors[key] = 'Choose yes or no.';
      else if (value.length > MAX_ANSWER_LENGTH) errors[key] = `Keep answers under ${MAX_ANSWER_LENGTH} characters.`;
    }
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
    answers: Object.fromEntries(grant.questions.map(q => [q.id, (input.answers?.[q.id] ?? '').trim()]).filter(([, v]) => v)),
  };
}

/** Create or update a draft. Drafts may be incomplete, but the grant must be one the applicant can apply for. */
export function saveDraft(state: DemoState, grantId: string, input: ApplicationInput, now: Date, draftId?: string): Result {
  const grant = findGrant(state, grantId);
  if (!grant) return fail('This grant program no longer exists.');
  const locked = accountLockReason(state);
  if (locked) return fail(locked);
  const at = now.toISOString();
  const fields = normalizeInput(input, grant);

  if (draftId) {
    const draft = ownApplications(state).find(a => a.id === draftId);
    if (!draft || draft.grantId !== grantId) return fail('That draft could not be found.');
    if (!isEditable(draft)) return fail('This application can no longer be edited.');
    const updated: Application = { ...draft, ...fields, updatedAt: at };
    return { ok: true, id: draft.id, message: draft.status === 'Draft' ? 'Draft saved.' : 'Changes saved. Resubmit when ready.', state: { ...state, applications: state.applications.map(a => a.id === draft.id ? updated : a) } };
  }

  const eligibility = checkEligibility(grant, state.profile, ownApplications(state), now);
  if (eligibility.existing && isEditable(eligibility.existing)) return saveDraft(state, grantId, input, now, eligibility.existing.id);
  if (!eligibility.eligible) return fail(eligibility.reasons[0]);
  const ids = nextIds(state);
  const draft: Application = { id: ids.app, applicantId: CURRENT_APPLICANT_ID, grantId, status: 'Draft', ...fields, createdAt: at, updatedAt: at, submittedAt: null, reviewer: null, awardedAmount: null, history: [{ status: 'Draft', at, actor: 'Applicant', note: 'Draft started.' }], internalNotes: [], escalation: null };
  return { ok: true, id: draft.id, message: 'Draft saved.', state: { ...state, nextId: ids.nextId, applications: [draft, ...state.applications] } };
}

export function submitApplication(state: DemoState, grantId: string, input: ApplicationInput, now: Date, draftId?: string): Result {
  const grant = findGrant(state, grantId);
  if (!grant) return fail('This grant program no longer exists.');
  const errors = validateApplication(input, grant, 2);
  if (Object.keys(errors).length) return fail('Fix the highlighted fields before submitting.', errors);

  // Eligibility is re-checked at submission time, ignoring the draft being submitted.
  const others = ownApplications(state).filter(a => a.id !== draftId);
  const resubmitting = ownApplications(state).find(a => a.id === draftId)?.status === 'Changes requested';
  const switchedOff = resubmitting ? null : permissionBlocker(state, 'application');
  if (switchedOff) return fail(switchedOff);
  const eligibility = checkEligibility(grant, state.profile, others, now, { allowClosed: resubmitting });
  if (!eligibility.eligible) return fail(eligibility.reasons[0]);
  // A processing fee (if finance set one) is charged once, on first submission, from the deposit balance.
  const fee = resubmitting ? 0 : state.treasury.applicationFee;
  if (fee > 0 && computeBalances(ownTransactions(state)).deposit < fee) return fail(`Submitting needs ${usd(fee)} in your deposit balance for the application fee. Add funds first.`);

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
  let charged: DemoState = { ...saved.state, applications: next };
  if (fee > 0) {
    const ids = nextIds(charged);
    const tx: Transaction = { id: ids.tx, applicantId: CURRENT_APPLICANT_ID, type: 'Application fee', description: `${grant.name} application fee (${id})`, amount: -fee, status: 'Completed', createdAt: at };
    charged = { ...charged, nextId: ids.nextId, transactions: [tx, ...charged.transactions] };
  }
  const logged = logStaff(charged, {
    kind: 'application',
    title: resubmission ? `${id} resubmitted with changes` : `New application ${id}`,
    body: `${state.profile.name} · ${grant.name} · $${input.requestedAmount.toLocaleString('en-US')}`,
    href: '/admin/applications',
  }, now);
  const notified = notify(logged, CURRENT_APPLICANT_ID, `${grant.name} application ${resubmission ? 'resubmitted' : 'received'}`,
    `Your application ${id} for ${usd(input.requestedAmount)} is pending review.${fee > 0 ? ` A ${usd(fee)} application fee was charged to your deposit balance.` : ''} We'll let you know when a reviewer picks it up and when there's a decision.`, `/applications/${id}`, now);
  return { ok: true, id, message: `${grant.name} application ${resubmission ? 'resubmitted' : 'submitted'}.${fee > 0 ? ` ${usd(fee)} application fee charged to your deposit balance.` : ''}`, state: notified };
}

export function deleteDraft(state: DemoState, id: string): Result {
  const app = ownApplications(state).find(a => a.id === id);
  if (!app) return fail('That draft could not be found.');
  if (app.status !== 'Draft') return fail('Submitted applications cannot be deleted.');
  return { ok: true, message: 'Draft deleted.', state: { ...state, applications: state.applications.filter(a => a.id !== id) } };
}

// ---------- Balances & ledger ----------

export type Balances = { grant: number; deposit: number; pendingWithdrawals: number; pendingDeposits: number; /** Shared by the virtual and physical card. */ card: number };

/**
 * Balances are derived from the ledger, never stored. Grant awards fund payouts;
 * deposits fund card and application fees. Pending withdrawals are held (already deducted);
 * pending deposits don't count until finance confirms them. Failed and
 * cancelled entries are ignored.
 */
export function computeBalances(transactions: Transaction[]): Balances {
  let grant = 0, deposit = 0, pendingWithdrawals = 0, pendingDeposits = 0, card = 0;
  for (const tx of transactions) {
    if (tx.status === 'Failed' || tx.status === 'Cancelled') continue;
    if (tx.type === 'Grant' && tx.status === 'Completed') grant += tx.amount;
    if (tx.type === 'Withdrawal') { grant += tx.amount; if (tx.status === 'Pending') pendingWithdrawals -= tx.amount; }
    if (tx.type === 'Deposit') { if (tx.status === 'Completed') deposit += tx.amount; else pendingDeposits += tx.amount; }
    if (tx.type === 'Card fee' || tx.type === 'Application fee' || tx.type === 'Deposit adjustment') deposit += tx.amount;
    if (tx.type === 'Grant adjustment') grant += tx.amount;
    // Card moves: the amount is the change to the card balance; the other side moves the opposite way.
    if (tx.type === 'Card top-up' || tx.type === 'Card deduction') {
      card += tx.amount;
      if (tx.counterpart === 'deposit') deposit -= tx.amount;
      if (tx.counterpart === 'grant') grant -= tx.amount;
    }
  }
  return { grant: roundCents(grant), deposit: roundCents(deposit), pendingWithdrawals: roundCents(pendingWithdrawals), pendingDeposits: roundCents(pendingDeposits), card: roundCents(card) };
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

/**
 * Shows the signed-in applicant's own name and email on the demo profile. Their
 * applications and balances are still this browser's demo records until the API
 * stores them (phase 12).
 */
export function adoptSessionApplicant(state: DemoState, account: { name: string; email: string }): Result {
  const name = account.name.trim() || state.profile.name;
  const email = account.email.trim().toLowerCase();
  if (state.profile.name === name && state.profile.email === email) return { ok: true, message: '', state };
  return { ok: true, message: `Signed in as ${name}.`, state: { ...state, profile: { ...state.profile, name, email } } };
}

export function setTwoFactor(state: DemoState, enabled: boolean): Result {
  return { ok: true, message: `Two-step sign-in ${enabled ? 'enabled' : 'disabled'} (preview setting).`, state: { ...state, profile: { ...state.profile, twoFactor: enabled } } };
}
