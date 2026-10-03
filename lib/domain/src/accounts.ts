import type { AccountPermissions, DemoState, KycDocumentType, Result, Tier } from './model';
import { fail } from './core';
import { accountOf, findApplicant, patchAccount, patchApplicant, permissionsOf } from './applicants';
import { alertIfHighRisk, logStaff } from './activity';
import { notify } from './notifications';
import { CURRENT_APPLICANT_ID } from './seed';

// Applicant account controls (staff) and identity verification (both sides).
// Pure, like the other rule modules. Staff callers go through `asStaff`.
// No documents are uploaded: the applicant enters details and only the last
// four characters of the document number are kept.

export const MIN_REASON_LENGTH = 10;
export const KYC_DOCUMENT_TYPES: KycDocumentType[] = ['Passport', 'National ID', "Driver's licence"];

const needReason = (text: string, what: string) => text.trim().length < MIN_REASON_LENGTH
  ? fail(`Give a reason for ${what}.`, { reason: `Write at least ${MIN_REASON_LENGTH} characters.` }) : null;

function load(state: DemoState, applicantId: string) {
  return findApplicant(state, applicantId);
}

// ---------- Permission switches (staff) ----------

export const PERMISSION_SWITCHES: { key: keyof AccountPermissions; label: string; on: string; off: string }[] = [
  { key: 'payoutKyc', label: 'Identity check for payouts', on: 'Payouts now need a verified identity.', off: 'Payouts no longer need an identity check.' },
  { key: 'depositKyc', label: 'Identity check for deposits', on: 'Adding funds now needs a verified identity.', off: 'Adding funds no longer needs an identity check.' },
  { key: 'emailNotifications', label: 'Email copies of notifications', on: 'Notifications will also be emailed to you.', off: "Notifications will no longer be emailed to you (security notices still are)." },
  { key: 'cardApplications', label: 'Card applications', on: 'You can create and apply for cards again.', off: 'Card applications are turned off for your account.' },
  { key: 'grantApplications', label: 'New grant applications', on: 'You can submit new grant applications again.', off: 'New grant applications are turned off for your account.' },
  { key: 'clearBalanceForPayouts', label: 'Clear a negative deposit balance before grant payouts', on: 'Payouts from your grant balance now wait until your deposit balance is $0 or more.', off: 'Payouts from your grant balance no longer wait for your deposit balance.' },
];

/** Staff turn one of the applicant's permission switches on or off. The applicant is told. */
export function setAccountPermission(state: DemoState, applicantId: string, key: keyof AccountPermissions, value: boolean, now: Date): Result {
  const person = load(state, applicantId);
  if (!person) return fail('That applicant could not be found.');
  const item = PERMISSION_SWITCHES.find(p => p.key === key);
  if (!item || typeof value !== 'boolean') return fail('Choose a setting to change.');
  const current = permissionsOf(state, applicantId);
  if (current[key] === value) return fail(`${item.label} is already ${value ? 'on' : 'off'}.`);
  const next = patchAccount(state, applicantId, { permissions: { ...current, [key]: value } });
  return { ok: true, message: `${item.label} turned ${value ? 'on' : 'off'} for ${person.name}.`, state: notify(next, applicantId, 'Account settings changed', value ? item.on : item.off, '/settings', now) };
}

// ---------- Tier, lock, credential resets (staff) ----------

export function setApplicantTier(state: DemoState, applicantId: string, tier: Tier, reason: string, now: Date): Result {
  const person = load(state, applicantId);
  if (!person) return fail('That applicant could not be found.');
  if (![1, 2, 3].includes(tier)) return fail('Choose tier 1, 2, or 3.');
  if (person.tier === tier) return fail(`${person.name} is already Tier ${tier}.`);
  const missing = needReason(reason, 'the tier change');
  if (missing) return missing;
  const direction = tier > person.tier ? 'upgraded' : 'changed';
  const next = notify(patchApplicant(state, applicantId, { tier }), applicantId, `Account ${direction} to Tier ${tier}`,
    `Your account tier is now ${tier}, which changes the grants you can apply for. ${reason.trim()}`, '/settings', now);
  return { ok: true, id: applicantId, message: `${person.name} moved from Tier ${person.tier} to Tier ${tier}.`, state: next };
}

