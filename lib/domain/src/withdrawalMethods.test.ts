import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result } from './model';
import * as M from './money';
import * as P from './payouts';
import { computeBalances, ownTransactions } from './rules';
import { CURRENT_APPLICANT_ID, createSeedState } from './seed';
import * as W from './withdrawalMethods';

const now = new Date('2026-09-29T12:00:00Z');
const FINANCE = 'Jordan Lee';
let s: DemoState;

function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error} ${JSON.stringify(result.fieldErrors ?? {})}`);
  s = result.state;
  return result;
}
function refuse(result: Result): Result & { ok: false } {
  if (result.ok) throw new Error(`expected a refusal, got: ${result.message}`);
  return result;
}
const version = () => s.treasury.updatedAt;
const balances = () => computeBalances(ownTransactions(s));

/** A PayPal-like method: email (required), a dropdown, a number, and an optional note; both balances. */
const paypal = (patch: Partial<W.MethodInput> = {}): W.MethodInput => ({
  name: 'PayPal', enabled: true, min: 20, max: 1500, feeRate: 0.02, feeFixed: 1, feeCap: 0,
  processingTime: 'Within 24 hours', instructions: 'Use the email of a verified PayPal account.', photoUrl: 'https://cdn.example.com/paypal.png', source: 'both',
  formTitle: 'PayPal account',
  fields: [
    { label: 'PayPal email', type: 'email', required: true, placeholder: 'you@example.com', help: '', options: [] },
    { label: 'Account type', type: 'select', required: true, placeholder: '', help: 'Business accounts may take longer.', options: ['Personal', 'Business'] },
    { label: 'Phone digits', type: 'number', required: false, placeholder: '', help: '', options: [] },
    { label: 'Withdrawal note', type: 'textarea', required: false, placeholder: '', help: '', options: [] },
  ],
  ...patch,
});
const answers = { 'paypal-email': 'alex@example.com', 'account-type': 'Personal' };
const create = (patch: Partial<W.MethodInput> = {}) => accept(W.createMethod(s, version(), paypal(patch), FINANCE, now)).id!;

beforeEach(() => { s = createSeedState(); });

describe('withdrawal methods: validation', () => {
  it('accepts a complete method and gives fields ids from their labels', () => {
    expect(W.validateMethod(paypal(), s.treasury.channels)).toEqual({});
    const id = create();
    expect(id).toBe('paypal');
    expect(M.findChannel(s, id)!.fields.map(f => f.id)).toEqual(['paypal-email', 'account-type', 'phone-digits', 'withdrawal-note']);
  });

  it('checks the name, photo link, limits, charges, processing time, balance, and form', () => {
    const errors = W.validateMethod(paypal({
      name: 'bank TRANSFER', photoUrl: 'http://cdn.example.com/x.png', min: 50, max: 10, feeRate: 0.5, feeFixed: 60, feeCap: 5,
      processingTime: ' ', source: 'savings' as never, formTitle: '',
    }), s.treasury.channels);
    expect(errors).toMatchObject({
      name: 'Another method already has this name.', photoUrl: 'Use a secure link (https://).', max: 'Must be at least the minimum.',
      feeRate: 'Use 0–10%.', processingTime: expect.stringMatching(/how long/), source: expect.any(String), formTitle: expect.stringMatching(/Name the form/),
    });
    expect(W.validateMethod(paypal({ feeFixed: 20, feeCap: 0 }), []).feeFixed).toMatch(/below the minimum/);
    expect(W.validateMethod(paypal({ feeFixed: 5, feeCap: 2 }), []).feeCap).toMatch(/at least the fixed charge/);
    expect(W.validateMethod(paypal({ photoUrl: 'javascript:alert(1)' }), []).photoUrl).toMatch(/https/);
    expect(W.validateMethod(paypal({ photoUrl: 'https://x.example.com/a b.png' }), []).photoUrl).toMatch(/https/);
    expect(W.validateMethod(paypal({ photoUrl: '/api/withdrawal-methods/paypal/photo?v=abc' }), []).photoUrl).toMatch(/Upload the photo again/);
    expect(W.validateMethod(paypal({ photoUrl: 'data:image/png;base64,iVBORw0KGgo=' }), [])).toEqual({});
    expect(W.validateMethod(paypal({ photoUrl: '' }), [])).toEqual({});
  });

  it('checks each form field: label, duplicates, dropdown choices, and the field limit', () => {
    const base = paypal().fields;
    const errors = W.validateMethod(paypal({ fields: [{ ...base[0]!, label: 'x' }, { ...base[1]!, options: ['Only one'] }, { ...base[2]!, label: 'Account type' }, { ...base[3]!, options: [] }] }), []);
    expect(errors).toEqual({ 'fields.0.label': 'Use 2–60 characters.', 'fields.1.options': 'Add at least two choices.', 'fields.2.label': 'Two fields have this label.' });
    expect(W.validateMethod(paypal({ fields: [{ ...base[1]!, options: ['A', 'a'] }] }), [])['fields.0.options']).toMatch(/different/);
    expect(W.validateMethod(paypal({ fields: Array.from({ length: 13 }, (_, i) => ({ ...base[0]!, label: `Field ${i}` })) }), []).fields).toMatch(/up to 12/);
    // A method without a form doesn't need a form name.
    expect(W.validateMethod(paypal({ fields: [], formTitle: '' }), [])).toEqual({});
  });

  it('fills in what older saved settings lack, and shows the first letter without a photo', () => {
    const legacy = W.normalizeMethod({ id: 'crypto', name: 'USDT wallet', enabled: true, min: 50, max: 100, feeRate: 0, feeFixed: 0, feeCap: 0 });
    expect(legacy).toMatchObject({ source: 'grant', photoUrl: '', formTitle: 'Wallet details', processingTime: '1–24 hours' });
    expect(legacy.fields.map(f => f.id)).toEqual(['wallet', 'note']);
    expect(W.methodInitial('  itransfer')).toBe('I');
    expect(W.methodInitial('₿ bitcoin')).toBe('B');
  });
});

describe('withdrawal methods: finance manages them', () => {
  it('creates a method, logs it, and refuses a stale version', () => {
    const before = version();
    create();
    expect(s.treasury.changeLog.at(-1)).toMatchObject({ by: FINANCE, summary: 'Added withdrawal method PayPal.' });
    expect(M.enabledChannels(s).map(c => c.id)).toContain('paypal');
    expect(refuse(W.createMethod(s, before, paypal({ name: 'Skrill' }), FINANCE, now)).error).toMatch(/changed since you opened/);
    // Same name again gets a different id only if renamed; a duplicate name is refused.
    expect(refuse(W.createMethod(s, version(), paypal(), FINANCE, now)).fieldErrors?.name).toMatch(/already has this name/);
  });

  it('keeps an unavailable new method hidden from applicants', () => {
    const id = create({ enabled: false });
    expect(M.enabledChannels(s).map(c => c.id)).not.toContain(id);
    expect(M.validateWithdrawal(s, 50, id, 'grant')).toMatch(/available withdrawal method/);
  });

  it('edits a method, keeping field ids, and says what changed', () => {
    const id = create();
    const edited = paypal({ max: 2000, fields: M.findChannel(s, id)!.fields.map(f => f.id === 'paypal-email' ? { ...f, label: 'Email on PayPal' } : f) });
    accept(W.updateMethod(s, version(), id, edited, FINANCE, now));
    expect(M.findChannel(s, id)!.fields[0]).toMatchObject({ id: 'paypal-email', label: 'Email on PayPal' });
    expect(s.treasury.changeLog.at(-1)!.summary).toBe('Withdrawal method PayPal: limits, form.');
    expect(refuse(W.updateMethod(s, version(), id, edited, FINANCE, now)).error).toBe('Nothing has changed.');
    expect(refuse(W.updateMethod(s, '2020-01-01T00:00:00.000Z', id, paypal(), FINANCE, now)).error).toMatch(/changed since/);
    expect(refuse(W.updateMethod(s, version(), 'nope', paypal(), FINANCE, now)).error).toMatch(/no longer exists/);
  });

  it('makes a method unavailable and available again, warning when none is left', () => {
    for (const c of s.treasury.channels.filter(c => c.enabled)) accept(W.setMethodAvailability(s, c.id, false, FINANCE, now));
    expect(s.treasury.changeLog.at(-1)!.summary).toMatch(/made unavailable/);
    expect(M.payoutBlocker(s)).toMatch(/no withdrawal method is available/);
    expect(refuse(W.setMethodAvailability(s, 'bank', false, FINANCE, now)).error).toMatch(/already unavailable/);
    const back = accept(W.setMethodAvailability(s, 'bank', true, FINANCE, now));
    expect(back.message).toMatch(/available to users/);
    expect(M.payoutBlocker(s)).toBeNull();
  });

  it('sets, uploads, and removes a photo; an upload stays only while its path is the photo', () => {
    const id = create();
    const file = { key: 'methods/paypal/abc', contentType: 'image/png', sha256: 'a'.repeat(64) };
    accept(W.setMethodPhoto(s, id, '', file, FINANCE, now));
    expect(M.findChannel(s, id)).toMatchObject({ photoUrl: W.methodPhotoPath(id, file.sha256), photoFile: file });
    // Saving the method unchanged keeps the upload; switching to a link drops it.
    accept(W.updateMethod(s, version(), id, { ...paypal(), photoUrl: M.findChannel(s, id)!.photoUrl, max: 1400 }, FINANCE, now));
    expect(M.findChannel(s, id)!.photoFile).toEqual(file);
    accept(W.updateMethod(s, version(), id, { ...paypal(), photoUrl: 'https://cdn.example.com/new.png', max: 1400 }, FINANCE, now));
    expect(M.findChannel(s, id)!.photoFile).toBeUndefined();
    accept(W.setMethodPhoto(s, id, '', null, FINANCE, now));
    expect(M.findChannel(s, id)!.photoUrl).toBe('');
    expect(refuse(W.setMethodPhoto(s, id, 'http://x.example.com/a.png', null, FINANCE, now)).fieldErrors?.photoUrl).toMatch(/https/);
  });

  it('deletes a method; its pending requests keep their details and can still be paid', () => {
    const id = create();
    const txId = accept(M.requestWithdrawal(s, { amount: 100, method: id, source: 'grant', details: answers }, now)).id!;
    const result = accept(W.deleteMethod(s, id, FINANCE, now));
    expect(result.message).toMatch(/1 pending request keeps its details/);
    expect(M.findChannel(s, id)).toBeUndefined();
    const tx = s.transactions.find(t => t.id === txId)!;
    expect(tx).toMatchObject({ description: 'Payout to PayPal', status: 'Pending', payoutDetails: [{ fieldId: 'paypal-email', label: 'PayPal email', value: 'alex@example.com' }, { fieldId: 'account-type', label: 'Account type', value: 'Personal' }] });
    accept(P.markPayoutPaid(s, txId, FINANCE, now));
    expect(refuse(W.deleteMethod(s, id, FINANCE, now)).error).toMatch(/no longer exists/);
  });
});

describe('withdrawal methods: applicants request with the form', () => {
  it("checks the form's answers: required, email, number, and dropdown", () => {
    const id = create();
    const bad = refuse(M.requestWithdrawal(s, { amount: 100, method: id, source: 'grant', details: { 'paypal-email': 'not-an-email', 'account-type': 'Savings', 'phone-digits': '12a' } }, now));
    expect(bad.fieldErrors).toEqual({ 'details.paypal-email': 'Enter a valid email address.', 'details.account-type': 'Choose one of the options.', 'details.phone-digits': 'Enter a number.' });
    const missing = refuse(M.requestWithdrawal(s, { amount: 100, method: id, source: 'grant', details: {} }, now));
    expect(missing.fieldErrors).toEqual({ 'details.paypal-email': 'PayPal email is required.', 'details.account-type': 'Account type is required.' });
    expect(refuse(M.requestWithdrawal(s, { amount: 100, method: id, source: 'grant', details: { ...answers, 'withdrawal-note': 'x'.repeat(1001) } }, now)).fieldErrors).toEqual({ 'details.withdrawal-note': 'Up to 1000 characters.' });
    // Unknown keys are ignored; optional answers are kept when given.
    const txId = accept(M.requestWithdrawal(s, { amount: 100, method: id, source: 'grant', details: { ...answers, 'phone-digits': '0803', extra: 'ignored' } }, now)).id!;
    expect(s.transactions.find(t => t.id === txId)!.payoutDetails!.map(d => d.fieldId)).toEqual(['paypal-email', 'account-type', 'phone-digits']);
  });

  it('pays out from the balance the method allows; with both, the applicant chooses', () => {
    const both = create();
    expect(M.validateWithdrawal(s, 100, both)).toMatch(/Choose the balance/);
    const grantOnly = s.treasury.channels.find(c => c.id === 'bank')!;
    expect(M.validateWithdrawal(s, 100, grantOnly.id, 'deposit')).toMatch(/grant balance only/);
    expect(M.validateWithdrawal(s, 100, grantOnly.id)).toBeNull();
    const depositOnly = create({ name: 'Skrill', source: 'deposit' });
    expect(M.validateWithdrawal(s, 100, depositOnly, 'grant')).toMatch(/deposit balance only/);
  });

  it('keeps the reserve in the deposit balance, and moves money from the chosen balance', () => {
    const id = create();
    const start = balances();
    const reserve = s.treasury.depositThreshold;
    expect(M.availableFor(s, 'deposit')).toBe(start.deposit - reserve);
    expect(M.validateWithdrawal(s, start.deposit - reserve + 1, id, 'deposit')).toMatch(/reserve stays in it/);
    const txId = accept(M.requestWithdrawal(s, { amount: 100, method: id, source: 'deposit', details: answers }, now)).id!;
    expect(balances()).toMatchObject({ deposit: start.deposit - 100, grant: start.grant, pendingWithdrawals: start.pendingWithdrawals });
    expect(s.transactions.find(t => t.id === txId)).toMatchObject({ source: 'deposit', fee: 3, destination: 'PayPal · alex@example.com' });
    const cancelled = accept(M.cancelWithdrawal(s, txId, now));
    expect(cancelled.message).toMatch(/back in your deposit balance/);
    expect(balances().deposit).toBe(start.deposit);
    const again = accept(M.requestWithdrawal(s, { amount: 100, method: id, source: 'deposit', details: answers }, now)).id!;
    const failed = accept(P.markPayoutFailed(s, again, 'The PayPal account rejected the transfer.', FINANCE, now));
    expect(failed.message).toMatch(/deposit balance/);
    expect(s.notifications[0]!.body).toMatch(/back in your deposit balance/);
    expect(balances().deposit).toBe(start.deposit);
  });

  it('remembers the answers per method and flags a change as a risk signal', () => {
    const id = create();
    accept(M.requestWithdrawal(s, { amount: 50, method: id, source: 'grant', details: answers }, now));
    expect(s.savedPayoutDetails[id]).toEqual(answers);
    const flaggedAt = s.accounts[CURRENT_APPLICANT_ID]!.destinationChangedAt;
    expect(flaggedAt).toBe(now.toISOString());
    const later = new Date('2026-09-30T12:00:00Z');
    accept(M.requestWithdrawal(s, { amount: 50, method: id, source: 'grant', details: answers }, later));
    expect(s.accounts[CURRENT_APPLICANT_ID]!.destinationChangedAt).toBe(flaggedAt); // unchanged answers: no new signal
    accept(M.requestWithdrawal(s, { amount: 50, method: id, source: 'grant', details: { ...answers, 'paypal-email': 'new@example.com' } }, later));
    expect(s.accounts[CURRENT_APPLICANT_ID]!.destinationChangedAt).toBe(later.toISOString());
    expect(s.staffFeed.find(e => e.kind === 'account')).toMatchObject({ title: 'Payout details changed' });
  });

  it('charges: a maximum of 0 means no maximum, and the fee is quoted at request time', () => {
    const id = create();
    expect(M.channelFee(M.findChannel(s, id)!, 1000)).toBe(21); // $1 + 2% with no maximum
    expect(M.channelFee({ feeFixed: 1, feeRate: 0.02, feeCap: 10 }, 1000)).toBe(10);
    expect(W.chargesLabel(M.findChannel(s, id)!)).toBe('$1.00 + 2%');
    expect(W.chargesLabel({ feeFixed: 0, feeRate: 0.0125, feeCap: 14 })).toBe('1.25% (max $14.00)');
    expect(W.chargesLabel({ feeFixed: 0, feeRate: 0, feeCap: 0 })).toBe('No charge');
  });
});
