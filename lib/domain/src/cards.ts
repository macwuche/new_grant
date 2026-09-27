import type {
  CardCounterpart, CardFunding, CardKind, CardSettings, CardsState, DemoState, PhysicalCard, PhysicalCardStatus, Result, ShippingAddress, Tier, Transaction, Treasury, VirtualCard,
} from './model';
import { fail, nextIds, roundCents, usd } from './core';
import { logStaff } from './activity';
import { accountLockReason, accountOf, patchAccount } from './applicants';
import { computeBalances, ownTransactions } from './rules';
import { CARD_DECLINED_TITLE, CARD_SHIPPED_TITLE, notify } from './notifications';
import { lockdownMessage } from './security';
import { CURRENT_APPLICANT_ID } from './seed';

// Fictional cards: no card network or issuer is connected. Each applicant has
// one card balance (derived from the ledger) shared by a virtual card and an
// optional physical card. The virtual card comes first, created by the
// applicant or by staff; a physical card needs it. Applicants apply for a
// physical card with a shipping address and pay the fee; staff approve (with
// a shipping message that is always emailed) or decline (fee refunded), or
// issue a card directly. Staff also fund and deduct from the card balance,
// cancel physical cards, and freeze cards with a note; the applicant can't
// lift a staff freeze. Staff rules act on the applicant in the current-applicant slot.

export const physicalCardTotal = (treasury: Treasury) => roundCents(treasury.physicalCardFee + treasury.cardDeliveryFee);

/** Highest daily spending limit per account tier. Illustrative values. */
export const TIER_CARD_LIMITS: Record<Tier, number> = { 1: 500, 2: 2500, 3: 10000 };
export const MIN_CARD_LIMIT = 50;
export const DEFAULT_CARD_LIMIT = 500;
export const MIN_CARD_REASON_LENGTH = 10;
export const MAX_TRACKING_REF_LENGTH = 200;
export const MAX_SHIPPING_MESSAGE_LENGTH = 2000;

export const DEFAULT_CARD_SETTINGS: CardSettings = { funding: 'deposit', kycRequired: false };
export const FUNDING_LABELS: Record<CardFunding, string> = { deposit: 'Deposit balance only', grant: 'Grant balance only', both: 'Deposit or grant balance' };
export const COUNTERPART_LABELS: Record<CardCounterpart, string> = { deposit: 'deposit balance', grant: 'grant balance', none: 'no balance' };

/** A physical card that exists (applied for, on its way, or in use): it has a limit. */
export const physicalInUse = (status: PhysicalCardStatus) => status === 'Requested' || status === 'Shipped' || status === 'Active';
/** The applicant (or staff) may start a new physical card. */
export const canRequestPhysical = (status: PhysicalCardStatus) => status === 'Not requested' || status === 'Declined' || status === 'Cancelled';

export const cardSettingsOf = (state: DemoState, applicantId = CURRENT_APPLICANT_ID): CardSettings => accountOf(state, applicantId).cardSettings ?? DEFAULT_CARD_SETTINGS;
/** The balances the applicant may fund their card from. */
export const fundingSources = (funding: CardFunding): ('deposit' | 'grant')[] => funding === 'both' ? ['deposit', 'grant'] : [funding];

/** Why the applicant can't create cards yet because staff require a verified identity, or null. */
export function cardKycBlocker(state: DemoState): string | null {
  return cardSettingsOf(state).kycRequired && !state.profile.identityVerified ? 'Verify your identity (Settings → Identity check) before creating cards.' : null;
}

const cardLabel = (card: CardKind) => card === 'virtual' ? 'Virtual' : 'Physical';
const reasonError = (reason: string) => reason.trim().length < MIN_CARD_REASON_LENGTH ? `Write at least ${MIN_CARD_REASON_LENGTH} characters; the applicant sees this reason.` : null;
const cardBalance = (state: DemoState) => computeBalances(ownTransactions(state)).card;