export function lockAccount(state: DemoState, applicantId: string, reason: string, by: string, now: Date): Result {
  const person = load(state, applicantId);
  if (!person) return fail('That applicant could not be found.');
  if (person.account.status === 'Locked') return fail(`${person.name}'s account is already locked.`);
  const missing = needReason(reason, 'locking the account');
  if (missing) return missing;
  const text = reason.trim();
  const next = notify(patchAccount(state, applicantId, { status: 'Locked', lockReason: text, lockedAt: now.toISOString(), lockedBy: by }), applicantId,
    'Your account is locked', `${text} Applications, deposits, payouts, and card changes are paused until the team restores access.`, '/settings', now);
  return { ok: true, id: applicantId, message: `${person.name}'s account locked. They can't apply, deposit, withdraw, or use their card.`, state: next };
}

export function unlockAccount(state: DemoState, applicantId: string, now: Date): Result {
  const person = load(state, applicantId);
  if (!person) return fail('That applicant could not be found.');
  if (person.account.status !== 'Locked') return fail(`${person.name}'s account isn't locked.`);
  const next = notify(patchAccount(state, applicantId, { status: 'Active', lockReason: undefined, lockedAt: undefined, lockedBy: undefined }), applicantId,
    'Account access restored', 'The grant team restored full access to your account.', '/settings', now);
  return { ok: true, id: applicantId, message: `${person.name}'s account unlocked.`, state: next };
}

export type CredentialKind = 'password' | 'twoFactor';

export function requireCredentialReset(state: DemoState, applicantId: string, kind: CredentialKind, now: Date): Result {
  const person = load(state, applicantId);
  if (!person) return fail('That applicant could not be found.');
  const key = kind === 'password' ? 'passwordResetRequired' : 'twoFactorResetRequired';
  if (person.account[key]) return fail(`A ${kind === 'password' ? 'password' : 'two-step sign-in'} reset is already pending for ${person.name}.`);
  let next = patchAccount(state, applicantId, { [key]: true });
  if (kind === 'twoFactor' && person.current) next = { ...next, profile: { ...next.profile, twoFactor: false } };
  next = notify(next, applicantId, kind === 'password' ? 'Password reset required' : 'Set up two-step sign-in again',
    kind === 'password' ? 'For your security, the grant team requires a new password at your next sign-in.' : 'The grant team reset your two-step sign-in. Set it up again from Settings.', '/settings', now);
  return { ok: true, id: applicantId, message: `${person.name} must ${kind === 'password' ? 'choose a new password' : 'set up two-step sign-in again'} (recorded only; sign-in isn't connected).`, state: next };
}

/** Applicant side: records that the demo user completed a reset staff asked for. */
export function completeCredentialReset(state: DemoState, kind: CredentialKind): Result {
  const account = accountOf(state, CURRENT_APPLICANT_ID);
  const key = kind === 'password' ? 'passwordResetRequired' : 'twoFactorResetRequired';
  if (!account[key]) return fail('No reset is pending.');
  let next = patchAccount(state, CURRENT_APPLICANT_ID, { [key]: false });
  if (kind === 'twoFactor') next = { ...next, profile: { ...next.profile, twoFactor: true } };
  return { ok: true, message: kind === 'password' ? 'Password reset recorded (preview — no password is stored).' : 'Two-step sign-in set up again (preview setting).', state: next };
}

// ---------- Identity verification ----------

export type KycInput = { documentType: KycDocumentType; documentNumber: string; nameOnDocument: string };

export function validateKyc(input: KycInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!KYC_DOCUMENT_TYPES.includes(input.documentType)) errors.documentType = 'Choose a document type.';
  if (!/^[A-Za-z0-9]{5,20}$/.test(input.documentNumber.replace(/[\s-]/g, ''))) errors.documentNumber = 'Enter the document number (5–20 letters or digits).';
  if (input.nameOnDocument.trim().length < 2) errors.nameOnDocument = 'Enter your name exactly as it appears on the document.';
  return errors;
}

