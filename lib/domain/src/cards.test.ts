import { beforeEach, describe, expect, it } from 'vitest';
import type { DemoState, Result } from './model';
import * as C from './cards';
import * as R from './rules';
import { lockAccount } from './accounts';
import { ALWAYS_EMAILED_TITLES } from './notifications';
import { startLockdown } from './security';
import { createSeedState, CURRENT_APPLICANT_ID } from './seed';

const now = new Date('2026-09-27T12:00:00Z');
const address = { name: 'Alex Morgan', line1: ' 1 Main St ', line2: '', city: 'Austin', region: 'TX', postalCode: '73301', country: 'United States' };
const message = 'Your card is on its way with DHL: https://dhl.example/track/4471';

let s: DemoState;
const balances = () => R.computeBalances(R.ownTransactions(s));
const physical = () => s.cards.physical;
const lastNotice = () => s.notifications[0]!;
function accept(result: Result): Result & { ok: true } {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  s = result.state;
  return result;
}
function refuse(result: Result, pattern: RegExp) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatch(pattern);
}
const withoutVirtual = () => { s = { ...s, cards: { ...s.cards, virtual: null } }; };
const settings = (funding: 'deposit' | 'grant' | 'both', kycRequired = false) => accept(C.setCardSettings(s, CURRENT_APPLICANT_ID, { funding, kycRequired }, now));

beforeEach(() => { s = createSeedState(); });

describe('virtual card first', () => {
  it('lets the applicant or staff create the virtual card, once', () => {
    withoutVirtual();
    refuse(C.fundCard(s, 10, 'deposit', now), /virtual card first/);
    refuse(C.requestPhysicalCard(s, address, now), /virtual card first/);
    refuse(C.staffIssuePhysicalCard(s, address, '1234', message, '', 'Fin Ops', now), /virtual card/);
    accept(C.createVirtualCard(s, '4321', '0000', now));
    expect(s.cards.virtual).toMatchObject({ lastFour: '4321', frozen: false, dailyLimit: 500 });
    refuse(C.createVirtualCard(s, '1111', '0000', now), /already have/);
    withoutVirtual();
    accept(C.staffCreateVirtualCard(s, '9876', '1111', 'Fin Ops', now));
    expect(s.cards.virtual).toMatchObject({ lastFour: '9876', createdBy: 'Fin Ops' });
  });

  it('needs a verified identity when staff require it, except for staff themselves', () => {
    withoutVirtual();
    s = { ...s, profile: { ...s.profile, identityVerified: false } };
    settings('deposit', true);
    refuse(C.createVirtualCard(s, '4321', '0000', now), /Verify your identity/);
    accept(C.staffCreateVirtualCard(s, '4321', '0000', 'Fin Ops', now));
    refuse(C.requestPhysicalCard(s, address, now), /Verify your identity/);
  });
});

