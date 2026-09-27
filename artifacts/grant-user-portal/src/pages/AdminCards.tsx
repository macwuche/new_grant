import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight, Info, Search } from 'lucide-react';
import { format } from 'date-fns';
import {
  approvePhysicalCard, canRequestPhysical, cancelPhysicalCard, cardQueue, checkAddress, COUNTERPART_LABELS, declinePhysicalCard, demoCardHolders, DEFAULT_CARD_SETTINGS,
  formatAddress, FUNDING_LABELS, MAX_SHIPPING_MESSAGE_LENGTH, MAX_TRACKING_REF_LENGTH, MIN_CARD_REASON_LENGTH, physicalInUse, setCardSettings, staffCreateVirtualCard,
  staffDeductCard, staffFundCard, staffIssuePhysicalCard, staffSetCardFreeze, type CardHolder,
} from '@workspace/domain/cards';
import { findApplicant } from '@workspace/domain/applicants';
import type { CardCounterpart, CardFunding, CardKind, CardSettings, PhysicalCardStatus, Result, ShippingAddress } from '@workspace/domain/model';
import { CURRENT_APPLICANT_ID } from '@workspace/domain/seed';
import { actingStaff } from '@workspace/domain/staff';
import { adoptServerApplicant } from '@workspace/domain/sync';
import type { Permission } from '@workspace/authz';
import * as api from '@workspace/api-client-react';
import { apiError, toServerApplicant, useServerData } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import { RoleNotice, useCan, useStaffCommand } from './AdminStaff';
import { ReviewFrame } from './AdminReviewPanel';

// Staff card management: decide physical card applications (approve with a
// message emailed to the applicant, or decline with a refund), issue cards,
// cancel them, freeze or unfreeze them with a note, and fund or deduct from
// the card balance. Signed in, everything goes through the API; in the demo
// the only card holder is the demo applicant.

const usd = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string) => format(new Date(iso), 'dd MMM yyyy');
const when = (iso: string) => format(new Date(iso), 'dd MMM yyyy, HH:mm');
const fourDigits = () => String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
const PHYSICAL_LABEL: Record<PhysicalCardStatus, string> = { 'Not requested': 'None', Requested: 'To review', Shipped: 'Shipped', Active: 'Active', Declined: 'Declined', Cancelled: 'Cancelled' };
const physicalBadge = (status: PhysicalCardStatus) => `admin-badge ${status === 'Active' ? 'approved' : status === 'Declined' || status === 'Cancelled' ? 'declined' : status === 'Not requested' ? 'draft' : 'submitted'}`;
const freezeLabel = (card: { frozen?: boolean; frozenBy?: string } | null) => !card ? 'No card' : card.frozen ? (card.frozenBy === 'staff' ? 'Frozen by staff' : 'Frozen by applicant') : 'Not frozen';
const physicalText = (h: CardHolder) => h.cards.physical.status === 'Active' && h.cards.physical.frozen ? 'Active · frozen' : PHYSICAL_LABEL[h.cards.physical.status];
const virtualText = (h: CardHolder) => !h.cards.virtual ? 'Not created' : `•••• ${h.cards.virtual.lastFour}${h.cards.virtual.frozen ? ` · ${freezeLabel(h.cards.virtual).toLowerCase()}` : ''}`;

type Outcome = { ok: true; message: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };
type Local = (s: Parameters<Parameters<ReturnType<typeof useStaffCommand>>[2]>[0], by: string) => Result;

/**
 * Runs one staff card action: signed in through the API (the saved holder
 * comes back), otherwise the browser rule on the demo store (role-checked and
 * audited there).
 */
function useCardAction(onHolder: (holder: CardHolder) => void) {
  const { connected, refreshActivity, refreshMoney } = useServerData();
  const command = useStaffCommand();
  return useCallback(async (applicantId: string, permission: Permission, action: string, remote: () => Promise<api.CardHolderResult>, local: Local): Promise<Outcome> => {
    if (!connected) {
      const result = command(permission, { action, target: applicantId }, (s, actor) => local(s, actor.name));
      return result.ok ? { ok: true, message: result.message } : result;
    }
    try {
      const res = await remote();
      onHolder(res.holder as CardHolder);
      void refreshActivity(); void refreshMoney();
      return { ok: true, message: res.message };
    } catch (err) {
      const failure = apiError(err, "Couldn't reach the server. Nothing was changed; try again.");
      return { ok: false, error: failure.error, fieldErrors: failure.fieldErrors };
    }
  }, [connected, command, onHolder, refreshActivity, refreshMoney]);
}

