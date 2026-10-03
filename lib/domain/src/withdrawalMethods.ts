import type {
  ChannelId, DemoState, MethodField, MethodFieldType, MethodPhotoFile, PayoutBalance, PayoutChannel, PayoutDetail, Result, WithdrawalMethod, WithdrawalSource,
} from './model';
import { fail, roundCents } from './core';

// Withdrawal methods: finance creates, edits, hides, and deletes the ways
// applicants can be paid out. Each method has limits, charges, a processing
// time, instructions, a photo (or its first letter), the balance it pays out
// from (grant, deposit, or both — the applicant then chooses), and a form the
// applicant fills in when they request (e.g. a wallet address). Changes are
// kept in the money settings' change log and refuse stale versions. The four
// methods that used to be fixed channels are ordinary methods now.

export const MAX_FEE_RATE = 0.1;
export const MAX_FIELDS = 12;
export const MAX_OPTIONS = 20;
export const LIMITS = { name: 40, processingTime: 60, instructions: 1000, formTitle: 60, label: 60, placeholder: 80, help: 160, option: 60, photoUrl: 1000 } as const;
/** Uploaded method photos (JPEG, PNG, WEBP). */
export const MAX_METHOD_PHOTO_BYTES = 2 * 1024 * 1024;
/** Preview mode keeps uploads in the browser as data: URLs, so they're kept small. */
export const MAX_PREVIEW_PHOTO_BYTES = 400 * 1024;
export const FIELD_TYPES: { id: MethodFieldType; label: string }[] = [
  { id: 'text', label: 'Short text' }, { id: 'textarea', label: 'Long text' }, { id: 'email', label: 'Email address' }, { id: 'number', label: 'Number' }, { id: 'select', label: 'Dropdown' },
];
export const SOURCE_LABELS: Record<WithdrawalSource, string> = { grant: 'Grant balance', deposit: 'Deposit balance', both: 'Grant or deposit balance (user chooses)' };
export const BALANCE_LABELS: Record<PayoutBalance, string> = { grant: 'Grant balance', deposit: 'Deposit balance' };
/** Where an uploaded method photo is served from (public: method logos aren't private). */
export const methodPhotoPath = (id: string, sha256: string) => `/api/withdrawal-methods/${encodeURIComponent(id)}/photo?v=${sha256.slice(0, 12)}`;

/** What finance edits: everything but the id and the uploaded file; fields may not have ids yet. */
export type MethodInput = Omit<WithdrawalMethod, 'id' | 'photoFile' | 'fields'> & { fields: (Omit<MethodField, 'id'> & { id?: string })[] };