function withCard<K extends CardKind>(state: DemoState, card: K, next: CardsState[K]): DemoState {
  return { ...state, cards: { ...state.cards, [card]: next } };
}

/** Sets or lifts a freeze, recording who froze it (and the staff note). */
function frozenCard<T extends { frozen?: boolean; frozenBy?: 'applicant' | 'staff'; frozenReason?: string }>(card: T, frozen: boolean, by: 'applicant' | 'staff', reason?: string): T {
  const { frozenBy: _by, frozenReason: _reason, ...rest } = card;
  return (frozen ? { ...rest, frozen: true, frozenBy: by, ...(reason ? { frozenReason: reason } : {}) } : { ...rest, frozen: false }) as T;
}

const notYetActive = (status: PhysicalCardStatus) =>
  status === 'Shipped' ? 'Activate your physical card first.' : status === 'Requested' ? "Your physical card application hasn't been approved yet." : "You don't have an active physical card.";

function validAmount(amount: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return 'Enter an amount.';
  if (roundCents(amount) !== amount) return 'Use at most two decimal places.';
  return null;
}

// ---------- Shipping address ----------

const ADDRESS_LIMITS: Record<keyof ShippingAddress, { label: string; min: number; max: number }> = {
  name: { label: 'Name on the parcel', min: 2, max: 80 }, line1: { label: 'Address', min: 3, max: 120 }, line2: { label: 'Address line 2', min: 0, max: 120 },
  city: { label: 'City', min: 2, max: 60 }, region: { label: 'State or region', min: 0, max: 60 }, postalCode: { label: 'Postal code', min: 2, max: 20 }, country: { label: 'Country', min: 2, max: 60 },
};

/** Trims the address and checks each field; optional fields are dropped when empty. */
export function checkAddress(input: ShippingAddress): { address: ShippingAddress } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const clean: Record<string, string> = {};
  for (const key of Object.keys(ADDRESS_LIMITS) as (keyof ShippingAddress)[]) {
    const { label, min, max } = ADDRESS_LIMITS[key];
    const value = (input[key] ?? '').trim();
    if (value.length < min) errors[key] = `Enter ${label.toLowerCase()}.`;
    else if (value.length > max) errors[key] = `${label}: at most ${max} characters.`;
    else if (value) clean[key] = value;
  }
  return Object.keys(errors).length ? { errors } : { address: clean as ShippingAddress };
}

