import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, DepositProof, Result } from './model';
import * as D from './deposits';
import * as DM from './depositMethods';
import { migrateState } from './migrate';
import { computeBalances, ownTransactions } from './rules';
import { createSeedState } from './seed';

const now = new Date('2026-09-30T12:00:00Z');
const FINANCE = 'Jordan Lee';
const COMPLIANCE = 'Sam Rivera';
let s: DemoState;

function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error} ${JSON.stringify(result.fieldErrors ?? {})}`);
  s = result.state;
  return result;
}
function refuse(result: Result, pattern?: RegExp): Result & { ok: false } {
  if (result.ok) throw new Error(`expected a refusal, got: ${result.message}`);
  if (pattern) expect(result.error).toMatch(pattern);
  return result;
}
const version = () => s.treasury.updatedAt;
const balances = () => computeBalances(ownTransactions(s));
const tx = (id: string) => s.transactions.find(t => t.id === id)!;

/** A PayPal-like deposit method with a charge, required proof, and a two-field form. */
const paypal = (patch: Partial<DM.DepositMethodInput> = {}): DM.DepositMethodInput => ({
  name: 'PayPal', enabled: true, min: 20, max: 1500, feeRate: 0.02, feeFixed: 1, feeCap: 0,
  processingTime: 'Within 24 hours', instructions: 'Send as "friends and family".', photoUrl: 'https://cdn.example.com/paypal.png',
  receivingDetails: [{ label: 'PayPal email', value: 'funds@novabridgegrant.org' }],
  proof: 'required', formTitle: 'Sender details',
  fields: [
    { label: 'Your PayPal email', type: 'email', required: true, placeholder: '', help: '', options: [] },
    { label: 'Note', type: 'textarea', required: false, placeholder: '', help: '', options: [] },
  ],
  ...patch,
});
const create = (patch: Partial<DM.DepositMethodInput> = {}) => accept(DM.createDepositMethod(s, version(), paypal(patch), FINANCE, now)).id!;
const proof = (id = 'a1b2c3d4-0000-4000-8000-000000000001'): DepositProof =>
  ({ id, fileName: 'receipt.png', contentType: 'image/png', sizeBytes: 2048, sha256: 'f'.repeat(64), uploadedAt: now.toISOString() });

beforeEach(() => { s = createSeedState(); });

describe('deposit methods: defaults and older settings', () => {
  it('starts with bank transfer and mobile money available and USDT hidden until a wallet is set', () => {
    expect(s.treasury.depositMethods.map(m => [m.id, m.enabled])).toEqual([['bank', true], ['mobile', true], ['crypto', false]]);
    const crypto = DM.findDepositMethod(s, 'crypto')!;
    expect(crypto.receivingDetails.map(d => d.label)).toEqual(['Network', 'Wallet address']);
    expect(crypto.fields.find(f => f.id === 'tx-hash')!.required).toBe(true);
    expect(DM.hasPlaceholderDetails(crypto)).toBe(true);
    expect(DM.enabledDepositMethods(s).map(m => m.id)).toEqual(['bank', 'mobile']);
  });

  it('gives older saved settings the built-in methods with their old deposit limits', () => {
    const { depositMethods: _m, depositDualControlThreshold: _t, ...old } = s.treasury;
    const upgraded = DM.normalizeTreasury({ ...old, minDeposit: 50, maxDeposit: 9000 });
    expect(upgraded.depositMethods.map(m => [m.id, m.min, m.max])).toEqual([['bank', 50, 9000], ['mobile', 50, 9000], ['crypto', 50, 9000]]);
    expect(upgraded.depositDualControlThreshold).toBe(old.dualControlThreshold);
    expect(upgraded).not.toHaveProperty('minDeposit');
    // A browser's saved preview state is upgraded the same way.
    const saved = JSON.parse(JSON.stringify({ ...s, treasury: { ...old, minDeposit: 50, maxDeposit: 9000 } }));
    expect(migrateState(saved)!.treasury.depositMethods).toHaveLength(3);
  });
});

describe('deposit methods: finance', () => {
  it('validates the name, limits, charges, receiving details, proof, and form', () => {
    expect(DM.validateDepositMethod(paypal(), s.treasury.depositMethods)).toEqual({});
    const errors = DM.validateDepositMethod(paypal({
      name: 'bank transfer', min: 50, max: 10, feeFixed: 60, processingTime: '', proof: 'maybe' as never,
      receivingDetails: [{ label: 'Wallet', value: '' }, { label: 'wallet', value: 'x'.repeat(301) }], formTitle: '',
      photoUrl: '/api/deposit-methods/other/photo?v=1',
    }), s.treasury.depositMethods);
    expect(errors).toMatchObject({
      name: 'Another deposit method already has this name.', max: 'Must be at least the minimum.', processingTime: expect.stringMatching(/how long/),
      proof: expect.any(String), 'receivingDetails.0.value': expect.any(String), 'receivingDetails.1.label': 'Two lines have this label.',
      formTitle: expect.stringMatching(/Name the form/), photoUrl: 'Upload the photo again or use a link.',
    });
    expect(DM.validateDepositMethod(paypal({ receivingDetails: [] }), []).receivingDetails).toMatch(/at least one line/);
    expect(DM.validateDepositMethod(paypal({ feeFixed: 20, feeRate: 0 }), []).feeFixed).toMatch(/smallest deposit would be all fee/);
  });

  it('adds, edits, hides, and deletes methods with a change log and stale-version checks', () => {
    const id = create();
    expect(id).toBe('paypal');
    expect(DM.findDepositMethod(s, id)!.fields.map(f => f.id)).toEqual(['your-paypal-email', 'note']);
    expect(s.treasury.changeLog.at(-1)).toMatchObject({ by: FINANCE, summary: 'Added deposit method PayPal.' });

    const stale = '2020-01-01T00:00:00.000Z';
    refuse(DM.updateDepositMethod(s, stale, id, paypal({ min: 30 }), FINANCE, now), /changed since you opened them/);
    refuse(DM.updateDepositMethod(s, version(), id, paypal(), FINANCE, now), /Nothing has changed/);
    accept(DM.updateDepositMethod(s, version(), id, paypal({ min: 30, receivingDetails: [{ label: 'PayPal email', value: 'pay@novabridgegrant.org' }], proof: 'optional' }), FINANCE, now));
    expect(s.treasury.changeLog.at(-1)!.summary).toBe('Deposit method PayPal: limits, receiving details, proof of payment optional.');

    const hidden = accept(DM.setDepositMethodAvailability(s, id, false, FINANCE, now));
    expect(hidden.message).toMatch(/hidden from users/);
    refuse(DM.setDepositMethodAvailability(s, id, false, FINANCE, now), /already unavailable/);
    accept(DM.setDepositMethodAvailability(s, 'bank', false, FINANCE, now));
    expect(accept(DM.setDepositMethodAvailability(s, 'mobile', false, FINANCE, now)).message).toMatch(/users cannot add funds/);
    expect(D.depositBlocker(s)).toMatch(/no deposit method is available/);

    accept(DM.deleteDepositMethod(s, id, FINANCE, now));
    expect(DM.findDepositMethod(s, id)).toBeUndefined();
    refuse(DM.deleteDepositMethod(s, id, FINANCE, now), /no longer exists/);
  });

  it('sets an uploaded photo by its hash and drops the file record when the photo changes to a link', () => {
    const file = { key: 'k/1', contentType: 'image/png', sha256: 'a'.repeat(64) };
    accept(DM.setDepositMethodPhoto(s, 'bank', '', file, FINANCE, now));
    expect(DM.findDepositMethod(s, 'bank')).toMatchObject({ photoUrl: DM.depositMethodPhotoPath('bank', file.sha256), photoFile: file });
    const current = DM.findDepositMethod(s, 'bank')!;
    const { id: _id, photoFile: _f, ...input } = current;
    accept(DM.updateDepositMethod(s, version(), 'bank', { ...input, photoUrl: 'https://cdn.example.com/bank.png' }, FINANCE, now));
    expect(DM.findDepositMethod(s, 'bank')!.photoFile).toBeUndefined();
    refuse(DM.setDepositMethodPhoto(s, 'bank', 'http://insecure.example.com/x.png', null, FINANCE, now), /https/);
  });

  it('keeps pending deposits processable after their method is deleted', () => {
    const { id } = accept(D.requestDeposit(s, 100, 'mobile', now));
    expect(accept(DM.deleteDepositMethod(s, 'mobile', FINANCE, now)).message).toMatch(/1 pending deposit keeps its details/);
    expect(tx(id!).payTo![0]!.label).toBe('Mobile money number');
    accept(D.confirmDeposit(s, id!, FINANCE, now));
  });
});

describe('deposits through a method', () => {
  it('uses the form, keeps the receiving details it was given, and credits the amount less the charge', () => {
    const method = create({ proof: 'optional' });
    refuse(D.requestDeposit(s, 10, method, now, {}), /minimum for PayPal is \$20/);
    const bad = refuse(D.requestDeposit(s, 100, method, now, { 'your-paypal-email': 'nope' }));
    expect(bad.fieldErrors).toEqual({ 'details.your-paypal-email': 'Enter a valid email address.' });
    const before = balances().deposit;
    const { id } = accept(D.requestDeposit(s, 100, method, now, { 'your-paypal-email': 'alex@example.com' }));
    expect(tx(id!)).toMatchObject({ amount: 100, fee: 3, method, payTo: [{ label: 'PayPal email', value: 'funds@novabridgegrant.org' }], depositDetails: [{ fieldId: 'your-paypal-email', value: 'alex@example.com' }] });
    expect(tx(id!).proofRequired).toBeUndefined();

    // Finance changes the receiving details afterwards: the pending deposit keeps what the applicant was told.
    const { id: _i, photoFile: _p, ...input } = DM.findDepositMethod(s, method)!;
    accept(DM.updateDepositMethod(s, version(), method, { ...input, receivingDetails: [{ label: 'PayPal email', value: 'new@novabridgegrant.org' }] }, FINANCE, now));
    expect(tx(id!).payTo![0]!.value).toBe('funds@novabridgegrant.org');

    const confirmed = accept(D.confirmDeposit(s, id!, FINANCE, now));
    expect(confirmed.message).toMatch(/\$97\.00 credited .* after the \$3\.00 charge/);
    expect(balances().deposit).toBe(before + 97);
    expect(s.notifications[0]!.body).toMatch(/\$97\.00 .* after the \$3\.00 charge/);
  });

  it('needs proof of payment before confirming when the method requires it; the applicant can add and remove files', () => {
    const method = create();
    const { id } = accept(D.requestDeposit(s, 100, method, now, { 'your-paypal-email': 'alex@example.com' }));
    expect(tx(id!).proofRequired).toBe(true);
    refuse(D.confirmDeposit(s, id!, FINANCE, now), /needs proof of payment/);

    accept(D.attachDepositProof(s, id!, proof(), now));
    expect(s.staffFeed[0]!.title).toMatch(/Proof of payment/);
    refuse(D.attachDepositProof(s, id!, { ...proof('x'), contentType: 'text/html' }, now), /PDF, JPG, or PNG/);
    accept(D.removeDepositProof(s, id!, proof().id));
    expect(tx(id!).proof).toBeUndefined();
    refuse(D.removeDepositProof(s, id!, 'missing'), /could not be found/);

    for (let i = 0; i < D.MAX_PROOF_FILES; i++) accept(D.attachDepositProof(s, id!, proof(`p${i}`), now));
    refuse(D.attachDepositProof(s, id!, proof('extra'), now), /at most 5 files/);
    accept(D.confirmDeposit(s, id!, FINANCE, now));
    refuse(D.attachDepositProof(s, id!, proof('late'), now), /only change while the deposit is waiting/);
  });

  it('rejects without proof, and another applicant cannot add proof', () => {
    const method = create();
    const { id } = accept(D.requestDeposit(s, 100, method, now, { 'your-paypal-email': 'alex@example.com' }));
    const other = s.transactions.find(t => t.type === 'Deposit' && t.applicantId !== ownTransactions(s)[0]!.applicantId);
    if (other) refuse(D.attachDepositProof(s, other.id, proof(), now), /could not be found/);
    accept(D.rejectDeposit(s, id!, 'No transfer arrived within 5 days.', FINANCE, now));
  });

  it('needs two different staff members at or above the deposit threshold, and none when it is 0', () => {
    const { id } = accept(D.requestDeposit(s, 3000, 'bank', now));
    expect(tx(id!).dualControl).toBe(true);
    expect(s.staffFeed[0]!.title).toMatch(/needs two sign-offs/);
    refuse(D.confirmDeposit(s, id!, FINANCE, now), /needs an approval from a second staff member/);
    accept(D.approveDepositRelease(s, id!, COMPLIANCE, now));
    refuse(D.approveDepositRelease(s, id!, FINANCE, now), /already approved by Sam Rivera/);
    refuse(D.confirmDeposit(s, id!, COMPLIANCE, now), /different staff member must confirm/);
    accept(D.confirmDeposit(s, id!, FINANCE, now));

    const { id: small } = accept(D.requestDeposit(s, 100, 'bank', now));
    refuse(D.approveDepositRelease(s, small!, COMPLIANCE, now), /below the \$2,500\.00 two-person threshold/);

    s = { ...s, treasury: { ...s.treasury, depositDualControlThreshold: 0 } };
    const { id: big } = accept(D.requestDeposit(s, 5000, 'bank', now));
    expect(tx(big!).dualControl).toBeUndefined();
    accept(D.confirmDeposit(s, big!, FINANCE, now));
  });
});