/** Every card holder: from the server (signed in) or the demo store. */
function useCardHolders() {
  const { state } = useDemoStore();
  const { connected } = useServerData();
  const [server, setServer] = useState<CardHolder[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setServer(await api.listCardHolders() as CardHolder[]); setLoadError(null); }
    catch (err) { setLoadError(apiError(err, "Couldn't load cards. Try again.").error); }
  }, []);
  useEffect(() => { if (connected) void load(); }, [connected, load]);
  const replace = useCallback((holder: CardHolder) => setServer(list => {
    const rest = (list ?? []).filter(h => h.applicantId !== holder.applicantId);
    return [...rest, holder];
  }), []);
  const holders = connected ? server ?? [] : demoCardHolders(state);
  return { connected, holders: cardQueue(holders), loading: connected && server === null && !loadError, loadError, reload: load, replace };
}

/** One applicant's cards, for their profile page. Demo applicants other than the portal user have no cards. */
export function useCardHolder(applicantId: string) {
  const { state } = useDemoStore();
  const { connected } = useServerData();
  const [server, setServer] = useState<CardHolder | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setServer(await api.getCardHolder(applicantId) as CardHolder); setLoadError(null); }
    catch (err) { setLoadError(apiError(err, "Couldn't load this applicant's cards.").error); }
  }, [applicantId]);
  useEffect(() => { if (connected) void load(); }, [connected, load]);
  if (connected) return { holder: server, loadError, replace: setServer, reload: load, demoOnly: false };
  const none = async () => {};
  if (applicantId === CURRENT_APPLICANT_ID) return { holder: demoCardHolders(state)[0]!, loadError: null, replace: () => {}, reload: none, demoOnly: false };
  return { holder: null, loadError: null, replace: () => {}, reload: none, demoOnly: true };
}

