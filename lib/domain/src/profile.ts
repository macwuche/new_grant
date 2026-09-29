import type { DemoState, Profile, Result } from './model';
import { fail } from './core';

// The applicant's own profile center: personal details they edit themselves and
// their privacy preferences. The same validator runs in the portal (inside the
// Zod schemas of its forms) and on the API server, so both give the same errors.

export type PersonalDetails = {
  name: string;
  /** Shown as the profile's @handle; empty means not added. */
  displayName: string;
  /** International format with the country code, e.g. "+234 803 555 0100"; empty means not added. */
  phone: string;
  /** Telegram username without the "@"; empty means not added. */
  telegram: string;
  /** ISO date (yyyy-mm-dd); empty means not added. */
  birthDate: string;
  address: string;
};

export type PrivacyPreferences = {
  /** Keep browser, device, IP address, and location with each security event. */
  activityLogging: boolean;
  /** Email a security alert when the account is signed in from a device it hasn't used before. */
  unusualActivityEmail: boolean;
};

export const DEFAULT_PRIVACY: PrivacyPreferences = { activityLogging: true, unusualActivityEmail: true };

export const PERSONAL_LIMITS = { name: 120, displayName: 40, phone: 40, telegram: 32, address: 300 } as const;
/** Youngest age accepted for a date of birth. */
export const MIN_AGE = 16;

const TELEGRAM = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const DISPLAY_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;

/** "@name" or a t.me link → "name"; anything else is returned trimmed for validation to judge. */
export function normalizeTelegram(raw: string): string {
  const value = raw.trim().replace(/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me)\//i, '').replace(/^@/, '');
  return value;
}

/** Whether `iso` is a real calendar date. */
function realDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

/** Age in whole years on `today` (UTC calendar dates). */
export function ageOn(birth: Date, today: Date): number {
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  if (today.getUTCMonth() < birth.getUTCMonth() || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

/** Field errors for the personal details form; empty when everything is valid. */
export function validatePersonalDetails(input: PersonalDetails, today: Date): Partial<Record<keyof PersonalDetails, string>> {
  const errors: Partial<Record<keyof PersonalDetails, string>> = {};
  const name = input.name.trim();
  if (name.length < 2) errors.name = 'Enter your full name.';
  else if (name.length > PERSONAL_LIMITS.name) errors.name = `Use at most ${PERSONAL_LIMITS.name} characters.`;

  const displayName = input.displayName.trim();
  if (displayName && (displayName.length < 2 || displayName.length > PERSONAL_LIMITS.displayName)) errors.displayName = `Use 2 to ${PERSONAL_LIMITS.displayName} characters.`;
  else if (displayName && !DISPLAY_NAME.test(displayName)) errors.displayName = 'Use letters, numbers, spaces, and . _ \' - only.';

  const phone = input.phone.trim();
  const digits = phone.replace(/\D/g, '').length;
  if (phone && (!/^\+[\d ()-]+$/.test(phone) || digits < 7 || digits > 15 || phone.length > PERSONAL_LIMITS.phone)) errors.phone = 'Enter your number with its country code: + and 7–15 digits.';

  const telegram = normalizeTelegram(input.telegram);
  if (telegram && !TELEGRAM.test(telegram)) errors.telegram = 'Telegram usernames are 5–32 letters, numbers, or underscores, starting with a letter.';

  const birthDate = input.birthDate.trim();
  if (birthDate) {
    const birth = realDate(birthDate);
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    if (!birth || birth >= todayUtc) errors.birthDate = 'Enter a real date of birth in the past.';
    else if (ageOn(birth, todayUtc) < MIN_AGE) errors.birthDate = `You need to be at least ${MIN_AGE}.`;
    else if (ageOn(birth, todayUtc) > 120) errors.birthDate = 'Check the year of your date of birth.';
  }

  const address = input.address.trim();
  if (address && address.length < 5) errors.address = 'Enter your full address, or leave it empty.';
  else if (address.length > PERSONAL_LIMITS.address) errors.address = `Use at most ${PERSONAL_LIMITS.address} characters.`;
  return errors;
}

/** The details as they're stored: trimmed, Telegram without the "@". */
export function cleanPersonalDetails(input: PersonalDetails): PersonalDetails {
  return {
    name: input.name.trim(), displayName: input.displayName.trim(), phone: input.phone.trim().replace(/\s+/g, ' '),
    telegram: normalizeTelegram(input.telegram), birthDate: input.birthDate.trim(), address: input.address.trim(),
  };
}

/** The profile's handle, e.g. "@henderson": the display name, or else the first name, in lower case without spaces. */
export function profileHandle(profile: Pick<Profile, 'name' | 'displayName'>): string {
  const base = (profile.displayName?.trim() || profile.name.trim().split(/\s+/)[0] || 'applicant').toLowerCase().replace(/[^\p{L}\p{N}._]+/gu, '');
  return `@${base || 'applicant'}`;
}

/** The profile's details in the form's shape (missing optional fields as empty strings). */
export const personalDetailsOf = (p: Profile): PersonalDetails => ({
  name: p.name, displayName: p.displayName ?? '', phone: p.phone, telegram: p.telegram ?? '', birthDate: p.birthDate ?? '', address: p.address,
});

export const privacyOf = (p: Profile): PrivacyPreferences => ({ ...DEFAULT_PRIVACY, ...p.privacy });

/** Browser-only mode: saves the personal details on the preview profile. */
export function updatePersonalDetails(state: DemoState, input: PersonalDetails, now: Date): Result {
  const errors = validatePersonalDetails(input, now);
  if (Object.keys(errors).length) return fail('Fix the highlighted fields.', errors as Record<string, string>);
  const d = cleanPersonalDetails(input);
  const { birthDate, ...rest } = d;
  const profile: Profile = { ...state.profile, ...rest, ...(birthDate ? { birthDate } : {}) };
  if (!birthDate) delete profile.birthDate;
  return { ok: true, message: 'Profile details saved.', state: { ...state, profile } };
}

/** Browser-only mode: saves the privacy switches on the preview profile. */
export function setPrivacy(state: DemoState, prefs: PrivacyPreferences): Result {
  return { ok: true, message: 'Security preferences saved.', state: { ...state, profile: { ...state.profile, privacy: { ...prefs } } } };
}

/** Password strength for the change-password form: 0 (empty) to 4 (strong), with what's missing. */
export function passwordStrength(password: string): { score: 0 | 1 | 2 | 3 | 4; label: string; missing: string[] } {
  if (!password) return { score: 0, label: 'Enter a password', missing: [] };
  const checks: [boolean, string][] = [
    [password.length >= 8, 'at least 8 characters'],
    [/[a-z]/.test(password) && /[A-Z]/.test(password), 'upper- and lower-case letters'],
    [/\d/.test(password), 'a number'],
    [/[^A-Za-z0-9]/.test(password), 'a symbol'],
  ];
  const missing = checks.filter(([ok]) => !ok).map(([, label]) => label);
  let score = checks.filter(([ok]) => ok).length;
  if (password.length < 8) score = Math.min(score, 1);
  if (password.length >= 14 && score >= 3) score = 4;
  const s = Math.max(1, Math.min(4, score)) as 1 | 2 | 3 | 4;
  return { score: s, label: ['', 'Weak', 'Fair', 'Good', 'Strong'][s]!, missing };
}
/** Minimum strength the change-password form accepts. */
export const MIN_PASSWORD_SCORE = 3;
