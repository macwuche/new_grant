import type { DemoState, DepositMethod, DepositMethodId, MethodField, MethodPhotoFile, ProofRule, ReceivingDetail, Result, TierAmounts, Treasury } from './model';
import { fail } from './core';
import { LIMITS, normalizeMethod, photoError, slug, validateForm, validateLimitsAndCharges, withFieldIds, type MethodInput } from './withdrawalMethods';

// Deposit methods: finance creates, edits, hides, and deletes the ways
// applicants can add funds, like withdrawal methods (./withdrawalMethods).
// Each method has where to send the money (receiving details applicants can
// copy), limits, a charge taken from what's credited, a processing time,
// instructions, a photo (or its first letter), whether proof of payment is
// required, optional, or off, and a form the applicant fills in (e.g. the
// sender's name or a transaction hash). Changes are kept in the money
// settings' change log and refuse stale versions. The two methods that used to
// be fixed in code (bank transfer, mobile money) are ordinary methods now.

export const MAX_RECEIVING_DETAILS = 10;
export const RECEIVING_LIMITS = { label: 60, value: 300 } as const;
export const PROOF_LABELS: Record<ProofRule, string> = { required: 'Required', optional: 'Optional', off: 'Not asked for' };
/** Where an uploaded deposit method photo is served from (public, like withdrawal method photos). */
export const depositMethodPhotoPath = (id: string, sha256: string) => `/api/deposit-methods/${encodeURIComponent(id)}/photo?v=${sha256.slice(0, 12)}`;
const UPLOAD_PREFIX = '/api/deposit-methods/';

/** What finance edits: everything but the id and the uploaded file; fields may not have ids yet. */
export type DepositMethodInput = Omit<DepositMethod, 'id' | 'photoFile' | 'fields'> & { fields: MethodInput['fields'] };

/** Receiving details still showing the sample values they were created with. */
export const PLACEHOLDER_MARK = '(placeholder)';
export const hasPlaceholderDetails = (m: Pick<DepositMethod, 'receivingDetails'>) => m.receivingDetails.some(d => d.value.toLowerCase().includes(PLACEHOLDER_MARK));

// ---------- Built-in methods ----------

const field = (id: string, label: string, placeholder: string, extra: Partial<MethodField> = {}): MethodField =>
  ({ id, label, type: 'text', required: true, placeholder, help: '', options: [], ...extra });

/**
 * The starting methods: bank transfer and mobile money (the two that used to
 * be fixed in code, with the same sample receiving details) and USDT on TRON,
 * which starts unavailable until finance enters a real wallet address.
 */
export function builtinDepositMethods(limits: { min: number; max: number } = { min: 20, max: 25000 }): DepositMethod[] {
  const common = { feeRate: 0, feeFixed: 0, feeCap: 0, photoUrl: '', proof: 'optional' as const };
  return [
    {
      id: 'bank', name: 'Bank transfer', enabled: true, ...limits, ...common, processingTime: 'Usually 1–2 business days',
      instructions: 'Send the transfer from an account in your own name and put the payment reference in the transfer description.',
      receivingDetails: [{ label: 'Account number', value: `00012345 ${PLACEHOLDER_MARK}` }, { label: 'Routing number', value: `000000000 ${PLACEHOLDER_MARK}` }],
      formTitle: 'Sender details', fields: [field('sender-name', 'Name on the sending account', 'As shown on your bank account', { required: false, help: 'Helps finance match your transfer.' })],
    },
    {
      id: 'mobile', name: 'Mobile money', enabled: true, ...limits, ...common, processingTime: 'Usually within an hour',
      instructions: 'Send from a wallet registered in your name and use the payment reference as the transfer note.',
      receivingDetails: [{ label: 'Mobile money number', value: `+1 (415) 555-0100 ${PLACEHOLDER_MARK}` }],
      formTitle: 'Sender details', fields: [field('sender-number', 'Number you are sending from', '+234 803 555 0100', { required: false, help: 'Helps finance match your transfer.' })],
    },
    {
      id: 'crypto', name: 'USDT (TRC-20)', enabled: false, min: limits.min, max: Math.min(limits.max, 20000), ...common, processingTime: 'Usually within an hour of network confirmation',
      instructions: 'Send only USDT on the TRON (TRC-20) network. Other coins or networks can\'t be recovered. Add the transaction hash so finance can find your transfer.',
      receivingDetails: [{ label: 'Network', value: 'TRON (TRC-20)' }, { label: 'Wallet address', value: `T… ${PLACEHOLDER_MARK}` }],
      formTitle: 'Transfer details',
      fields: [field('tx-hash', 'Transaction hash (TxID)', '64 letters and digits', { help: 'Shown in your wallet after you send.' }), field('from-wallet', 'Wallet you sent from', 'T… (34 characters)', { required: false })],
    },
  ];
}