export function AdminCards() {
  const { holders, loading, loadError, reload, connected, replace } = useCardHolders();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All cards');
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const count = (status: PhysicalCardStatus) => holders.filter(h => h.cards.physical.status === status).length;
  const frozen = holders.filter(h => h.cards.virtual?.frozen || h.cards.physical.frozen).length;
  const totalBalance = holders.reduce((sum, h) => sum + h.balance, 0);
  const rows = holders.filter(h => {
    const status = h.cards.physical.status;
    const matches = filter === 'All cards' || (filter === 'Frozen' ? !!(h.cards.virtual?.frozen || h.cards.physical.frozen) : filter === 'No virtual card' ? !h.cards.virtual : PHYSICAL_LABEL[status] === filter);
    return matches && `${h.name} ${h.email} ${h.cards.virtual?.lastFour ?? ''} ${h.cards.physical.lastFour ?? ''}`.toLowerCase().includes(query.toLowerCase());
  });
  const open = holders.find(h => h.applicantId === openId);

  return <>
    <div className="admin-overview-metrics">
      <div className="admin-metric featured" data-testid="metric-admin-cards-to-review"><span className="admin-metric-label">Applications to review</span><strong className="admin-metric-value">{String(count('Requested')).padStart(2, '0')}</strong><span className="admin-metric-foot">Oldest first · approve or decline</span></div>
      <div className="admin-metric" data-testid="metric-admin-cards-shipped"><span className="admin-metric-label">Shipped, not activated</span><strong className="admin-metric-value">{String(count('Shipped')).padStart(2, '0')}</strong><span className="admin-metric-foot">Waiting for the applicant</span></div>
      <div className="admin-metric" data-testid="metric-admin-cards-balance"><span className="admin-metric-label">Held on cards</span><strong className="admin-metric-value">{usd(totalBalance)}</strong><span className="admin-metric-foot">All card balances</span></div>
      <div className="admin-metric" data-testid="metric-admin-cards-frozen"><span className="admin-metric-label">Holders with a frozen card</span><strong className="admin-metric-value">{String(frozen).padStart(2, '0')}</strong><span className="admin-metric-foot">By the applicant or staff</span></div>
    </div>
    <section className="admin-panel">
      <div className="admin-panel-head"><div><h2>Cards</h2><p>Decide physical card applications, issue cards, fund or deduct from card balances, and freeze cards. The cards are fictional: no card issuer is connected, so shipping is arranged outside the app. To create cards for someone new, open their profile from Applicants.</p></div></div>
      <div className="admin-toolbar"><div className="admin-toolbar-left"><label className="admin-search"><Search size={15} /><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, email, or card ending" aria-label="Search cards" data-testid="input-admin-search-cards" /></label><select className="admin-filter" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter cards" data-testid="select-admin-filter-cards"><option>All cards</option><option>To review</option><option>Shipped</option><option>Active</option><option>Declined</option><option>Cancelled</option><option>Frozen</option><option>No virtual card</option></select></div><span className="admin-count" data-testid="text-admin-cards-count">{rows.length} of {holders.length} card holders</span></div>
      {loadError ? <div className="admin-empty" data-testid="error-admin-cards"><Info size={25} /><h3>Cards didn't load</h3><p>{loadError}</p><button type="button" className="admin-btn" onClick={() => void reload()}>Try again</button></div>
        : loading ? <div className="admin-empty"><p>Loading cards…</p></div>
        : rows.length ? <>
          <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Card holder</th><th>Card balance</th><th>Virtual card</th><th>Physical card</th><th>Applied</th><th><span className="admin-eyebrow" style={{ margin: 0 }}>Manage</span></th></tr></thead><tbody>{rows.map(h => <tr key={h.applicantId} data-testid={`row-admin-card-${h.applicantId}`}>
            <td><span className="admin-table-primary">{h.name}</span><span className="admin-table-secondary">{h.email}</span></td>
            <td className="admin-table-number">{usd(h.balance)}</td>
            <td className="admin-table-muted">{virtualText(h)}</td>
            <td><span className={physicalBadge(h.cards.physical.status)}>{physicalText(h)}</span></td>
            <td className="admin-table-muted">{h.cards.physical.requestedAt && physicalInUse(h.cards.physical.status) ? day(h.cards.physical.requestedAt) : '—'}</td>
            <td><button type="button" className="admin-icon-button" onClick={() => setOpenId(h.applicantId)} aria-label={`Manage cards for ${h.name}`} data-testid={`button-open-admin-card-${h.applicantId}`}><ArrowRight size={15} /></button></td>
          </tr>)}</tbody></table></div>
          <div className="admin-mobile-records" role="list" aria-label="Card holders">{rows.map(h => <article className="admin-mobile-record" role="listitem" key={h.applicantId} data-testid={`card-admin-card-${h.applicantId}`}>
            <div className="admin-mobile-record-top"><div className="admin-mobile-record-identity"><strong>{h.name}</strong><span>{h.email}</span></div><span className={physicalBadge(h.cards.physical.status)}>{physicalText(h)}</span></div>
            <dl className="admin-mobile-record-facts"><div><dt>Balance</dt><dd>{usd(h.balance)}</dd></div><div><dt>Virtual</dt><dd>{virtualText(h)}</dd></div></dl>
            <button type="button" className="admin-mobile-record-action" onClick={() => setOpenId(h.applicantId)} data-testid={`button-open-admin-card-mobile-${h.applicantId}`}>{h.cards.physical.status === 'Requested' ? 'Approve or decline' : 'Manage cards'} <ArrowRight size={15} /></button>
          </article>)}</div>
        </> : <div className="admin-empty" data-testid="empty-admin-cards"><Search size={25} /><h3>No cards in this view</h3><p>{connected ? 'Card holders appear once they (or staff) open their cards.' : 'Cards appear here once applicants have them.'}</p></div>}
    </section>
    {openId && <CardPanel holder={open} applicantId={openId} onHolder={replace} onClose={close} />}
  </>;
}

function CardPanel({ holder, applicantId, onHolder, onClose }: { holder: CardHolder | undefined; applicantId: string; onHolder: (h: CardHolder) => void; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!holder) return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow={applicantId}><h2 id="admin-detail-title">Card holder not found</h2></ReviewFrame>;
  return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow={`${holder.name} / Cards`}>
    <div className="admin-review-title"><h2 id="admin-detail-title" data-testid="text-admin-detail-title">{holder.name}</h2><span className={physicalBadge(holder.cards.physical.status)} data-testid="status-admin-physical-card">{physicalText(holder)}</span></div>
    <p className="admin-detail-lead">{holder.email} · <Link href={`/admin/applicants/${holder.applicantId}`} className="link-text" data-testid="link-admin-card-profile">Open profile</Link></p>
    <CardManager holder={holder} onHolder={onHolder} />
  </ReviewFrame>;
}