/** The first letter shown when a method has no photo. */
export const methodInitial = (name: string) => (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();

/** The balances a method can pay out from. */
export const methodBalances = (m: Pick<WithdrawalMethod, 'source'>): PayoutBalance[] => m.source === 'both' ? ['grant', 'deposit'] : [m.source];

// ---------- Built-in methods (the former fixed channels) ----------

const field = (id: string, label: string, placeholder: string, extra: Partial<MethodField> = {}): MethodField =>
  ({ id, label, type: 'text', required: true, placeholder, help: '', options: [], ...extra });

/** Processing time, form, and instructions for the four methods that used to be fixed channels. */
export const BUILTIN_METHOD_DETAILS: Record<string, Pick<WithdrawalMethod, 'processingTime' | 'instructions' | 'formTitle' | 'fields'>> = {
  bank: {
    processingTime: '1–2 business days', formTitle: 'Bank account details',
    instructions: 'Enter the account the payout should go to. It must be in your own name.',
    fields: [field('bank-name', 'Bank name', 'e.g. Meridian Bank'), field('account-name', 'Account holder name', 'As shown on the account'), field('account-number', 'Account number', '6–17 digits')],
  },
  wire: {
    processingTime: '2–5 business days', formTitle: 'Wire details',
    instructions: 'International wires can take longer and your bank may charge a receiving fee.',
    fields: [field('swift', 'SWIFT / BIC', 'e.g. MRDNUS33'), field('iban', 'Account number or IBAN', '6–34 letters or digits'), field('account-name', 'Account holder name', 'As shown on the account')],
  },
  mobile: {
    processingTime: 'Usually within an hour', formTitle: 'Mobile money details',
    instructions: 'Use the number registered to your mobile money wallet.',
    fields: [field('phone', 'Mobile money number', '+234 803 555 0100'), field('network', 'Network', '', { type: 'select', options: ['MTN', 'Airtel', 'Glo', '9mobile', 'M-Pesa', 'Other'] })],
  },
  crypto: {
    processingTime: '1–24 hours', formTitle: 'Wallet details',
    instructions: 'Only USDT on the TRON (TRC-20) network. Sending to another network loses the funds.',
    fields: [field('wallet', 'USDT (TRC-20) wallet address', 'T… (34 characters)'), field('note', 'Withdrawal note', 'Anything finance should know', { type: 'textarea', required: false })],
  },
};

/**
 * Fills in what older saved settings don't have (methods were fixed channels
 * with only limits and fees). Used when settings are read from storage.
 */
export function normalizeMethod(raw: Partial<WithdrawalMethod> & Pick<WithdrawalMethod, 'id' | 'name'>): WithdrawalMethod {
  const builtin = BUILTIN_METHOD_DETAILS[raw.id];
  const fields = Array.isArray(raw.fields) ? raw.fields : builtin?.fields ?? [];
  return {
    id: raw.id, name: raw.name, enabled: raw.enabled ?? false,
    min: raw.min ?? 10, max: raw.max ?? 1000, feeRate: raw.feeRate ?? 0, feeFixed: raw.feeFixed ?? 0, feeCap: raw.feeCap ?? 0,
    processingTime: raw.processingTime ?? builtin?.processingTime ?? '1–3 business days',
    instructions: raw.instructions ?? builtin?.instructions ?? '',
    photoUrl: raw.photoUrl ?? '',
    ...(raw.photoFile ? { photoFile: { key: raw.photoFile.key, contentType: raw.photoFile.contentType, sha256: raw.photoFile.sha256 } } : {}),
    source: raw.source === 'deposit' || raw.source === 'both' ? raw.source : 'grant',
    formTitle: raw.formTitle ?? builtin?.formTitle ?? '',
    fields: fields.map(f => ({ id: f.id, label: f.label, type: f.type, required: !!f.required, placeholder: f.placeholder ?? '', help: f.help ?? '', options: f.type === 'select' ? [...(f.options ?? [])] : [] })),
  };
}

// ---------- Validation ----------

const isAmount = (value: number, allowZero = false) => Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) && roundCents(value) === value;
const len = (v: string) => v.trim().length;
/** A method or field id made from its name: lowercase letters, digits, and dashes. */
export const slug = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'method';

/** Limits and charges; error keys are the field names, prefixed with `prefix`. `noun` names a request in messages. */
export function validateLimitsAndCharges(c: Pick<PayoutChannel, 'min' | 'max' | 'feeRate' | 'feeFixed' | 'feeCap'>, prefix = '', noun = 'payout'): Record<string, string> {
  const errors: Record<string, string> = {};
  const key = (f: string) => `${prefix}${f}`;
  if (!isAmount(c.min)) errors[key('min')] = 'Enter a positive amount.';
  if (!isAmount(c.max)) errors[key('max')] = 'Enter a positive amount.';
  else if (!errors[key('min')] && c.max < c.min) errors[key('max')] = 'Must be at least the minimum.';
  if (!Number.isFinite(c.feeRate) || c.feeRate < 0 || c.feeRate > MAX_FEE_RATE) errors[key('feeRate')] = `Use 0–${MAX_FEE_RATE * 100}%.`;
  if (!isAmount(c.feeFixed, true)) errors[key('feeFixed')] = 'Enter 0 or more.';
  if (!isAmount(c.feeCap, true)) errors[key('feeCap')] = 'Enter 0 or more.';
  else if (!errors[key('feeFixed')] && c.feeCap > 0 && c.feeCap < c.feeFixed) errors[key('feeCap')] = 'The maximum must be at least the fixed charge (or 0 for no maximum).';
  if (!errors[key('min')] && !errors[key('feeFixed')] && c.feeFixed >= c.min) errors[key('feeFixed')] = `The fixed fee must be below the minimum, or the smallest ${noun} would be all fee.`;
  return errors;
}

/**
 * A photo link must be https; an uploaded photo's path (under `uploadPrefix`) is only accepted unchanged;
 * data: URLs are preview-mode uploads.
 */