/** Fills in what an older or partial stored method lacks. */
export function normalizeDepositMethod(raw: Partial<DepositMethod> & Pick<DepositMethod, 'id' | 'name'>): DepositMethod {
  return {
    id: raw.id, name: raw.name, enabled: raw.enabled ?? false,
    min: raw.min ?? 20, max: raw.max ?? 25000, feeRate: raw.feeRate ?? 0, feeFixed: raw.feeFixed ?? 0, feeCap: raw.feeCap ?? 0,
    processingTime: raw.processingTime ?? '1–2 business days', instructions: raw.instructions ?? '', photoUrl: raw.photoUrl ?? '',
    ...(raw.photoFile ? { photoFile: { key: raw.photoFile.key, contentType: raw.photoFile.contentType, sha256: raw.photoFile.sha256 } } : {}),
    receivingDetails: (raw.receivingDetails ?? []).map(d => ({ label: d.label, value: d.value })),
    proof: raw.proof === 'required' || raw.proof === 'off' ? raw.proof : 'optional',
    formTitle: raw.formTitle ?? '',
    fields: (raw.fields ?? []).map(f => ({ id: f.id, label: f.label, type: f.type, required: !!f.required, placeholder: f.placeholder ?? '', help: f.help ?? '', options: f.type === 'select' ? [...(f.options ?? [])] : [] })),
  };
}

/** Stored money settings from before deposit methods (29 Sep 2026) had one deposit minimum and maximum for all methods. */
export type StoredTreasury = Omit<Treasury, 'depositMethods' | 'depositDualControlThreshold' | 'tierEligibleAmounts'> & {
  depositMethods?: (Partial<DepositMethod> & Pick<DepositMethod, 'id' | 'name'>)[];
  depositDualControlThreshold?: number;
  /** Added 8 Oct 2026; older settings have none set. */
  tierEligibleAmounts?: Partial<TierAmounts>;
  minDeposit?: number;
  maxDeposit?: number;
  /** Removed 3 Oct 2026 (commission per program replaced it); dropped when read. */
  applicationFee?: number;
};

/**
 * Money settings in today's shape, whatever version they were saved in:
 * withdrawal methods get the fields they lack, and settings without deposit
 * methods get the built-in ones with the old deposit limits. The deposit
 * two-person threshold starts at the payout one. Tier eligible amounts start
 * unset (0).
 */
export function normalizeTreasury(t: StoredTreasury): Treasury {
  const { minDeposit, maxDeposit, depositMethods, depositDualControlThreshold, tierEligibleAmounts, applicationFee: _removed, ...rest } = t;
  return {
    ...rest,
    channels: t.channels.map(normalizeMethod),
    depositMethods: depositMethods ? depositMethods.map(normalizeDepositMethod) : builtinDepositMethods({ min: minDeposit ?? 20, max: maxDeposit ?? 25000 }),
    depositDualControlThreshold: depositDualControlThreshold ?? t.dualControlThreshold,
    tierEligibleAmounts: normalizeTierAmounts(tierEligibleAmounts),
  };
}

/** Tier eligible amounts in today's shape; a missing tier is not set (0). */
export const normalizeTierAmounts = (t: Partial<TierAmounts> | undefined): TierAmounts =>
  ({ tier1: t?.tier1 ?? 0, tier2: t?.tier2 ?? 0, tier3: t?.tier3 ?? 0 });

// ---------- Validation ----------

const len = (v: string) => v.trim().length;

/** Where applicants send the money: 1–10 lines, each with a label and a value. Errors keyed `receivingDetails` and `receivingDetails.<index>.<label|value>`. */
export function validateReceivingDetails(details: ReceivingDetail[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!details.length) errors.receivingDetails = 'Add at least one line, e.g. the account number or wallet address.';
  else if (details.length > MAX_RECEIVING_DETAILS) errors.receivingDetails = `Up to ${MAX_RECEIVING_DETAILS} lines.`;
  const labels = new Set<string>();
  details.forEach((d, i) => {
    const key = (k: string) => `receivingDetails.${i}.${k}`;
    const label = d.label.trim();
    if (len(label) < 2 || label.length > RECEIVING_LIMITS.label) errors[key('label')] = `Use 2–${RECEIVING_LIMITS.label} characters.`;
    else if (labels.has(label.toLowerCase())) errors[key('label')] = 'Two lines have this label.';
    labels.add(label.toLowerCase());
    if (!len(d.value)) errors[key('value')] = 'Enter the value applicants copy.';
    else if (d.value.trim().length > RECEIVING_LIMITS.value) errors[key('value')] = `Up to ${RECEIVING_LIMITS.value} characters.`;
  });
  return errors;
}