export const formatAddress = (a: ShippingAddress) => [a.name, a.line1, a.line2, [a.city, a.region, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ');

// ---------- Virtual card ----------

const newVirtual = (state: DemoState, lastFour: string, pin: string, now: Date, by?: string): VirtualCard => ({
  lastFour, pin, frozen: false, dailyLimit: Math.min(DEFAULT_CARD_LIMIT, TIER_CARD_LIMITS[state.profile.tier]), createdAt: now.toISOString(), ...(by ? { createdBy: by } : {}),
});

/** The applicant creates their virtual card. `lastFour` and `pin` are random from the caller: no issuer is connected. */
export function createVirtualCard(state: DemoState, lastFour: string, pin: string, now: Date): Result {
  if (state.cards.virtual) return fail('You already have a virtual card.');
  const blocked = accountLockReason(state) ?? cardKycBlocker(state);
  if (blocked) return fail(blocked);
  const next = logStaff(withCard(state, 'virtual', newVirtual(state, lastFour, pin, now)), {
    kind: 'card', title: 'Virtual card created', body: `${state.profile.name} · card ending ${lastFour}`, href: '/admin/cards',
  }, now);
  return { ok: true, message: `Virtual card ending ${lastFour} created. Fund it from the card balance panel.`, state: notify(next, CURRENT_APPLICANT_ID, 'Virtual card created', `Your virtual card ending ${lastFour} is ready. Add money to your card balance to use it.`, '/cards', now) };
}

/** Staff create the virtual card for the applicant (no identity requirement: staff decide). */
export function staffCreateVirtualCard(state: DemoState, lastFour: string, pin: string, by: string, now: Date): Result {
  if (state.cards.virtual) return fail('This applicant already has a virtual card.');
  const next = notify(withCard(state, 'virtual', newVirtual(state, lastFour, pin, now, by)), CURRENT_APPLICANT_ID, 'Virtual card created',
    `The grant team created a virtual card ending ${lastFour} for you. You'll find it on the Cards page.`, '/cards', now);
  return { ok: true, message: `Virtual card ending ${lastFour} created.`, state: next };
}

// ---------- Limits and freezes ----------

export function validateCardLimit(state: DemoState, amount: number): string | null {
  const max = TIER_CARD_LIMITS[state.profile.tier];
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) return 'Enter a whole-dollar amount.';
  if (amount < MIN_CARD_LIMIT) return `The lowest daily limit is ${usd(MIN_CARD_LIMIT)}.`;
  if (amount > max) return `Tier ${state.profile.tier} accounts can set up to ${usd(max)} a day.`;
  return null;
}

export function setCardLimit(state: DemoState, card: CardKind, amount: number, now = new Date()): Result {
  const locked = accountLockReason(state);
  if (locked) return fail(locked);
  const current = state.cards[card];
  if (!current) return fail('Create your virtual card first.');
  if (card === 'physical' && !physicalInUse(state.cards.physical.status)) return fail('Apply for a physical card first.');
  const error = validateCardLimit(state, amount);
  if (error) return fail(error, { limit: error });
  if (current.dailyLimit === amount) return fail('That is already the daily limit.');
  const label = cardLabel(card);
  const previous = current.dailyLimit;
  const next = notify(withCard(state, card, { ...current, dailyLimit: amount } as CardsState[typeof card]), CURRENT_APPLICANT_ID, `${label} card spending limit ${amount > previous ? 'raised' : 'lowered'}`,
    `Your ${label.toLowerCase()} card can now spend up to ${usd(amount)} a day (was ${usd(previous)}). If you didn't make this change, freeze the card and contact the grant team.`, '/cards', now);
  return { ok: true, message: `${label} card daily limit set to ${usd(amount)}.`, state: next };
}

/** The note an applicant sees when they try to unfreeze a card staff froze. */
export const staffFreezeNote = (reason?: string) => `The grant team froze this card${reason ? `: ${reason}` : ''}. It stays frozen until they lift the freeze.`;

/** The applicant freezes or unfreezes a card. A locked account can freeze but not unfreeze; a staff freeze stays until staff lift it. */
export function toggleCardFreeze(state: DemoState, now = new Date(), card: CardKind = 'virtual'): Result {
  const current = state.cards[card];
  if (!current) return fail("You don't have a virtual card yet.");
  if (card === 'physical' && state.cards.physical.status !== 'Active') return fail(notYetActive(state.cards.physical.status));
  const frozen = !current.frozen;
  if (!frozen && current.frozenBy === 'staff') return fail(staffFreezeNote(current.frozenReason));
  const locked = accountLockReason(state);
  if (locked && !frozen) return fail(locked);
  const label = cardLabel(card);
  const next = notify(withCard(state, card, frozenCard(current, frozen, 'applicant') as CardsState[typeof card]), CURRENT_APPLICANT_ID,
    frozen ? `${label} card frozen` : `${label} card unfrozen`,
    frozen ? `Your ${label.toLowerCase()} card is frozen, so no payments can be made with it until you unfreeze it.` : `Your ${label.toLowerCase()} card is active again. If you didn't unfreeze it, freeze it now and contact the grant team.`, '/cards', now);
  return { ok: true, message: frozen ? `${label} card frozen.` : `${label} card unfrozen.`, state: next };
}

/** Staff freeze (note required, shown to the applicant) or unfreeze either card. A staff freeze replaces an applicant's own. */
export function staffSetCardFreeze(state: DemoState, card: CardKind, frozen: boolean, reason: string, now: Date): Result {
  const current = state.cards[card];
  if (!current) return fail('This applicant has no virtual card.');
  if (card === 'physical' && state.cards.physical.status !== 'Active') return fail('Only an active physical card can be frozen.');
  const label = cardLabel(card);
  if (frozen && current.frozen && current.frozenBy === 'staff') return fail(`The ${label.toLowerCase()} card is already frozen by staff.`);
  if (!frozen && !current.frozen) return fail(`The ${label.toLowerCase()} card isn't frozen.`);
  const text = reason.trim();
  if (frozen) { const error = reasonError(text); if (error) return fail('Write the note the applicant will see.', { reason: error }); }
  const next = notify(withCard(state, card, frozenCard(current, frozen, 'staff', frozen ? text : undefined) as CardsState[typeof card]), CURRENT_APPLICANT_ID,
    frozen ? `${label} card frozen by the grant team` : `${label} card unfrozen`,
    frozen ? `Your ${label.toLowerCase()} card was frozen: ${text}. It stays frozen until the grant team lifts the freeze.` : `The grant team lifted the freeze on your ${label.toLowerCase()} card; it can be used again.`, '/cards', now);
  return { ok: true, message: frozen ? `${label} card frozen. Only staff can lift the freeze.` : `${label} card unfrozen.`, state: next };
}

// ---------- Card balance ----------

const cardMove = (state: DemoState, type: 'Card top-up' | 'Card deduction', amount: number, counterpart: CardCounterpart, description: string, now: Date, staff?: { by: string; note: string }) => {
  const ids = nextIds(state);
  const tx: Transaction = {
    id: ids.tx, applicantId: CURRENT_APPLICANT_ID, type, description, amount: type === 'Card top-up' ? amount : -amount, status: 'Completed', createdAt: now.toISOString(), counterpart,
    ...(staff ? { processedAt: now.toISOString(), processedBy: staff.by, note: staff.note } : {}),
  };
  return { tx, state: { ...state, nextId: ids.nextId, transactions: [tx, ...state.transactions] } };
};

/** How much can come from a balance: the grant balance, or the deposit balance above the reserve (applicants) or in full (staff). */
export function fundableFrom(state: DemoState, source: 'deposit' | 'grant', keepReserve: boolean): number {
  const balances = computeBalances(ownTransactions(state));
  if (source === 'grant') return Math.max(0, balances.grant);
  return Math.max(0, roundCents(balances.deposit - (keepReserve ? state.treasury.depositThreshold : 0)));
}

/** The applicant moves money from an allowed balance onto their card. */
export function fundCard(state: DemoState, amount: number, source: 'deposit' | 'grant', now: Date): Result {
  if (!state.cards.virtual) return fail('Create your virtual card first.');
  const blocked = accountLockReason(state) ?? lockdownMessage(state);
  if (blocked) return fail(blocked);
  const allowed = fundingSources(cardSettingsOf(state).funding);
  if (!allowed.includes(source)) return fail(`Your card can be funded from your ${allowed[0]} balance only.`, { source: 'Not allowed for your account.' });
  const error = validAmount(amount);
  if (error) return fail(error, { amount: error });
  const available = fundableFrom(state, source, true);
  if (amount > available) {
    const reserve = source === 'deposit' && state.treasury.depositThreshold ? ` (${usd(state.treasury.depositThreshold)} stays in your deposit balance as the reserve)` : '';
    return fail(`You can move up to ${usd(available)} from your ${source} balance${reserve}.`, { amount: `Up to ${usd(available)}.` });
  }
  const moved = cardMove(state, 'Card top-up', amount, source, `Card top-up from ${source} balance`, now);
  const logged = logStaff(moved.state, { kind: 'card', title: `Card funded: ${usd(amount)}`, body: `${state.profile.name} · from ${source} balance`, href: '/admin/cards' }, now);
  return { ok: true, id: moved.tx.id, message: `${usd(amount)} moved to your card balance.`, state: notify(logged, CURRENT_APPLICANT_ID, 'Card funded', `${usd(amount)} was moved from your ${source} balance to your card balance.`, '/cards', now) };
}

/** Staff add money to the card: from one of the applicant's balances, or without one ('none'). A reason is required and shown. */
export function staffFundCard(state: DemoState, amount: number, source: CardCounterpart, reason: string, by: string, now: Date): Result {
  if (!state.cards.virtual) return fail('Create a virtual card for this applicant first.');
  const error = validAmount(amount);
  if (error) return fail(error, { amount: error });
  const text = reason.trim();
  const why = reasonError(text);
  if (why) return fail('Explain the top-up.', { reason: why });
  if (source !== 'none') {
    const available = fundableFrom(state, source, false);
    if (amount > available) return fail(`The ${source} balance holds ${usd(available)}.`, { amount: `Up to ${usd(available)}.` });
  }
  const from = source === 'none' ? 'added by the grant team' : `from ${COUNTERPART_LABELS[source]}`;
  const moved = cardMove(state, 'Card top-up', amount, source, source === 'none' ? 'Card top-up by the grant team' : `Card top-up from ${source} balance (staff)`, now, { by, note: text });
  return { ok: true, id: moved.tx.id, message: `${usd(amount)} added to the card balance (${from}).`,
    state: notify(moved.state, CURRENT_APPLICANT_ID, 'Card funded by the grant team', `${usd(amount)} was added to your card balance${source === 'none' ? '' : ` from your ${source} balance`}: ${text}.`, '/cards', now) };
}

/** Staff take money off the card: back to one of the applicant's balances, or out of the account ('none'). A reason is required and shown. */
export function staffDeductCard(state: DemoState, amount: number, destination: CardCounterpart, reason: string, by: string, now: Date): Result {
  const error = validAmount(amount);
  if (error) return fail(error, { amount: error });
  const text = reason.trim();
  const why = reasonError(text);
  if (why) return fail('Explain the deduction.', { reason: why });
  const balance = cardBalance(state);
  if (amount > balance) return fail(`The card balance holds ${usd(balance)}.`, { amount: `Up to ${usd(balance)}.` });
  const to = destination === 'none' ? 'removed from the account' : `returned to the ${COUNTERPART_LABELS[destination]}`;
  const moved = cardMove(state, 'Card deduction', amount, destination, destination === 'none' ? 'Card deduction by the grant team' : `Card balance returned to ${destination} balance`, now, { by, note: text });
  return { ok: true, id: moved.tx.id, message: `${usd(amount)} deducted from the card balance and ${to}.`,
    state: notify(moved.state, CURRENT_APPLICANT_ID, 'Card balance reduced', `${usd(amount)} was taken from your card balance${destination === 'none' ? '' : ` and returned to your ${destination} balance`}: ${text}.`, '/cards', now) };
}

// ---------- Physical card ----------

/** The applicant applies with a shipping address and pays the fees from the deposit balance (reserve kept). Staff then approve or decline. */
export function requestPhysicalCard(state: DemoState, input: ShippingAddress, now: Date): Result {
  if (!state.cards.virtual) return fail('Create your virtual card first: a physical card is linked to it.');
  const { status } = state.cards.physical;
  if (!canRequestPhysical(status)) return fail(status === 'Active' ? 'You already have an active physical card.' : status === 'Shipped' ? 'Your physical card is on its way.' : 'Your physical card application is being reviewed.');
  const blocked = accountLockReason(state) ?? cardKycBlocker(state);
  if (blocked) return fail(blocked);
  const checked = checkAddress(input);
  if ('errors' in checked) return fail('Check the shipping address.', checked.errors);
  const total = physicalCardTotal(state.treasury);
  const reserve = state.treasury.depositThreshold;
  const { deposit } = computeBalances(ownTransactions(state));
  if (deposit - total < reserve) return fail(`Your deposit balance must cover the ${usd(total)} card and shipping fees${reserve ? ` and keep ${usd(reserve)} in reserve` : ''}. You have ${usd(deposit)}.`);
  const ids = nextIds(state);
  const fee: Transaction = { id: ids.tx, applicantId: CURRENT_APPLICANT_ID, type: 'Card fee', description: `Physical card${state.treasury.cardDeliveryFee ? ' and shipping' : ''}`, amount: -total, status: 'Completed', createdAt: now.toISOString() };
  const physical: PhysicalCard = { status: 'Requested', dailyLimit: state.cards.physical.dailyLimit, shippingAddress: checked.address, requestedAt: now.toISOString(), feeTxId: fee.id };
  const next = logStaff(withCard({ ...state, nextId: ids.nextId, transactions: [fee, ...state.transactions] }, 'physical', physical), {
    kind: 'card', highlight: true, title: 'Physical card application', body: `${state.profile.name} · ${usd(total)} paid · to ${checked.address.city}, ${checked.address.country} · approve or decline`, href: '/admin/cards',
  }, now);
  const notified = notify(next, CURRENT_APPLICANT_ID, 'Physical card application received',
    `We've received your physical card application and your ${usd(total)} payment. We'll email you when your card ships; if it can't be approved, the fee is refunded.`, '/cards', now);
  return { ok: true, message: `Application sent. ${usd(total)} was taken from your deposit balance; we'll email you when your card ships.`, state: notified };
}

function checkShipping(message: string, trackingRef: string): { message: string; tracking: string } | Result {
  const text = message.trim();
  if (text.length < MIN_CARD_REASON_LENGTH) return fail('Write the message the applicant will receive.', { message: `At least ${MIN_CARD_REASON_LENGTH} characters, e.g. the courier and tracking link.` });
  if (text.length > MAX_SHIPPING_MESSAGE_LENGTH) return fail('The message is too long.', { message: `At most ${MAX_SHIPPING_MESSAGE_LENGTH} characters.` });
  const tracking = trackingRef.trim();
  if (tracking.length > MAX_TRACKING_REF_LENGTH) return fail('The tracking number or link is too long.', { trackingRef: `At most ${MAX_TRACKING_REF_LENGTH} characters.` });
  return { message: text, tracking };
}

const shippedNotice = (state: DemoState, message: string, now: Date) => notify(state, CURRENT_APPLICANT_ID, CARD_SHIPPED_TITLE, message, '/cards', now);

/** Staff approve an application: the card ships and the applicant is emailed the message staff wrote (with the tracking number or link). */
export function approvePhysicalCard(state: DemoState, lastFour: string, message: string, trackingRef: string, by: string, now: Date): Result {
  const physical = state.cards.physical;
  if (physical.status !== 'Requested') return fail(physical.status === 'Shipped' || physical.status === 'Active' ? `This card was already approved${physical.shippedBy ? ` by ${physical.shippedBy}` : ''}.` : 'This applicant has no physical card application waiting.');
  if (!/^\d{4}$/.test(lastFour)) return fail('The card number is missing.');
  const checked = checkShipping(message, trackingRef);
  if ('ok' in checked) return checked;
  const shipped: PhysicalCard = { ...physical, status: 'Shipped', lastFour, shippedAt: now.toISOString(), shippedBy: by, shippingMessage: checked.message, ...(checked.tracking ? { trackingRef: checked.tracking } : {}) };
  return { ok: true, message: `Approved. Card ending ${lastFour} is marked as shipped and your message was sent.`, state: shippedNotice(withCard(state, 'physical', shipped), checked.message, now) };
}

/** Staff decline an application: the fee is refunded and the applicant told why. They may apply again. */
export function declinePhysicalCard(state: DemoState, reason: string, by: string, now: Date): Result {
  const physical = state.cards.physical;
  if (physical.status !== 'Requested') return fail('This applicant has no physical card application waiting.');
  const text = reason.trim();
  const error = reasonError(text);
  if (error) return fail('Explain why the application is declined.', { reason: error });
  const fee = physical.feeTxId ? ownTransactions(state).find(t => t.id === physical.feeTxId && t.status === 'Completed') : undefined;
  const transactions = fee ? state.transactions.map(t => t.id === fee.id ? { ...t, status: 'Cancelled' as const, processedAt: now.toISOString(), processedBy: by } : t) : state.transactions;
  const declined: PhysicalCard = { status: 'Declined', dailyLimit: physical.dailyLimit, ...(physical.shippingAddress ? { shippingAddress: physical.shippingAddress } : {}), ...(physical.requestedAt ? { requestedAt: physical.requestedAt } : {}), declinedAt: now.toISOString(), declinedBy: by, declineReason: text };
  const refund = fee ? ` Your ${usd(Math.abs(fee.amount))} payment was returned to your deposit balance.` : '';
  const next = notify(withCard({ ...state, transactions }, 'physical', declined), CURRENT_APPLICANT_ID, CARD_DECLINED_TITLE, `Your physical card application was declined: ${text}.${refund} You can apply again from the Cards page.`, '/cards', now);
  return { ok: true, message: `Application declined.${fee ? ` ${usd(Math.abs(fee.amount))} refunded.` : ''}`, state: next };
}

/** Staff issue a physical card directly (no application, no fee): it ships at once with the message staff wrote. */
export function staffIssuePhysicalCard(state: DemoState, input: ShippingAddress, lastFour: string, message: string, trackingRef: string, by: string, now: Date): Result {
  if (!state.cards.virtual) return fail('Create a virtual card for this applicant first: a physical card is linked to it.');
  if (!canRequestPhysical(state.cards.physical.status)) return fail('This applicant already has a physical card or an application waiting.');
  const address = checkAddress(input);
  if ('errors' in address) return fail('Check the shipping address.', address.errors);
  if (!/^\d{4}$/.test(lastFour)) return fail('The card number is missing.');
  const checked = checkShipping(message, trackingRef);
  if ('ok' in checked) return checked;
  const at = now.toISOString();
  const physical: PhysicalCard = { status: 'Shipped', dailyLimit: state.cards.physical.dailyLimit, shippingAddress: address.address, requestedAt: at, issuedBy: by, lastFour, shippedAt: at, shippedBy: by, shippingMessage: checked.message, ...(checked.tracking ? { trackingRef: checked.tracking } : {}) };
  return { ok: true, message: `Physical card ending ${lastFour} issued and marked as shipped. Your message was sent.`, state: shippedNotice(withCard(state, 'physical', physical), checked.message, now) };
}

/** The applicant confirms the card arrived by entering the last four digits printed on it. */
export function activatePhysicalCard(state: DemoState, lastFour: string, now: Date): Result {
  const physical = state.cards.physical;
  if (physical.status !== 'Shipped') return fail(physical.status === 'Active' ? 'Your physical card is already active.' : "There's no shipped card to activate.");
  const locked = accountLockReason(state);
  if (locked) return fail(locked);
  const digits = lastFour.trim();
  if (!/^\d{4}$/.test(digits)) return fail('Enter the last four digits on the front of your card.', { lastFour: 'Enter four digits.' });
  if (digits !== physical.lastFour) return fail("Those digits don't match the card we sent. Check the number on the front of your card.", { lastFour: "Those digits don't match." });
  const next = logStaff(withCard(state, 'physical', { ...physical, status: 'Active', activatedAt: now.toISOString(), frozen: false }), {
    kind: 'card', title: 'Physical card activated', body: `${state.profile.name} · card ending ${digits}`, href: '/admin/cards',
  }, now);
  const notified = notify(next, CURRENT_APPLICANT_ID, 'Physical card activated', `Your physical card ending ${digits} is active, with a daily limit of ${usd(physical.dailyLimit)}. If you didn't activate it, freeze it now and contact the grant team.`, '/cards', now);
  return { ok: true, message: `Card ending ${digits} activated.`, state: notified };
}

/** Staff cancel a shipped or active physical card (no refund). An application is declined instead. */
export function cancelPhysicalCard(state: DemoState, reason: string, by: string, now: Date): Result {
  const physical = state.cards.physical;
  if (physical.status === 'Requested') return fail('Decline the application instead: that refunds the fee.');
  if (physical.status !== 'Shipped' && physical.status !== 'Active') return fail('This applicant has no physical card to cancel.');
  const text = reason.trim();
  const error = reasonError(text);
  if (error) return fail('Explain why the card is being cancelled.', { reason: error });
  const { frozen: _f, frozenBy: _b, frozenReason: _r, ...rest } = physical;
  const cancelled: PhysicalCard = { ...rest, status: 'Cancelled', cancelledAt: now.toISOString(), cancelledBy: by, cancelReason: text };
  const next = notify(withCard(state, 'physical', cancelled), CURRENT_APPLICANT_ID, 'Physical card cancelled',
    `Your physical card${physical.lastFour ? ` ending ${physical.lastFour}` : ''} was cancelled: ${text}. Your card balance is unchanged, and you can apply for a new card from the Cards page.`, '/cards', now);
  return { ok: true, message: 'Physical card cancelled.', state: next };
}

// ---------- Settings (staff, on any applicant) ----------

export function setCardSettings(state: DemoState, applicantId: string, settings: CardSettings, now: Date): Result {
  const current = cardSettingsOf(state, applicantId);
  if (current.funding === settings.funding && current.kycRequired === settings.kycRequired) return fail('Those are already the card settings.');
  const changes = [
    ...(current.funding !== settings.funding ? [`card funding: ${FUNDING_LABELS[settings.funding].toLowerCase()}`] : []),
    ...(current.kycRequired !== settings.kycRequired ? [settings.kycRequired ? 'identity check required before creating cards' : 'no identity check needed for cards'] : []),
  ];
  const next = patchAccount(state, applicantId, { cardSettings: { funding: settings.funding, kycRequired: settings.kycRequired } });
  const body = current.funding !== settings.funding ? `You can now fund your card from: ${FUNDING_LABELS[settings.funding].toLowerCase()}.` : settings.kycRequired ? 'Verify your identity before creating cards.' : 'Cards no longer need an identity check.';
  return { ok: true, message: `Card settings saved (${changes.join('; ')}).`, state: notify(next, applicantId, 'Card settings changed', body, '/cards', now) };
}

// ---------- Staff view ----------

/** Cards as staff see them: never the PIN. */
export type StaffCards = { virtual: Omit<VirtualCard, 'pin'> | null; physical: PhysicalCard };
export type CardHolder = { applicantId: string; name: string; email: string; cards: StaffCards; balance: number; settings: CardSettings };

export function staffCards(cards: CardsState): StaffCards {
  if (!cards.virtual) return { virtual: null, physical: cards.physical };
  const { pin: _pin, ...virtual } = cards.virtual;
  return { virtual, physical: cards.physical };
}

/** Browser demo: the only applicant with cards is the demo applicant. */
export const demoCardHolders = (state: DemoState): CardHolder[] =>
  [{ applicantId: CURRENT_APPLICANT_ID, name: state.profile.name, email: state.profile.email, cards: staffCards(state.cards), balance: cardBalance(state), settings: cardSettingsOf(state) }];

/** Applications waiting for a decision first (oldest first), then the rest by name. */
export function cardQueue(holders: CardHolder[]): CardHolder[] {
  const waiting = holders.filter(h => h.cards.physical.status === 'Requested').sort((a, b) => (a.cards.physical.requestedAt ?? '').localeCompare(b.cards.physical.requestedAt ?? ''));
  const rest = holders.filter(h => h.cards.physical.status !== 'Requested').sort((a, b) => a.name.localeCompare(b.name));
  return [...waiting, ...rest];
}