export function photoError(url: string, current: { photoUrl: string } | undefined, uploadPrefix = '/api/withdrawal-methods/'): string | null {
  const value = url.trim();
  if (!value) return null;
  if (value.length > LIMITS.photoUrl && !value.startsWith('data:')) return 'That link is too long.';
  if (value.startsWith(uploadPrefix)) return current && current.photoUrl === value ? null : 'Upload the photo again or use a link.';
  if (value.startsWith('data:')) {
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return 'Upload a JPG, PNG, or WEBP image.';
    return value.length > Math.ceil(MAX_PREVIEW_PHOTO_BYTES * 4 / 3) + 40 ? `Photos can be at most ${MAX_PREVIEW_PHOTO_BYTES / 1024} KB in this preview.` : null;
  }
  if (/^http:\/\//i.test(value)) return 'Use a secure link (https://).';
  // https, a host with a dot, then an optional path; no spaces or quotes (the link goes into an <img>).
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d{1,5})?([/?#][^\s"'<>]*)?$/i.test(value)) return 'Enter a full link starting with https://.';
  return null;
}

/** Field ids: kept when the field already has one, otherwise made from the label; unique within the method. */
export function withFieldIds(fields: MethodInput['fields']): MethodField[] {
  const used = new Set<string>();
  return fields.map(f => {
    let id = f.id && /^[a-z0-9-]{1,40}$/.test(f.id) && !used.has(f.id) ? f.id : slug(f.label);
    for (let n = 2; used.has(id); n++) id = `${slug(f.label)}-${n}`;
    used.add(id);
    return {
      id, label: f.label.trim(), type: f.type, required: !!f.required, placeholder: f.placeholder.trim(), help: f.help.trim(),
      options: f.type === 'select' ? f.options.map(o => o.trim()).filter(Boolean) : [],
    };
  });
}

/** Errors keyed by field name; form fields as `fields.<index>.<name>`. */
export function validateMethod(input: MethodInput, others: WithdrawalMethod[], current?: WithdrawalMethod): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = input.name.trim();
  if (len(name) < 2 || name.length > LIMITS.name) errors.name = `Use 2–${LIMITS.name} characters.`;
  else if (others.some(o => o.id !== current?.id && o.name.trim().toLowerCase() === name.toLowerCase())) errors.name = 'Another method already has this name.';
  const photo = photoError(input.photoUrl, current);
  if (photo) errors.photoUrl = photo;
  Object.assign(errors, validateLimitsAndCharges(input));
  if (len(input.processingTime) < 2 || input.processingTime.trim().length > LIMITS.processingTime) errors.processingTime = `Say how long it takes (2–${LIMITS.processingTime} characters), e.g. "1–2 business days".`;
  if (input.instructions.trim().length > LIMITS.instructions) errors.instructions = `Keep instructions under ${LIMITS.instructions} characters.`;
  if (!['grant', 'deposit', 'both'].includes(input.source)) errors.source = 'Choose the balance users withdraw from.';
  return Object.assign(errors, validateForm(input));
}

/** The form users fill in: its name and fields. Errors keyed `formTitle`, `fields`, and `fields.<index>.<name>`. */
export function validateForm(input: Pick<MethodInput, 'formTitle' | 'fields'>): Record<string, string> {
  const errors: Record<string, string> = {};
  if (input.fields.length > MAX_FIELDS) errors.fields = `A form can have up to ${MAX_FIELDS} fields.`;
  if (input.fields.length && (len(input.formTitle) < 2 || input.formTitle.trim().length > LIMITS.formTitle)) errors.formTitle = `Name the form (2–${LIMITS.formTitle} characters), e.g. "Wallet details".`;
  const labels = new Set<string>();
  input.fields.forEach((f, i) => {
    const key = (k: string) => `fields.${i}.${k}`;
    const label = f.label.trim();
    if (len(label) < 2 || label.length > LIMITS.label) errors[key('label')] = `Use 2–${LIMITS.label} characters.`;
    else if (labels.has(label.toLowerCase())) errors[key('label')] = 'Two fields have this label.';
    labels.add(label.toLowerCase());
    if (!FIELD_TYPES.some(t => t.id === f.type)) errors[key('type')] = 'Choose a field type.';
    if (f.placeholder.trim().length > LIMITS.placeholder) errors[key('placeholder')] = `Up to ${LIMITS.placeholder} characters.`;
    if (f.help.trim().length > LIMITS.help) errors[key('help')] = `Up to ${LIMITS.help} characters.`;
    if (f.type === 'select') {
      const options = f.options.map(o => o.trim()).filter(Boolean);
      if (options.length < 2) errors[key('options')] = 'Add at least two choices.';
      else if (options.length > MAX_OPTIONS) errors[key('options')] = `Up to ${MAX_OPTIONS} choices.`;
      else if (options.some(o => o.length > LIMITS.option)) errors[key('options')] = `Each choice can be up to ${LIMITS.option} characters.`;
      else if (new Set(options.map(o => o.toLowerCase())).size !== options.length) errors[key('options')] = 'Each choice must be different.';
    }
  });
  return errors;
}

// ---------- Finance: create, edit, availability, photo, delete ----------

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** e.g. "1.25% (max $14.00)" or "$25.00 + 1% (max $30.00)" or "No charge". */
export function chargesLabel(m: Pick<WithdrawalMethod, 'feeRate' | 'feeFixed' | 'feeCap'>): string {
  const parts = [m.feeFixed ? money(m.feeFixed) : '', m.feeRate ? `${+(m.feeRate * 100).toFixed(2)}%` : ''].filter(Boolean);
  if (!parts.length) return 'No charge';
  return `${parts.join(' + ')}${m.feeRate && m.feeCap > 0 ? ` (max ${money(m.feeCap)})` : ''}`;
}

function changed(state: DemoState, channels: WithdrawalMethod[], by: string, now: Date, summary: string): DemoState {
  const at = now.toISOString();
  return { ...state, treasury: { ...state.treasury, channels, updatedAt: at, changeLog: [...state.treasury.changeLog, { at, by, summary }] } };
}
const stale = (state: DemoState, expectedVersion: string) => state.treasury.updatedAt !== expectedVersion;
const STALE = 'Withdrawal methods changed since you opened them. Review the latest version and try again.';
const clean = (input: MethodInput): Omit<WithdrawalMethod, 'id' | 'photoFile'> => ({
  name: input.name.trim(), enabled: !!input.enabled, min: input.min, max: input.max, feeRate: input.feeRate, feeFixed: input.feeFixed, feeCap: input.feeCap,
  processingTime: input.processingTime.trim(), instructions: input.instructions.trim(), photoUrl: input.photoUrl.trim(), source: input.source,
  formTitle: input.formTitle.trim(), fields: withFieldIds(input.fields),
});

export function createMethod(state: DemoState, expectedVersion: string, input: MethodInput, by: string, now: Date): Result {
  if (stale(state, expectedVersion)) return fail(STALE);
  const channels = state.treasury.channels;
  const errors = validateMethod(input, channels);
  if (Object.keys(errors).length) return fail('Fix the highlighted fields.', errors);
  let id = slug(input.name);
  for (let n = 2; channels.some(c => c.id === id); n++) id = `${slug(input.name)}-${n}`;
  const method: WithdrawalMethod = { id, ...clean(input) };
  const next = changed(state, [...channels, method], by, now, `Added withdrawal method ${method.name}${method.enabled ? '' : ' (unavailable)'}.`);
  return { ok: true, id, message: `${method.name} added.${method.enabled ? ' Users can choose it now.' : ' It stays hidden from users until you make it available.'}`, state: next };
}

/** What changed, in words, for the change log. */
function describeEdit(before: WithdrawalMethod, after: WithdrawalMethod): string[] {
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`renamed to ${after.name}`);
  if (before.enabled !== after.enabled) parts.push(after.enabled ? 'made available' : 'made unavailable');
  if (before.min !== after.min || before.max !== after.max) parts.push('limits');
  if (before.feeRate !== after.feeRate || before.feeFixed !== after.feeFixed || before.feeCap !== after.feeCap) parts.push('charges');
  if (before.processingTime !== after.processingTime) parts.push('processing time');
  if (before.instructions !== after.instructions) parts.push('instructions');
  if (before.photoUrl !== after.photoUrl) parts.push('photo');
  if (before.source !== after.source) parts.push('balance');
  if (before.formTitle !== after.formTitle || JSON.stringify(before.fields) !== JSON.stringify(after.fields)) parts.push('form');
  return parts;
}