/** Errors keyed by field name; receiving details and form fields by index. */
export function validateDepositMethod(input: DepositMethodInput, others: DepositMethod[], current?: DepositMethod): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = input.name.trim();
  if (len(name) < 2 || name.length > LIMITS.name) errors.name = `Use 2–${LIMITS.name} characters.`;
  else if (others.some(o => o.id !== current?.id && o.name.trim().toLowerCase() === name.toLowerCase())) errors.name = 'Another deposit method already has this name.';
  const photo = photoError(input.photoUrl, current, UPLOAD_PREFIX);
  if (photo) errors.photoUrl = photo;
  Object.assign(errors, validateLimitsAndCharges(input, '', 'deposit'));
  if (len(input.processingTime) < 2 || input.processingTime.trim().length > LIMITS.processingTime) errors.processingTime = `Say how long it takes (2–${LIMITS.processingTime} characters), e.g. "Usually within an hour".`;
  if (input.instructions.trim().length > LIMITS.instructions) errors.instructions = `Keep instructions under ${LIMITS.instructions} characters.`;
  Object.assign(errors, validateReceivingDetails(input.receivingDetails));
  if (!['required', 'optional', 'off'].includes(input.proof)) errors.proof = 'Choose whether proof of payment is required.';
  return Object.assign(errors, validateForm(input));
}

// ---------- Finance: create, edit, availability, photo, delete ----------

function changed(state: DemoState, depositMethods: DepositMethod[], by: string, now: Date, summary: string): DemoState {
  const at = now.toISOString();
  return { ...state, treasury: { ...state.treasury, depositMethods, updatedAt: at, changeLog: [...state.treasury.changeLog, { at, by, summary }] } };
}
const stale = (state: DemoState, expectedVersion: string) => state.treasury.updatedAt !== expectedVersion;
export const STALE_DEPOSIT_METHODS = 'Deposit methods changed since you opened them. Review the latest version and try again.';
const GONE = 'That deposit method no longer exists.';
const clean = (input: DepositMethodInput): Omit<DepositMethod, 'id' | 'photoFile'> => ({
  name: input.name.trim(), enabled: !!input.enabled, min: input.min, max: input.max, feeRate: input.feeRate, feeFixed: input.feeFixed, feeCap: input.feeCap,
  processingTime: input.processingTime.trim(), instructions: input.instructions.trim(), photoUrl: input.photoUrl.trim(),
  receivingDetails: input.receivingDetails.map(d => ({ label: d.label.trim(), value: d.value.trim() })), proof: input.proof,
  formTitle: input.fields.length ? input.formTitle.trim() : '', fields: withFieldIds(input.fields),
});
const noneLeft = (state: DemoState) => !state.treasury.depositMethods.some(m => m.enabled) ? ' No deposit method is available, so users cannot add funds.' : '';

export function createDepositMethod(state: DemoState, expectedVersion: string, input: DepositMethodInput, by: string, now: Date): Result {
  if (stale(state, expectedVersion)) return fail(STALE_DEPOSIT_METHODS);
  const methods = state.treasury.depositMethods;
  const errors = validateDepositMethod(input, methods);
  if (Object.keys(errors).length) return fail('Fix the highlighted fields.', errors);
  let id = slug(input.name);
  for (let n = 2; methods.some(m => m.id === id); n++) id = `${slug(input.name)}-${n}`;
  const method: DepositMethod = { id, ...clean(input) };
  const next = changed(state, [...methods, method], by, now, `Added deposit method ${method.name}${method.enabled ? '' : ' (unavailable)'}.`);
  return { ok: true, id, message: `${method.name} added.${method.enabled ? ' Users can choose it now.' : ' It stays hidden from users until you make it available.'}`, state: next };
}

/** What changed, in words, for the change log. */
function describeEdit(before: DepositMethod, after: DepositMethod): string[] {
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`renamed to ${after.name}`);
  if (before.enabled !== after.enabled) parts.push(after.enabled ? 'made available' : 'made unavailable');
  if (before.min !== after.min || before.max !== after.max) parts.push('limits');
  if (before.feeRate !== after.feeRate || before.feeFixed !== after.feeFixed || before.feeCap !== after.feeCap) parts.push('charges');
  if (before.processingTime !== after.processingTime) parts.push('processing time');
  if (before.instructions !== after.instructions) parts.push('instructions');
  if (before.photoUrl !== after.photoUrl) parts.push('photo');
  if (JSON.stringify(before.receivingDetails) !== JSON.stringify(after.receivingDetails)) parts.push('receiving details');
  if (before.proof !== after.proof) parts.push(`proof of payment ${PROOF_LABELS[after.proof].toLowerCase()}`);
  if (before.formTitle !== after.formTitle || JSON.stringify(before.fields) !== JSON.stringify(after.fields)) parts.push('form');
  return parts;
}