type Mode = 'create-virtual' | 'approve' | 'decline' | 'issue' | 'cancel' | 'freeze-virtual' | 'freeze-physical' | 'fund' | 'deduct';
const EMPTY_ADDRESS: ShippingAddress = { name: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: '' };
const ADDRESS_FIELDS: { key: keyof ShippingAddress; label: string; optional?: boolean }[] = [
  { key: 'name', label: 'Name on the parcel' }, { key: 'line1', label: 'Address' }, { key: 'line2', label: 'Address line 2', optional: true }, { key: 'city', label: 'City' },
  { key: 'region', label: 'State or region', optional: true }, { key: 'postalCode', label: 'Postal code' }, { key: 'country', label: 'Country' },
];
const MOVE_OPTIONS: Record<'fund' | 'deduct', { value: CardCounterpart; label: string }[]> = {
  fund: [{ value: 'deposit', label: "From the applicant's deposit balance" }, { value: 'grant', label: "From the applicant's grant balance" }, { value: 'none', label: 'Add without using a balance' }],
  deduct: [{ value: 'deposit', label: 'Return to the deposit balance' }, { value: 'grant', label: 'Return to the grant balance' }, { value: 'none', label: 'Remove from the account' }],
};

/** Everything staff can do with one applicant's cards. Used in the Cards side panel and on the applicant's profile page. */
export function CardManager({ holder, onHolder }: { holder: CardHolder; onHolder: (h: CardHolder) => void }) {
  const { state } = useDemoStore();
  const { connected } = useServerData();
  const can = useCan();
  const act = useCardAction(onHolder);
  const [mode, setMode] = useState<Mode | null>(null);
  const [text, setText] = useState('');
  const [tracking, setTracking] = useState('');
  const [amount, setAmount] = useState('');
  const [move, setMove] = useState<CardCounterpart>('deposit');
  const [address, setAddress] = useState<ShippingAddress>(EMPTY_ADDRESS);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const { virtual, physical } = holder.cards;
  const id = holder.applicantId;
  const pick = (next: Mode | null) => {
    setMode(next); setText(''); setTracking(''); setAmount(''); setMove('deposit'); setConfirming(false); setErrors({}); setFlash(null);
    setAddress(next === 'issue' ? { ...EMPTY_ADDRESS, name: holder.name, ...(physical.shippingAddress ?? {}) } : EMPTY_ADDRESS);
  };
  const freezeCard: CardKind = mode === 'freeze-physical' ? 'physical' : 'virtual';
  const freezeTarget = holder.cards[freezeCard];
  const freezing = mode?.startsWith('freeze') ? !(freezeTarget?.frozen && freezeTarget.frozenBy === 'staff') : false;

  const actions: { key: Mode; label: string; permission: Permission }[] = [
    ...(!virtual ? [{ key: 'create-virtual' as const, label: 'Create virtual card', permission: 'payments.process' as const }] : []),
    ...(physical.status === 'Requested' ? [{ key: 'approve' as const, label: 'Approve application', permission: 'payments.process' as const }, { key: 'decline' as const, label: 'Decline application', permission: 'payments.process' as const }] : []),
    ...(virtual && canRequestPhysical(physical.status) ? [{ key: 'issue' as const, label: 'Issue physical card', permission: 'payments.process' as const }] : []),
    ...(virtual ? [{ key: 'fund' as const, label: 'Fund card', permission: 'payments.process' as const }] : []),
    ...(holder.balance > 0 ? [{ key: 'deduct' as const, label: 'Deduct from card', permission: 'payments.process' as const }] : []),
    ...(physical.status === 'Shipped' || physical.status === 'Active' ? [{ key: 'cancel' as const, label: 'Cancel physical card', permission: 'payments.process' as const }] : []),
    ...(virtual ? [{ key: 'freeze-virtual' as const, label: virtual.frozen && virtual.frozenBy === 'staff' ? 'Lift virtual freeze' : 'Freeze virtual card', permission: 'accounts.manage' as const }] : []),
    ...(physical.status === 'Active' ? [{ key: 'freeze-physical' as const, label: physical.frozen && physical.frozenBy === 'staff' ? 'Lift physical freeze' : 'Freeze physical card', permission: 'accounts.manage' as const }] : []),
  ];
  const current = actions.find(a => a.key === mode);

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    const needsReason = mode === 'decline' || mode === 'cancel' || mode === 'fund' || mode === 'deduct' || (mode?.startsWith('freeze') && freezing);
    if (needsReason && text.trim().length < MIN_CARD_REASON_LENGTH) e.reason = `Write at least ${MIN_CARD_REASON_LENGTH} characters; the applicant sees this.`;
    if ((mode === 'approve' || mode === 'issue') && text.trim().length < MIN_CARD_REASON_LENGTH) e.message = `Write at least ${MIN_CARD_REASON_LENGTH} characters, e.g. the courier and the tracking link.`;
    if ((mode === 'approve' || mode === 'issue') && tracking.trim().length > MAX_TRACKING_REF_LENGTH) e.trackingRef = `At most ${MAX_TRACKING_REF_LENGTH} characters.`;
    if (mode === 'fund' || mode === 'deduct') { const n = Number(amount); if (!amount || !Number.isFinite(n) || n <= 0) e.amount = 'Enter an amount.'; }
    if (mode === 'issue') { const checked = checkAddress(address); if ('errors' in checked) Object.assign(e, checked.errors); }
    return e;
  };

  const submit = async () => {
    if (!mode) return;
    const found = validate();
    if (Object.keys(found).length) { setErrors(found); return; }
    if (!confirming) { setConfirming(true); return; }
    setBusy(true);
    const reason = text.trim();
    const value = Number(amount);
    const trackingRef = tracking.trim();
    const shipping = { message: reason, ...(trackingRef ? { trackingRef } : {}) };
    const now = () => new Date();
    const run = {
      'create-virtual': () => act(id, 'payments.process', 'Create virtual card', () => api.createVirtualCardAsStaff(id), (s, by) => staffCreateVirtualCard(s, fourDigits(), fourDigits(), by, now())),
      approve: () => act(id, 'payments.process', 'Approve physical card', () => api.approvePhysicalCard(id, shipping), (s, by) => approvePhysicalCard(s, fourDigits(), reason, trackingRef, by, now())),
      decline: () => act(id, 'payments.process', 'Decline physical card', () => api.declinePhysicalCard(id, { reason }), (s, by) => declinePhysicalCard(s, reason, by, now())),
      issue: () => {
        const checked = checkAddress(address);
        const clean = 'address' in checked ? checked.address : address;
        return act(id, 'payments.process', 'Issue physical card', () => api.issuePhysicalCard(id, { address: clean, ...shipping }), (s, by) => staffIssuePhysicalCard(s, clean, fourDigits(), reason, trackingRef, by, now()));
      },
      cancel: () => act(id, 'payments.process', 'Cancel physical card', () => api.cancelPhysicalCard(id, { reason }), (s, by) => cancelPhysicalCard(s, reason, by, now())),
      'freeze-virtual': () => act(id, 'accounts.manage', 'Change card freeze', () => api.setCardFreezeAsStaff(id, { card: 'virtual', frozen: freezing, ...(freezing ? { reason } : {}) }), s => staffSetCardFreeze(s, 'virtual', freezing, reason, now())),
      'freeze-physical': () => act(id, 'accounts.manage', 'Change card freeze', () => api.setCardFreezeAsStaff(id, { card: 'physical', frozen: freezing, ...(freezing ? { reason } : {}) }), s => staffSetCardFreeze(s, 'physical', freezing, reason, now())),
      fund: () => act(id, 'payments.process', 'Fund card', () => api.fundCardAsStaff(id, { amount: value, source: move, reason }), (s, by) => staffFundCard(s, value, move, reason, by, now())),
      deduct: () => act(id, 'payments.process', 'Deduct from card', () => api.deductFromCard(id, { amount: value, destination: move, reason }), (s, by) => staffDeductCard(s, value, move, reason, by, now())),
    } satisfies Record<Mode, () => Promise<Outcome>>;
    const outcome = await run[mode]();
    setBusy(false); setConfirming(false);
    if (!outcome.ok) { setErrors(outcome.fieldErrors ?? {}); setFlash({ tone: 'error', text: outcome.error }); return; }
    setMode(null); setText(''); setTracking(''); setAmount(''); setErrors({}); setFlash({ tone: 'ok', text: outcome.message });
  };

  const facts: [string, string][] = [
    ['Card balance', usd(holder.balance)],
    ['Funding allowed', FUNDING_LABELS[holder.settings.funding]],
    ['Identity check for cards', holder.settings.kycRequired ? 'Required' : 'Not required'],
    ['Virtual card', virtual ? `•••• ${virtual.lastFour} · limit $${virtual.dailyLimit.toLocaleString('en-US')}/day${virtual.createdBy ? ` · created by ${virtual.createdBy}` : ''}` : 'Not created yet'],
    ...(virtual ? [['Virtual freeze', `${freezeLabel(virtual)}${virtual.frozenReason ? ` — "${virtual.frozenReason}"` : ''}`] as [string, string]] : []),
    ['Physical card', `${PHYSICAL_LABEL[physical.status]}${physical.lastFour ? ` · •••• ${physical.lastFour}` : ''}${physical.issuedBy ? ` · issued by ${physical.issuedBy}` : ''}`],
    ...(physical.shippingAddress && physical.status !== 'Not requested' ? [['Shipping address', formatAddress(physical.shippingAddress)] as [string, string]] : []),
    ...(physical.requestedAt && physical.status !== 'Not requested' ? [[physical.issuedBy ? 'Issued' : 'Applied', when(physical.requestedAt)] as [string, string]] : []),
    ...(physical.shippedAt ? [['Shipped', `${when(physical.shippedAt)}${physical.shippedBy ? ` by ${physical.shippedBy}` : ''}`] as [string, string]] : []),
    ...(physical.trackingRef ? [['Tracking', physical.trackingRef] as [string, string]] : []),
    ...(physical.shippingMessage ? [['Message sent', physical.shippingMessage] as [string, string]] : []),
    ...(physical.activatedAt ? [['Activated', when(physical.activatedAt)] as [string, string]] : []),
    ...(physical.status === 'Active' ? [['Physical freeze', `${freezeLabel(physical)}${physical.frozenReason ? ` — "${physical.frozenReason}"` : ''}`] as [string, string]] : []),
    ...(physical.status === 'Declined' ? [['Declined', `${physical.declinedAt ? when(physical.declinedAt) : ''}${physical.declinedBy ? ` by ${physical.declinedBy}` : ''}: ${physical.declineReason ?? ''}`] as [string, string]] : []),
    ...(physical.status === 'Cancelled' ? [['Cancelled', `${physical.cancelledAt ? when(physical.cancelledAt) : ''}${physical.cancelledBy ? ` by ${physical.cancelledBy}` : ''}: ${physical.cancelReason ?? ''}`] as [string, string]] : []),
  ];

  const confirmLabel: Record<Mode, string> = {
    'create-virtual': 'Confirm: create card', approve: 'Confirm: approve and send message', decline: 'Confirm decline and refund', issue: 'Confirm: issue and send message',
    cancel: 'Confirm cancellation', 'freeze-virtual': freezing ? 'Confirm freeze' : 'Confirm: lift freeze', 'freeze-physical': freezing ? 'Confirm freeze' : 'Confirm: lift freeze',
    fund: `Confirm: add ${amount ? usd(Number(amount) || 0) : ''}`, deduct: `Confirm: deduct ${amount ? usd(Number(amount) || 0) : ''}`,
  };
  const reasonLabel: Partial<Record<Mode, string>> = {
    decline: 'Why is the application declined? (emailed to the applicant; the fee is refunded)', cancel: 'Why is the card being cancelled? (sent to the applicant; no refund)',
    'freeze-virtual': 'Note the applicant sees when they try to unfreeze', 'freeze-physical': 'Note the applicant sees when they try to unfreeze',
    fund: 'Reason (sent to the applicant)', deduct: 'Reason (sent to the applicant)',
  };
  const field = (key: string, node: React.ReactNode, label: string, hint?: string) => <label className="admin-review-field" key={key}><span>{label}</span>{node}<small className={errors[key] ? 'admin-field-error' : ''}>{errors[key] ?? hint ?? ''}</small></label>;
  const onText = (set: (v: string) => void, key: string) => (e: { target: { value: string } }) => { set(e.target.value); setConfirming(false); setErrors(({ [key]: _, ...rest }) => rest); };

  return <>
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-card-flash">{flash.text}</div>}
    <dl className="admin-detail-fields">{facts.map(([k, v]) => <div className="admin-detail-field" key={k}><dt>{k}</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{v}</dd></div>)}</dl>
    <section className="admin-review-section admin-review-actions" aria-label="Manage cards">
      <h3>Manage</h3>
      {actingStaff(state) && !connected && <p className="admin-review-hint">Acting as <strong>{actingStaff(state)!.name}</strong>.</p>}
      <div className="admin-chip-row" role="tablist" aria-label="Card action" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{actions.map(a => <button type="button" role="tab" key={a.key} aria-selected={mode === a.key} className={`admin-btn ${mode === a.key ? 'primary' : ''}`} onClick={() => pick(mode === a.key ? null : a.key)} data-testid={`tab-admin-card-${a.key}`}>{a.label}</button>)}</div>
      {current && mode && <>
        <RoleNotice permission={current.permission} />
        {mode === 'create-virtual' && <p className="admin-review-hint">Creates the virtual card now (a random card ending and PIN; the PIN is shown only to the applicant). The applicant is notified. Staff aren't held to the identity-check rule.</p>}
        {(mode === 'fund' || mode === 'deduct') && <div className="admin-form-row">
          {field('amount', <input className="admin-input" type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={onText(setAmount, 'amount')} aria-invalid={!!errors.amount} data-testid="input-admin-card-amount" />, 'Amount (USD)', mode === 'deduct' ? `Up to ${usd(holder.balance)}.` : undefined)}
          {field('source', <select className="admin-input" value={move} onChange={e => { setMove(e.target.value as CardCounterpart); setConfirming(false); }} data-testid="select-admin-card-move">{MOVE_OPTIONS[mode].map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>, mode === 'fund' ? 'Where the money comes from' : 'Where the money goes',
            move === 'none' ? (mode === 'fund' ? 'New money: no balance of the applicant goes down.' : 'The money leaves the applicant’s account.') : `Moves money between the card and the applicant's ${COUNTERPART_LABELS[move]}.`)}
        </div>}
        {mode === 'issue' && <div className="admin-form-row" style={{ flexWrap: 'wrap' }}>{ADDRESS_FIELDS.map(f => field(f.key, <input className="admin-input" value={address[f.key] ?? ''} onChange={e => { setAddress(a => ({ ...a, [f.key]: e.target.value })); setConfirming(false); setErrors(({ [f.key]: _, ...rest }) => rest); }} aria-invalid={!!errors[f.key]} data-testid={`input-admin-ship-${f.key}`} />, `${f.label}${f.optional ? ' (optional)' : ''}`))}</div>}
        {(mode === 'approve' || mode === 'issue') && <>
          {field('message', <textarea className="admin-input" rows={5} maxLength={MAX_SHIPPING_MESSAGE_LENGTH} value={text} onChange={onText(setText, 'message')} aria-invalid={!!errors.message} placeholder={'Your card is on its way with [courier]. Track it here: [link]'} data-testid="textarea-admin-card-message" />,
            'Message to the applicant (emailed, even if they turned email copies off)', `Include the courier and tracking number or link. Up to ${MAX_SHIPPING_MESSAGE_LENGTH} characters.`)}
          {field('trackingRef', <input className="admin-input" maxLength={MAX_TRACKING_REF_LENGTH} value={tracking} onChange={onText(setTracking, 'trackingRef')} aria-invalid={!!errors.trackingRef} placeholder="Tracking number or https:// link" data-testid="input-admin-card-tracking" />,
            'Tracking number or link (optional)', 'Also shown on the applicant’s Cards page; a link becomes a "Track delivery" button.')}
          <p className="admin-review-hint">No card issuer is connected: arrange the card and courier outside the app. The card's ending is assigned now and the applicant activates it with those digits.</p>
        </>}
        {reasonLabel[mode] && (!mode.startsWith('freeze') || freezing) && field('reason', <textarea className="admin-input" rows={3} value={text} onChange={onText(setText, 'reason')} aria-invalid={!!errors.reason} data-testid="textarea-admin-card-reason" />, reasonLabel[mode]!, `At least ${MIN_CARD_REASON_LENGTH} characters.${mode.startsWith('freeze') ? ' The card stays frozen until staff lift the freeze.' : ''}`)}
        {mode.startsWith('freeze') && !freezing && <p className="admin-review-hint">Lifts the staff freeze; the applicant is told the card can be used again.</p>}
        <div className="admin-review-buttons">
          {confirming && <button type="button" className="admin-btn" onClick={() => setConfirming(false)} data-testid="button-admin-card-back">Back</button>}
          <button type="button" className={`admin-btn ${mode === 'decline' || mode === 'cancel' || mode === 'deduct' || (mode.startsWith('freeze') && freezing) ? 'danger' : 'primary'}`} disabled={!can(current.permission) || busy} onClick={() => void submit()} data-testid="button-admin-card-submit">{confirming ? confirmLabel[mode] : current.label}</button>
        </div>
      </>}
    </section>
    <div className="admin-detail-note"><Info size={17} /><span>{connected
      ? 'Cards are fictional: no card issuer or network is connected. Every change is saved on the server, role-checked, audited, and sent to the applicant. Staff never see card PINs.'
      : 'Demo card workflow. Only the demo applicant has cards; changes are saved in this browser only, role-checked, and audited.'}</span></div>
  </>;
}

/** Staff choose which balances this applicant may fund their card from, and whether cards need a verified identity. */
export function CardSettingsEditor({ applicantId, settings, onSaved }: { applicantId: string; settings: CardSettings; onSaved?: () => void }) {
  const { run } = useDemoStore();
  const { connected, refreshApplicants } = useServerData();
  const command = useStaffCommand();
  const can = useCan();
  const [funding, setFunding] = useState<CardFunding>(settings.funding);
  const [kycRequired, setKycRequired] = useState(settings.kycRequired);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => { setFunding(settings.funding); setKycRequired(settings.kycRequired); }, [settings.funding, settings.kycRequired]);
  const changed = funding !== settings.funding || kycRequired !== settings.kycRequired;
  const save = async () => {
    const next = { funding, kycRequired };
    if (!connected) {
      const result = command('accounts.manage', { action: 'Change card settings', target: applicantId }, s => setCardSettings(s, applicantId, next, new Date()));
      setFlash(result.ok ? { tone: 'ok', text: result.message } : { tone: 'error', text: result.error });
      return;
    }
    setBusy(true);
    try {
      const res = await api.setCardSettings(applicantId, next);
      run(s => adoptServerApplicant(s, toServerApplicant(res.applicant)));
      setFlash({ tone: 'ok', text: res.message }); onSaved?.();
    } catch (err) {
      const failure = apiError(err, "Couldn't reach the server. Nothing was changed; try again.");
      if (failure.status === 409) void refreshApplicants();
      setFlash({ tone: 'error', text: failure.error });
    } finally { setBusy(false); }
  };
  const allowed = can('accounts.manage');
  return <section className="admin-review-section admin-review-actions" aria-label="Card settings" data-testid="section-admin-card-settings"><h3>Card settings</h3>
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-card-settings-flash">{flash.text}</div>}
    <div className="admin-form-row">
      <label className="admin-review-field"><span>The applicant may fund their card from</span><select className="admin-input" value={funding} disabled={!allowed} onChange={e => setFunding(e.target.value as CardFunding)} data-testid="select-admin-card-funding">{(Object.keys(FUNDING_LABELS) as CardFunding[]).map(f => <option key={f} value={f}>{FUNDING_LABELS[f]}</option>)}</select><small>Staff can fund from either balance, or without one.</small></label>
      <label className="admin-review-field"><span>Identity check before creating cards</span><select className="admin-input" value={kycRequired ? 'yes' : 'no'} disabled={!allowed} onChange={e => setKycRequired(e.target.value === 'yes')} data-testid="select-admin-card-kyc"><option value="no">Not required</option><option value="yes">Required: verified identity first</option></select><small>Applies when the applicant creates a card or applies for a physical one.</small></label>
    </div>
    <RoleNotice permission="accounts.manage" />
    <div className="admin-review-buttons"><button type="button" className="admin-btn primary" disabled={!allowed || !changed || busy} onClick={() => void save()} data-testid="button-admin-save-card-settings">Save card settings</button></div>
  </section>;
}

/** Card settings for any applicant: the holder's (signed in) or the stored account (demo). */
export function cardSettingsFor(state: ReturnType<typeof useDemoStore>['state'], applicantId: string, holder: CardHolder | null): CardSettings {
  return holder?.settings ?? findApplicant(state, applicantId)?.account.cardSettings ?? DEFAULT_CARD_SETTINGS;
}
