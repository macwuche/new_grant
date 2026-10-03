import type { DemoState, DepositMethodId, DepositProof, Result, Transaction } from './model';
import { fail, nextIds, roundCents, usd } from './core';
import { alertIfHighRisk, logStaff } from './activity';
import { accountLockReason, permissionBlocker } from './applicants';
import { enabledDepositMethods, findDepositMethod } from './depositMethods';
import { channelFee } from './money';
import { notify } from './notifications';
import { ownTransactions } from './rules';
import { CURRENT_APPLICANT_ID } from './seed';
import { checkAnswers } from './withdrawalMethods';

// Deposits: the applicant chooses one of finance's deposit methods
// (./depositMethods), announces a transfer, fills in the method's form, and
// quotes a reference; they can upload proof of payment. Finance confirms it
// arrived (crediting the deposit balance, less the method's charge) or rejects
// it. Large deposits need a second staff member's approval before anyone else
// confirms them. No bank or mobile-money provider is connected, so nothing is
// detected automatically.

export const MIN_REJECTION_REASON_LENGTH = 10;
/** Velocity guard: how many unconfirmed deposits one applicant may have open. */
export const MAX_PENDING_DEPOSITS = 3;
/** Proof of payment: files per deposit, accepted types, and sizes (the preview keeps files in the browser, so they're small). */
export const MAX_PROOF_FILES = 5;
export const PROOF_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const MAX_PROOF_BYTES = 10 * 1024 * 1024;
export const MAX_PREVIEW_PROOF_BYTES = 400 * 1024;

const isDeposit = (tx: Transaction) => tx.type === 'Deposit';
/** The method's name as it was when the deposit was made (kept in the description, so it survives renames and deletes). */
export const depositMethodName = (tx: Pick<Transaction, 'description'>) => tx.description.replace(/^Deposit via /, '');

/** The method's charge on a deposit (the same formula as withdrawal charges). */
export const depositFee = (method: Parameters<typeof channelFee>[0], amount: number) => channelFee(method, amount);
/** What's credited when finance confirms: the amount less the charge it was quoted. */
export const depositCredit = (tx: Pick<Transaction, 'amount' | 'fee'>) => roundCents(tx.amount - (tx.fee ?? 0));

/** Four-eyes rule: deposits at or above the threshold (0 = never) need an approval from someone other than whoever confirms them. */
export const needsDepositSignOff = (state: DemoState, tx: Transaction) =>
  !!tx.dualControl || (state.treasury.depositDualControlThreshold > 0 && tx.amount >= state.treasury.depositDualControlThreshold);

/** Why the applicant can't add funds right now (independent of amount and method), or null. */
export function depositBlocker(state: DemoState): string | null {
  const locked = accountLockReason(state) ?? permissionBlocker(state, 'deposit');
  if (locked) return locked;
  if (!enabledDepositMethods(state).length) return 'Deposits are temporarily unavailable: no deposit method is available.';
  const open = ownTransactions(state).filter(t => isDeposit(t) && t.status === 'Pending').length;
  if (open >= MAX_PENDING_DEPOSITS) return `You already have ${open} deposits waiting to be confirmed. Cancel one or wait for finance to confirm them.`;
  return null;
}

/** Amount problems for a method (not the form), or null. */
export function validateDeposit(state: DemoState, amount: number, methodId: DepositMethodId): string | null {
  const method = findDepositMethod(state, methodId);
  if (!method || !method.enabled) return 'Choose an available deposit method.';
  const blocker = depositBlocker(state);
  if (blocker) return blocker;
  if (!Number.isFinite(amount) || amount <= 0) return 'Enter an amount to deposit.';
  if (roundCents(amount) !== amount) return 'Use at most two decimal places.';
  if (amount < method.min) return `The minimum for ${method.name} is ${usd(method.min)}.`;
  if (amount > method.max) return `The maximum for ${method.name} is ${usd(method.max)} per deposit.`;
  const fee = depositFee(method, amount);
  if (amount <= fee) return `The amount must be more than the ${usd(fee)} charge.`;
  return null;
}