describe('card balance', () => {
  it('funds from the allowed balance only, keeping the deposit reserve', () => {
    const start = balances();
    refuse(C.fundCard(s, 10, 'grant', now), /deposit balance only/);
    refuse(C.fundCard(s, start.deposit, 'deposit', now), /up to \$416\.50.*reserve/);
    accept(C.fundCard(s, 100, 'deposit', now));
    expect(balances()).toMatchObject({ card: 100, deposit: start.deposit - 100, grant: start.grant });
    expect(s.transactions[0]).toMatchObject({ type: 'Card top-up', amount: 100, counterpart: 'deposit' });
    settings('both');
    accept(C.fundCard(s, 50, 'grant', now));
    expect(balances()).toMatchObject({ card: 150, grant: start.grant - 50 });
    settings('grant');
    refuse(C.fundCard(s, 10, 'deposit', now), /grant balance only/);
  });

  it('refuses funding while locked or during a lockdown', () => {
    accept(startLockdown(s, 'Suspected account takeover', 'Sam', now));
    refuse(C.fundCard(s, 10, 'deposit', now), /paused|lockdown/i);
    s = createSeedState();
    accept(lockAccount(s, CURRENT_APPLICANT_ID, 'Fraud investigation underway', 'Compliance', now));
    refuse(C.fundCard(s, 10, 'deposit', now), /locked/i);
  });

  it('lets staff fund from a balance or without one, with a reason the applicant sees', () => {
    const start = balances();
    refuse(C.staffFundCard(s, 50, 'none', 'short', 'Fin Ops', now), /Explain/);
    refuse(C.staffFundCard(s, start.grant + 1, 'grant', 'Moving the award onto the card', 'Fin Ops', now), /grant balance holds/);
    accept(C.staffFundCard(s, 75, 'none', 'Goodwill credit for the delay', 'Fin Ops', now));
    expect(balances()).toMatchObject({ card: 75, deposit: start.deposit, grant: start.grant });
    expect(s.transactions[0]).toMatchObject({ counterpart: 'none', processedBy: 'Fin Ops', note: 'Goodwill credit for the delay' });
    expect(lastNotice().body).toContain('Goodwill credit for the delay');
    // Staff aren't held to the reserve or the applicant's funding setting.
    accept(C.staffFundCard(s, start.deposit, 'deposit', 'Moving the whole deposit onto the card', 'Fin Ops', now));
    expect(balances().deposit).toBe(0);
  });

  it('lets staff deduct back to a balance or out of the account', () => {
    const start = balances();
    accept(C.staffFundCard(s, 200, 'none', 'Goodwill credit for the delay', 'Fin Ops', now));
    refuse(C.staffDeductCard(s, 201, 'none', 'Correction of a duplicate credit', 'Fin Ops', now), /holds \$200\.00/);
    accept(C.staffDeductCard(s, 50, 'grant', 'Returning unused card money', 'Fin Ops', now));
    expect(balances()).toMatchObject({ card: 150, grant: start.grant + 50 });
    accept(C.staffDeductCard(s, 100, 'none', 'Correction of a duplicate credit', 'Fin Ops', now));
    expect(balances()).toMatchObject({ card: 50, grant: start.grant + 50, deposit: start.deposit });
    expect(s.transactions[0]).toMatchObject({ type: 'Card deduction', amount: -100, counterpart: 'none' });
    expect(lastNotice().title).toBe('Card balance reduced');
  });
});