export function updateMethod(state: DemoState, expectedVersion: string, id: ChannelId, input: MethodInput, by: string, now: Date): Result {
  if (stale(state, expectedVersion)) return fail(STALE);
  const current = state.treasury.channels.find(c => c.id === id);
  if (!current) return fail('That withdrawal method no longer exists.');
  const errors = validateMethod(input, state.treasury.channels, current);
  if (Object.keys(errors).length) return fail('Fix the highlighted fields.', errors);
  const cleaned = clean(input);
  // The uploaded file stays with the method only while its photo is still that upload.
  const keepFile = current.photoFile && cleaned.photoUrl === current.photoUrl;
  const method: WithdrawalMethod = { id, ...cleaned, ...(keepFile ? { photoFile: current.photoFile } : {}) };
  const parts = describeEdit(current, method);
  if (!parts.length) return fail('Nothing has changed.');
  const next = changed(state, state.treasury.channels.map(c => c.id === id ? method : c), by, now, `Withdrawal method ${current.name}: ${parts.join(', ')}.`);
  return { ok: true, id, message: `${method.name} saved. Changes apply to new requests; pending ones keep what they were quoted.`, state: next };
}

export function setMethodAvailability(state: DemoState, id: ChannelId, enabled: boolean, by: string, now: Date): Result {
  const current = state.treasury.channels.find(c => c.id === id);
  if (!current) return fail('That withdrawal method no longer exists.');
  if (current.enabled === enabled) return fail(`${current.name} is already ${enabled ? 'available' : 'unavailable'}.`);
  const next = changed(state, state.treasury.channels.map(c => c.id === id ? { ...c, enabled } : c), by, now, `Withdrawal method ${current.name} made ${enabled ? 'available' : 'unavailable'}.`);
  const none = !next.treasury.channels.some(c => c.enabled);
  return { ok: true, id, message: `${current.name} is now ${enabled ? 'available to users' : 'hidden from users'}.${none ? ' No method is available, so users cannot request payouts.' : ''}`, state: next };
}