export function requestDeposit(state: DemoState, amount: number, methodId: DepositMethodId, now: Date, answers: Record<string, string> = {}): Result {
  const error = validateDeposit(state, amount, methodId);
  if (error) return fail(error, { amount: error });
  const method = findDepositMethod(state, methodId)!;
  const checked = checkAnswers(method, answers);
  if ('errors' in checked) return fail(`Fix the highlighted ${method.formTitle ? method.formTitle.toLowerCase() : 'details'}.`, checked.errors);
  const ids = nextIds(state);
  const fee = depositFee(method, amount);
  const dual = state.treasury.depositDualControlThreshold > 0 && amount >= state.treasury.depositDualControlThreshold;
  const tx: Transaction = {
    id: ids.tx, applicantId: CURRENT_APPLICANT_ID, type: 'Deposit', description: `Deposit via ${method.name}`, amount, status: 'Pending', createdAt: now.toISOString(),
    method: method.id, reference: ids.reference, payTo: method.receivingDetails.map(d => ({ ...d })),
    ...(fee > 0 ? { fee } : {}),
    ...(checked.details.length ? { depositDetails: checked.details } : {}),
    ...(method.proof === 'required' ? { proofRequired: true } : {}),
    ...(dual ? { dualControl: true } : {}),
  };
  const highValue = amount >= state.treasury.highValueDeposit;
  const next = logStaff({ ...state, nextId: ids.nextId, transactions: [tx, ...state.transactions] }, {
    kind: 'deposit', highlight: highValue || dual,
    title: `${highValue ? 'High-value deposit' : 'Deposit'} announced: ${usd(amount)}${dual ? ' (needs two sign-offs)' : ''}`,
    body: `${state.profile.name} · ${method.name} · reference ${tx.reference}`, href: '/admin/deposits',
  }, now);
  const proofNote = method.proof === 'required' ? ' Upload your receipt on the Add funds page; finance needs it to confirm.' : '';
  const notified = notify(next, CURRENT_APPLICANT_ID, 'Deposit pending', `We're waiting for your ${usd(amount)} deposit by ${method.name}. Send it with reference ${tx.reference}; we'll let you know once finance confirms it arrived.${proofNote}`, '/deposits', now);
  return {
    ok: true, id: tx.id, state: alertIfHighRisk(state, notified, CURRENT_APPLICANT_ID, now),
    message: `Deposit ${tx.reference} recorded. Send ${usd(amount)} with that reference; ${fee > 0 ? `${usd(depositCredit(tx))} (after the ${usd(fee)} charge) is` : "it's"} added once finance confirms it arrived.`,
  };
}

export function cancelDeposit(state: DemoState, txId: string, now: Date): Result {
  const tx = ownTransactions(state).find(t => t.id === txId && isDeposit(t));
  if (!tx) return fail('That deposit could not be found.');
  if (tx.status !== 'Pending') return fail('Only deposits waiting for confirmation can be cancelled.');
  const cancelled: Transaction = { ...tx, status: 'Cancelled', processedAt: now.toISOString(), processedBy: 'Applicant' };
  const next = logStaff({ ...state, transactions: state.transactions.map(t => t.id === txId ? cancelled : t) }, {
    kind: 'deposit', title: `Deposit ${tx.reference ?? txId} cancelled`, body: `${state.profile.name} cancelled ${usd(tx.amount)}. Don't credit it if it arrives.`, href: '/admin/deposits',
  }, now);
  return { ok: true, id: txId, message: `Deposit ${tx.reference ?? txId} cancelled.`, state: next };
}

// ---------- Proof of payment (applicant) ----------

function ownPending(state: DemoState, txId: string): { ok: true; tx: Transaction } | { ok: false; result: Result } {
  const tx = ownTransactions(state).find(t => t.id === txId && isDeposit(t));
  if (!tx) return { ok: false, result: fail('That deposit could not be found.') };
  if (tx.status !== 'Pending') return { ok: false, result: fail('Proof of payment can only change while the deposit is waiting for confirmation.') };
  return { ok: true, tx };
}

/** Adds a receipt or screenshot (already checked and stored by the caller) to the applicant's pending deposit. */
export function attachDepositProof(state: DemoState, txId: string, proof: DepositProof, now: Date): Result {
  const locked = accountLockReason(state);
  if (locked) return fail(locked);
  const loaded = ownPending(state, txId);
  if (!loaded.ok) return loaded.result;
  const existing = loaded.tx.proof ?? [];
  if (existing.length >= MAX_PROOF_FILES) return fail(`Upload at most ${MAX_PROOF_FILES} files for one deposit. Remove one first.`);
  if (!(PROOF_TYPES as readonly string[]).includes(proof.contentType)) return fail('Upload a PDF, JPG, or PNG file.');
  const tx: Transaction = { ...loaded.tx, proof: [...existing, proof] };
  const next = logStaff(replace(state, tx), {
    kind: 'deposit', title: `Proof of payment for ${tx.reference ?? txId}`, body: `${state.profile.name} uploaded ${proof.fileName} for ${usd(tx.amount)}.`, href: '/admin/deposits',
  }, now);
  return { ok: true, id: proof.id, message: `${proof.fileName} added to deposit ${tx.reference ?? txId}. Finance will check it when they confirm your transfer.`, state: next };
}

export function removeDepositProof(state: DemoState, txId: string, proofId: string): Result {
  const loaded = ownPending(state, txId);
  if (!loaded.ok) return loaded.result;
  const file = loaded.tx.proof?.find(p => p.id === proofId);
  if (!file) return fail('That file could not be found.');
  const rest = loaded.tx.proof!.filter(p => p.id !== proofId);
  const { proof: _all, ...base } = loaded.tx;
  return { ok: true, id: proofId, message: `${file.fileName} removed.`, state: replace(state, rest.length ? { ...base, proof: rest } : base) };
}

// ---------- Finance ----------