export function updateDepositMethod(state: DemoState, expectedVersion: string, id: DepositMethodId, input: DepositMethodInput, by: string, now: Date): Result {
  if (stale(state, expectedVersion)) return fail(STALE_DEPOSIT_METHODS);
  const current = state.treasury.depositMethods.find(m => m.id === id);
  if (!current) return fail(GONE);
  const errors = validateDepositMethod(input, state.treasury.depositMethods, current);
  if (Object.keys(errors).length) return fail('Fix the highlighted fields.', errors);
  const cleaned = clean(input);
  // The uploaded file stays with the method only while its photo is still that upload.
  const keepFile = current.photoFile && cleaned.photoUrl === current.photoUrl;
  const method: DepositMethod = { id, ...cleaned, ...(keepFile ? { photoFile: current.photoFile } : {}) };
  const parts = describeEdit(current, method);
  if (!parts.length) return fail('Nothing has changed.');
  const next = changed(state, state.treasury.depositMethods.map(m => m.id === id ? method : m), by, now, `Deposit method ${current.name}: ${parts.join(', ')}.`);
  return { ok: true, id, message: `${method.name} saved. Changes apply to new deposits; pending ones keep the details and charge they were given.`, state: next };
}

export function setDepositMethodAvailability(state: DemoState, id: DepositMethodId, enabled: boolean, by: string, now: Date): Result {
  const current = state.treasury.depositMethods.find(m => m.id === id);
  if (!current) return fail(GONE);
  if (current.enabled === enabled) return fail(`${current.name} is already ${enabled ? 'available' : 'unavailable'}.`);
  const next = changed(state, state.treasury.depositMethods.map(m => m.id === id ? { ...m, enabled } : m), by, now, `Deposit method ${current.name} made ${enabled ? 'available' : 'unavailable'}.`);
  return { ok: true, id, message: `${current.name} is now ${enabled ? 'available to users' : 'hidden from users'}.${noneLeft(next)}`, state: next };
}

/** Sets or clears the photo (an upload's file record, a preview data: URL, or a link). */
export function setDepositMethodPhoto(state: DemoState, id: DepositMethodId, photoUrl: string, file: MethodPhotoFile | null, by: string, now: Date): Result {
  const current = state.treasury.depositMethods.find(m => m.id === id);
  if (!current) return fail(GONE);
  const url = file ? depositMethodPhotoPath(id, file.sha256) : photoUrl.trim();
  if (!file) {
    const error = photoError(url, current, UPLOAD_PREFIX);
    if (error) return fail(error, { photoUrl: error });
  }
  const { photoFile: _old, ...rest } = current;
  const method: DepositMethod = { ...rest, photoUrl: url, ...(file ? { photoFile: file } : {}) };
  const next = changed(state, state.treasury.depositMethods.map(m => m.id === id ? method : m), by, now, `Deposit method ${current.name}: photo ${url ? 'changed' : 'removed'}.`);
  return { ok: true, id, message: url ? `${current.name} photo updated.` : `${current.name} photo removed; its first letter is shown instead.`, state: next };
}

/** Pending deposits keep their method name, receiving details, charge, and answers, so finance can still process them. */
export function deleteDepositMethod(state: DemoState, id: DepositMethodId, by: string, now: Date): Result {
  const current = state.treasury.depositMethods.find(m => m.id === id);
  if (!current) return fail(GONE);
  const pending = state.transactions.filter(t => t.type === 'Deposit' && t.status === 'Pending' && t.method === id).length;
  const next = changed(state, state.treasury.depositMethods.filter(m => m.id !== id), by, now, `Deleted deposit method ${current.name}.`);
  return {
    ok: true, id, state: next,
    message: `${current.name} deleted.${pending ? ` ${pending} pending deposit${pending === 1 ? '' : 's'} keep${pending === 1 ? 's' : ''} its details and can still be processed.` : ''}${noneLeft(next)}`,
  };
}

// ---------- Applicant ----------

export const enabledDepositMethods = (state: DemoState) => state.treasury.depositMethods.filter(m => m.enabled);
export const findDepositMethod = (state: DemoState, id: string | undefined) => state.treasury.depositMethods.find(m => m.id === id);