/** Sets or clears the photo (an upload's file record and path, a preview data: URL, or a link). */
export function setMethodPhoto(state: DemoState, id: ChannelId, photoUrl: string, file: MethodPhotoFile | null, by: string, now: Date): Result {
  const current = state.treasury.channels.find(c => c.id === id);
  if (!current) return fail('That withdrawal method no longer exists.');
  const url = file ? methodPhotoPath(id, file.sha256) : photoUrl.trim();
  if (!file) {
    const error = photoError(url, current);
    if (error) return fail(error, { photoUrl: error });
  }
  const { photoFile: _old, ...rest } = current;
  const method: WithdrawalMethod = { ...rest, photoUrl: url, ...(file ? { photoFile: file } : {}) };
  const next = changed(state, state.treasury.channels.map(c => c.id === id ? method : c), by, now, `Withdrawal method ${current.name}: photo ${url ? 'changed' : 'removed'}.`);
  return { ok: true, id, message: url ? `${current.name} photo updated.` : `${current.name} photo removed; its first letter is shown instead.`, state: next };
}

/** Pending requests keep their method name, charges, and answers, so finance can still process them. */
export function deleteMethod(state: DemoState, id: ChannelId, by: string, now: Date): Result {
  const current = state.treasury.channels.find(c => c.id === id);
  if (!current) return fail('That withdrawal method no longer exists.');
  const pending = state.transactions.filter(t => t.type === 'Withdrawal' && t.status === 'Pending' && t.method === id).length;
  const next = changed(state, state.treasury.channels.filter(c => c.id !== id), by, now, `Deleted withdrawal method ${current.name}.`);
  const none = !next.treasury.channels.some(c => c.enabled);
  return {
    ok: true, id, state: next,
    message: `${current.name} deleted.${pending ? ` ${pending} pending request${pending === 1 ? '' : 's'} keep${pending === 1 ? 's' : ''} its details and can still be processed.` : ''}${none ? ' No method is available, so users cannot request payouts.' : ''}`,
  };
}

// ---------- Applicant: the method's form ----------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NUMBER = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;
export const answerLimit = (type: MethodFieldType) => type === 'textarea' ? 1000 : 200;

/** Checks the applicant's answers against the method's form. Errors are keyed `details.<fieldId>`. */
export function checkAnswers(method: { fields: MethodField[] }, answers: Record<string, string>): { details: PayoutDetail[] } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const details: PayoutDetail[] = [];
  for (const f of method.fields) {
    const raw = answers[f.id];
    const value = typeof raw === 'string' ? raw.trim() : '';
    const key = `details.${f.id}`;
    if (!value) { if (f.required) errors[key] = `${f.label} is required.`; continue; }
    if (value.length > answerLimit(f.type)) errors[key] = `Up to ${answerLimit(f.type)} characters.`;
    else if (f.type === 'email' && !EMAIL.test(value)) errors[key] = 'Enter a valid email address.';
    else if (f.type === 'number' && !NUMBER.test(value.replace(/[\s,]/g, ''))) errors[key] = 'Enter a number.';
    else if (f.type === 'select' && !f.options.includes(value)) errors[key] = 'Choose one of the options.';
    else details.push({ fieldId: f.id, label: f.label, value });
  }
  return Object.keys(errors).length ? { errors } : { details };
}

/** A one-line summary of a request's destination for lists: the method and its first answer. */
export function destinationSummary(methodName: string, details: PayoutDetail[]): string {
  const first = details[0]?.value ?? '';
  const short = first.length > 32 ? `${first.slice(0, 14)}…${first.slice(-8)}` : first;
  return short ? `${methodName} · ${short}` : methodName;
}