/** Pending first (oldest first), then processed (newest first). */
export function depositQueue(state: DemoState): Transaction[] {
  const all = state.transactions.filter(isDeposit);
  const pending = all.filter(t => t.status === 'Pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const done = all.filter(t => t.status !== 'Pending').sort((a, b) => (b.processedAt ?? b.createdAt).localeCompare(a.processedAt ?? a.createdAt));
  return [...pending, ...done];
}

export const pendingDepositTotal = (state: DemoState) => roundCents(state.transactions.filter(t => isDeposit(t) && t.status === 'Pending').reduce((sum, t) => sum + t.amount, 0));

function loadPending(state: DemoState, txId: string): { ok: true; tx: Transaction } | { ok: false; result: Result } {
  const tx = state.transactions.find(t => t.id === txId);
  if (!tx || !isDeposit(tx)) return { ok: false, result: fail('That deposit could not be found.') };
  if (tx.status !== 'Pending') {
    const what = tx.status === 'Completed' ? 'confirmed' : tx.status === 'Cancelled' ? 'cancelled by the applicant' : 'rejected';
    return { ok: false, result: fail(`${tx.reference ?? txId} was already ${what}${tx.processedBy && tx.status !== 'Cancelled' ? ` by ${tx.processedBy}` : ''}.`) };
  }
  return { ok: true, tx };
}

const replace = (state: DemoState, tx: Transaction): DemoState => ({ ...state, transactions: state.transactions.map(t => t.id === tx.id ? tx : t) });
const waitingForProof = (tx: Transaction) => !!tx.proofRequired && !tx.proof?.length;
const proofMissing = (tx: Transaction) => `${tx.reference ?? tx.id} needs proof of payment from the applicant first. Reject it if the money didn't arrive.`;

/** Second sign-off on a large deposit. The approver can't also be the one who confirms it. */
export function approveDepositRelease(state: DemoState, txId: string, approver: string, now: Date): Result {
  const loaded = loadPending(state, txId);
  if (!loaded.ok) return loaded.result;
  const ref = loaded.tx.reference ?? txId;
  if (!needsDepositSignOff(state, loaded.tx)) return fail(`${ref} is below the ${usd(state.treasury.depositDualControlThreshold)} two-person threshold, so no second sign-off is needed.`);
  if (loaded.tx.releaseApproval) return fail(`${ref} was already approved by ${loaded.tx.releaseApproval.by}.`);
  if (waitingForProof(loaded.tx)) return fail(proofMissing(loaded.tx));
  const tx: Transaction = { ...loaded.tx, releaseApproval: { by: approver, at: now.toISOString() } };
  return { ok: true, id: txId, message: `${ref} approved. A different staff member with payment rights can now confirm it.`, state: replace(state, tx) };
}

/** Finance confirms the money arrived; only then does it count toward the deposit balance (less the method's charge). */
export function confirmDeposit(state: DemoState, txId: string, operator: string, now: Date): Result {
  const loaded = loadPending(state, txId);
  if (!loaded.ok) return loaded.result;
  const ref = loaded.tx.reference ?? txId;
  if (waitingForProof(loaded.tx)) return fail(proofMissing(loaded.tx));
  if (needsDepositSignOff(state, loaded.tx)) {
    const approval = loaded.tx.releaseApproval;
    if (!approval) return fail(`${ref} is ${usd(loaded.tx.amount)}, at or above the two-person threshold. It needs an approval from a second staff member (compliance or a super admin) before it can be confirmed.`);
    if (approval.by === operator) return fail(`You approved ${ref}, so a different staff member must confirm it.`);
  }
  const tx: Transaction = { ...loaded.tx, status: 'Completed', processedAt: now.toISOString(), processedBy: operator };
  const credit = depositCredit(tx);
  const charge = tx.fee ? ` after the ${usd(tx.fee)} charge` : '';
  const next = notify(replace(state, tx), tx.applicantId, 'Deposit received', `${usd(credit)} (${ref}) was added to your deposit balance${charge}.`, '/deposits', now);
  return { ok: true, id: txId, message: `${ref} confirmed. ${usd(credit)} credited to the applicant's deposit balance${charge}.`, state: next };
}

export function rejectDeposit(state: DemoState, txId: string, reason: string, operator: string, now: Date): Result {
  const text = reason.trim();
  if (text.length < MIN_REJECTION_REASON_LENGTH) return fail('Explain why the deposit was rejected.', { reason: `Write at least ${MIN_REJECTION_REASON_LENGTH} characters; the applicant sees this reason.` });
  const loaded = loadPending(state, txId);
  if (!loaded.ok) return loaded.result;
  const tx: Transaction = { ...loaded.tx, status: 'Failed', processedAt: now.toISOString(), processedBy: operator, failureReason: text };
  const next = notify(replace(state, tx), tx.applicantId, 'Deposit not credited', `${usd(tx.amount)} (${tx.reference}): ${text}`, '/deposits', now);
  return { ok: true, id: txId, message: `${tx.reference} rejected. The applicant has been told why.`, state: next };
}