export function submitKyc(state: DemoState, input: KycInput, now: Date): Result {
  const kyc = accountOf(state, CURRENT_APPLICANT_ID).kyc;
  if (kyc.status === 'Pending') return fail('Your identity check is already waiting for review.');
  if (kyc.status === 'Verified') return fail('Your identity is already verified.');
  const errors = validateKyc(input);
  if (Object.keys(errors).length) return fail('Fix the highlighted fields.', errors);
  const number = input.documentNumber.replace(/[\s-]/g, '');
  const submitted = patchAccount(state, CURRENT_APPLICANT_ID, {
    kyc: { status: 'Pending', documentType: input.documentType, documentLast4: number.slice(-4).toUpperCase(), nameOnDocument: input.nameOnDocument.trim(), submittedAt: now.toISOString() },
  });
  const logged = logStaff(submitted, { kind: 'account', title: 'Identity check submitted', body: `${state.profile.name} · ${input.documentType}`, href: '/admin/security' }, now);
  const notified = notify(logged, CURRENT_APPLICANT_ID, 'Identity check in progress', "We received your identity details. The compliance team will review them and let you know the outcome.", '/settings', now);
  return { ok: true, message: 'Identity details submitted. The compliance team will review them.', state: alertIfHighRisk(state, notified, CURRENT_APPLICANT_ID, now) };
}

function loadPendingKyc(state: DemoState, applicantId: string) {
  const person = load(state, applicantId);
  if (!person) return { error: fail('That applicant could not be found.') };
  if (person.account.kyc.status !== 'Pending') return { error: fail(`${person.name} has no identity check waiting for review.`) };
  return { person };
}

export function approveKyc(state: DemoState, applicantId: string, by: string, now: Date): Result {
  const { person, error } = loadPendingKyc(state, applicantId);
  if (error) return error;
  const kyc = { ...person.account.kyc, status: 'Verified' as const, reviewedAt: now.toISOString(), reviewedBy: by, rejectionReason: undefined };
  const next = notify(patchAccount(patchApplicant(state, applicantId, { identityVerified: true }), applicantId, { kyc }), applicantId,
    'Identity verified', 'Your identity check was approved. Grants that require verification are now open to you.', '/settings', now);
  return { ok: true, id: applicantId, message: `${person.name}'s identity verified.`, state: next };
}

export function rejectKyc(state: DemoState, applicantId: string, reason: string, by: string, now: Date): Result {
  const { person, error } = loadPendingKyc(state, applicantId);
  if (error) return error;
  const missing = needReason(reason, 'the rejection (the applicant sees it)');
  if (missing) return missing;
  const kyc = { ...person.account.kyc, status: 'Rejected' as const, reviewedAt: now.toISOString(), reviewedBy: by, rejectionReason: reason.trim() };
  const next = notify(patchAccount(patchApplicant(state, applicantId, { identityVerified: false }), applicantId, { kyc }), applicantId,
    'Identity check not approved', `${reason.trim()} You can submit your details again from Settings.`, '/settings', now);
  return { ok: true, id: applicantId, message: `${person.name}'s identity check rejected. They can resubmit.`, state: next };
}

/** Sends a verified applicant back through the identity check (e.g. a document expired). */
export function requestReverification(state: DemoState, applicantId: string, reason: string, by: string, now: Date): Result {
  const person = load(state, applicantId);
  if (!person) return fail('That applicant could not be found.');
  if (person.account.kyc.status !== 'Verified') return fail(`${person.name} isn't currently verified.`);
  const missing = needReason(reason, 'asking them to verify again (the applicant sees it)');
  if (missing) return missing;
  const kyc = { status: 'Not submitted' as const, reviewedAt: now.toISOString(), reviewedBy: by, rejectionReason: reason.trim() };
  const next = notify(patchAccount(patchApplicant(state, applicantId, { identityVerified: false }), applicantId, { kyc }), applicantId,
    'Please verify your identity again', `${reason.trim()} Until then, you can't start new applications.`, '/settings', now);
  return { ok: true, id: applicantId, message: `${person.name} must verify their identity again.`, state: next };
}

/** The applicant changed their password (reported by the portal after Supabase accepted it), so they're told by email too. */
export function recordPasswordChange(state: DemoState, now: Date): Result {
  const next = notify(state, CURRENT_APPLICANT_ID, 'Password changed',
    "Your password was just changed. If this wasn't you, reset your password now and contact the grant team.", '/profile', now);
  return { ok: true, message: 'Password change recorded.', state: next };
}