describe('physical card applications', () => {
  it('applies with an address and fee, then staff approve with a message that is always emailed', () => {
    refuse(C.requestPhysicalCard(s, { ...address, city: '' }, now), /shipping address/);
    const before = balances().deposit;
    accept(C.requestPhysicalCard(s, address, now));
    expect(physical()).toMatchObject({ status: 'Requested', shippingAddress: { line1: '1 Main St', region: 'TX' } });
    expect(physical().shippingAddress!.line2).toBeUndefined();
    expect(balances().deposit).toBe(before - 12);
    expect(lastNotice().title).toBe('Physical card application received');
    expect(lastNotice().body).toMatch(/We'll email you when your card ships/);
    expect(s.staffFeed[0]).toMatchObject({ kind: 'card', highlight: true, title: 'Physical card application' });

    refuse(C.approvePhysicalCard(s, '7310', 'too short', '', 'Fin Ops', now), /message/);
    accept(C.approvePhysicalCard(s, '7310', message, 'DHL 4471', 'Fin Ops', now));
    expect(physical()).toMatchObject({ status: 'Shipped', lastFour: '7310', shippingMessage: message, trackingRef: 'DHL 4471', shippedBy: 'Fin Ops' });
    expect(lastNotice()).toMatchObject({ title: 'Your physical card is on its way', body: message });
    expect(ALWAYS_EMAILED_TITLES.has(lastNotice().title)).toBe(true);
    refuse(C.approvePhysicalCard(s, '7310', message, '', 'Fin Ops', now), /already approved by Fin Ops/);

    refuse(C.activatePhysicalCard(s, '0000', now), /don't match/);
    accept(C.activatePhysicalCard(s, '7310', now));
    expect(physical().status).toBe('Active');
  });

  it('refunds the fee when declined, and lets the applicant apply again', () => {
    const before = balances().deposit;
    accept(C.requestPhysicalCard(s, address, now));
    refuse(C.cancelPhysicalCard(s, 'Address could not be verified', 'Fin Ops', now), /Decline the application instead/);
    accept(C.declinePhysicalCard(s, 'Address could not be verified', 'Fin Ops', now));
    expect(balances().deposit).toBe(before);
    expect(physical()).toMatchObject({ status: 'Declined', declineReason: 'Address could not be verified' });
    expect(lastNotice().title).toBe('Physical card application declined');
    expect(ALWAYS_EMAILED_TITLES.has(lastNotice().title)).toBe(true);
    accept(C.requestPhysicalCard(s, address, now));
    expect(physical().status).toBe('Requested');
  });

  it('lets staff issue a card directly, without a fee', () => {
    const before = balances().deposit;
    accept(C.staffIssuePhysicalCard(s, address, '5555', message, '', 'Fin Ops', now));
    expect(physical()).toMatchObject({ status: 'Shipped', issuedBy: 'Fin Ops', lastFour: '5555' });
    expect(balances().deposit).toBe(before);
    refuse(C.staffIssuePhysicalCard(s, address, '5555', message, '', 'Fin Ops', now), /already has/);
  });

  it('cancels shipped or active cards without a refund, keeping the card balance', () => {
    accept(C.staffFundCard(s, 40, 'none', 'Goodwill credit for the delay', 'Fin Ops', now));
    accept(C.staffIssuePhysicalCard(s, address, '5555', message, '', 'Fin Ops', now));
    accept(C.cancelPhysicalCard(s, 'Reported lost by the applicant', 'Fin Ops', now));
    expect(physical().status).toBe('Cancelled');
    expect(balances().card).toBe(40);
    accept(C.requestPhysicalCard(s, address, now));
  });
});

describe('freezing', () => {
  it("shows the staff note when the applicant tries to lift a staff freeze", () => {
    refuse(C.staffSetCardFreeze(s, 'virtual', true, 'too short', now), /note/);
    accept(C.staffSetCardFreeze(s, 'virtual', true, 'Unusual activity on the card', now));
    expect(s.cards.virtual).toMatchObject({ frozen: true, frozenBy: 'staff', frozenReason: 'Unusual activity on the card' });
    refuse(C.toggleCardFreeze(s, now), /froze this card: Unusual activity on the card\. It stays frozen until they lift the freeze/);
    accept(C.staffSetCardFreeze(s, 'virtual', false, '', now));
    accept(C.toggleCardFreeze(s, now));
    expect(s.cards.virtual!.frozenBy).toBe('applicant');
  });

  it('freezes a physical card only once active', () => {
    refuse(C.toggleCardFreeze(s, now, 'physical'), /don't have an active physical card/);
    accept(C.staffIssuePhysicalCard(s, address, '5555', message, '', 'Fin Ops', now));
    refuse(C.staffSetCardFreeze(s, 'physical', true, 'Unusual activity on the card', now), /Only an active physical card/);
    accept(C.activatePhysicalCard(s, '5555', now));
    accept(C.staffSetCardFreeze(s, 'physical', true, 'Unusual activity on the card', now));
    refuse(C.toggleCardFreeze(s, now, 'physical'), /grant team froze this card/);
  });
});

describe('card settings', () => {
  it('saves funding and identity rules for one applicant and tells them', () => {
    expect(C.cardSettingsOf(s)).toEqual(C.DEFAULT_CARD_SETTINGS);
    refuse(C.setCardSettings(s, CURRENT_APPLICANT_ID, C.DEFAULT_CARD_SETTINGS, now), /already/);
    accept(C.setCardSettings(s, CURRENT_APPLICANT_ID, { funding: 'both', kycRequired: true }, now));
    expect(C.cardSettingsOf(s)).toEqual({ funding: 'both', kycRequired: true });
    expect(lastNotice().title).toBe('Card settings changed');
    expect(C.fundingSources('both')).toEqual(['deposit', 'grant']);
  });
});

describe('staff view', () => {
  it('never includes the PIN, shows the card balance, and lists applications first', () => {
    accept(C.staffFundCard(s, 30, 'none', 'Goodwill credit for the delay', 'Fin Ops', now));
    const [holder] = C.demoCardHolders(s);
    expect(JSON.stringify(holder)).not.toContain('"pin"');
    expect(holder!.balance).toBe(30);
    const a = { ...holder!, applicantId: 'a', name: 'Zed', cards: { ...holder!.cards, physical: { status: 'Requested' as const, dailyLimit: 500, requestedAt: '2026-09-02' } } };
    const b = { ...holder!, applicantId: 'b', name: 'Amy', cards: { ...holder!.cards, physical: { status: 'Requested' as const, dailyLimit: 500, requestedAt: '2026-09-01' } } };
    const c = { ...holder!, applicantId: 'c', name: 'Bea' };
    expect(C.cardQueue([c, a, b]).map(h => h.applicantId)).toEqual(['b', 'a', 'c']);
  });
});
