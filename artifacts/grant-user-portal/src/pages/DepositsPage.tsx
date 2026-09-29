import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { format } from 'date-fns';
import {
  ArrowLeft, ArrowRight, Banknote, Check, CircleAlert, Clock3, Copy, CreditCard, FileText, Landmark, LoaderCircle, Plus, Receipt, ShieldCheck, Smartphone, Wallet, X,
} from 'lucide-react';
import * as api from '@workspace/api-client-react';
import { accountLockReason, permissionBlocker } from '@workspace/domain/applicants';
import { cancelDeposit, DEPOSIT_METHODS, MAX_PENDING_DEPOSITS, requestDeposit, validateDeposit, type DepositMethod } from '@workspace/domain/deposits';
import type { DepositMethodId, Transaction, TransactionStatus } from '@workspace/domain/model';
import { computeBalances, ownTransactions } from '@workspace/domain/rules';
import { useMoneyAction, useServerData } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import './DepositsPage.css';

// The applicant's Add funds page (/deposits): the deposit balance and its
// reserve, a three-step flow to announce a transfer (amount → method → review)
// that ends with the payment reference and receiving details, what the deposit
// balance pays for, and the deposit history. Nothing moves money here: the
// balance is credited when finance confirms the transfer arrived. Signed in,
// requests go through the API; in the browser-only preview, the same rules run
// on the sample data.

type Toast = (message: string) => void;
type Step = 'amount' | 'method' | 'review';
type Filter = 'all' | 'pending' | 'completed' | 'failed' | 'cancelled';

const STEPS: { id: Step; label: string }[] = [{ id: 'amount', label: 'Amount' }, { id: 'method', label: 'Method' }, { id: 'review', label: 'Review' }];
const QUICK_AMOUNTS = [50, 100, 250, 500, 1000];
const FILTERS: { id: Filter; label: string; status?: TransactionStatus }[] = [
  { id: 'all', label: 'All' }, { id: 'pending', label: 'Pending', status: 'Pending' }, { id: 'completed', label: 'Credited', status: 'Completed' },
  { id: 'failed', label: 'Not credited', status: 'Failed' }, { id: 'cancelled', label: 'Cancelled', status: 'Cancelled' },
];
const STATUS_LABEL: Record<TransactionStatus, string> = { Pending: 'Awaiting confirmation', Completed: 'Credited', Failed: 'Not credited', Cancelled: 'Cancelled' };
const STATUS_TONE: Record<TransactionStatus, string> = { Pending: 'warn', Completed: 'ok', Failed: 'bad', Cancelled: 'muted' };

const usd = (amount: number) => `${amount < 0 ? '−' : ''}$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortUsd = (amount: number) => `$${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const fmtDateTime = (iso: string) => format(new Date(iso), 'MMM d, yyyy · HH:mm');
const methodOf = (id?: string): DepositMethod | undefined => DEPOSIT_METHODS.find(m => m.id === id);
const MethodIcon = ({ id, size = 16 }: { id?: string; size?: number }) => id === 'mobile' ? <Smartphone size={size} aria-hidden="true" /> : <Landmark size={size} aria-hidden="true" />;

function Pill({ tone, children, testId }: { tone: string; children: ReactNode; testId?: string }) {
  return <span className={`dp-pill ${tone}`} data-testid={testId}>{children}</span>;
}

/** Copies text, with a fallback for browsers without the async clipboard (or without permission). */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try {
    const area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch { return false; }
}

function CopyButton({ text, what, onToast, testId }: { text: string; what: string; onToast: Toast; testId: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(t); }, [copied]);
  return <button type="button" className="dp-copy" onClick={async () => { const ok = await copyText(text); setCopied(ok); onToast(ok ? `${what} copied.` : `Couldn't copy the ${what.toLowerCase()}. Select it and copy it yourself.`); }}
    aria-label={`Copy ${what.toLowerCase()}`} data-testid={testId}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy'}</button>;
}

// ---------- Balance hero ----------

function BalanceHero({ deposit, pending, grant, reserve, open }: { deposit: number; pending: number; grant: number; reserve: number; open: number }) {
  const covered = deposit >= reserve;
  const fill = reserve > 0 ? Math.min(100, Math.round((Math.max(deposit, 0) / reserve) * 100)) : 100;
  return <section className="dp-hero" aria-labelledby="dp-hero-title">
    <div className="dp-hero-glow" aria-hidden="true" />
    <div className="dp-hero-main">
      <p className="dp-eyebrow" id="dp-hero-title"><Wallet size={14} aria-hidden="true" /> Deposit balance</p>
      <p className="dp-hero-amount" data-testid="text-deposit-balance">{usd(deposit)}</p>
      <p className="dp-hero-sub">Confirmed funds you've added. Used for card fees, application fees, and the payout reserve.</p>
    </div>
    <div className="dp-hero-stats">
      <div className="dp-stat"><span>Awaiting confirmation</span><strong data-testid="text-pending-deposits">{usd(pending)}</strong><small data-testid="text-open-deposits">{open} of {MAX_PENDING_DEPOSITS} open deposits</small></div>
      <div className="dp-stat"><span>Grant balance</span><strong data-testid="text-grant-balance">{usd(grant)}</strong><small>Awarded funds, kept separately</small></div>
    </div>
    <div className="dp-reserve" data-testid="status-reserve" data-covered={covered}>
      <div className="dp-reserve-head"><span><ShieldCheck size={14} aria-hidden="true" /> Required reserve · {usd(reserve)}</span>
        <strong>{covered ? 'Covered' : `Add ${usd(reserve - Math.max(deposit, 0))} to cover it`}</strong></div>
      <div className="dp-meter" role="meter" aria-label="Reserve covered" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fill}><span style={{ width: `${fill}%` }} /></div>
      <small>The reserve stays in your deposit balance so you can request payouts and a physical card.</small>
    </div>
  </section>;
}

// ---------- New deposit ----------

function Stepper({ step }: { step: Step }) {
  const at = STEPS.findIndex(s => s.id === step);
  return <ol className="dp-steps" aria-label="New deposit steps">
    {STEPS.map((s, i) => <li key={s.id} className={i < at ? 'done' : i === at ? 'current' : ''} aria-current={i === at ? 'step' : undefined} data-testid={`step-${s.id}`}>
      <span className="dp-step-dot">{i < at ? <Check size={12} /> : i + 1}</span><span className="dp-step-label">{s.label}</span>
    </li>)}
  </ol>;
}

function Instructions({ tx, onToast, onDone }: { tx: Transaction; onToast: Toast; onDone?: () => void }) {
  const method = methodOf(tx.method);
  const reference = tx.reference ?? tx.id;
  return <div className="dp-instructions" data-testid="panel-deposit-instructions">
    <div className="dp-instructions-head">
      <span className="dp-success-icon"><Check size={18} /></span>
      <div><h3>Send {usd(tx.amount)} with this reference</h3><p>Your deposit is recorded. It's added to your balance once finance confirms the transfer arrived.</p></div>
    </div>
    <div className="dp-ref-box">
      <span>Payment reference</span>
      <strong className="dp-mono" data-testid="text-deposit-reference">{reference}</strong>
      <CopyButton text={reference} what="Reference" onToast={onToast} testId="button-copy-reference" />
    </div>
    <dl className="dp-details">
      <div><dt>Amount</dt><dd data-testid="text-instructions-amount">{usd(tx.amount)}</dd></div>
      <div><dt>Method</dt><dd><MethodIcon id={tx.method} size={14} /> {method?.name ?? 'Transfer'}</dd></div>
      <div className="dp-details-wide"><dt>Pay to</dt><dd><span data-testid="text-deposit-payto">{method?.payTo ?? '—'}</span>{method && <CopyButton text={method.payTo} what="Payment details" onToast={onToast} testId="button-copy-payto" />}</dd></div>
      <div><dt>Usually arrives</dt><dd>{method?.timing ?? '—'}</dd></div>
      <div><dt>Status</dt><dd><Pill tone="warn">{STATUS_LABEL[tx.status]}</Pill></dd></div>
    </dl>
    <p className="dp-note"><CircleAlert size={14} aria-hidden="true" /> Include the reference exactly as shown, or finance can't match your transfer to your account.</p>
    {onDone && <div className="dp-actions"><button type="button" className="dp-btn primary" onClick={onDone} data-testid="button-new-deposit"><Plus size={14} /> Make another deposit</button></div>}
  </div>;
}

function NewDeposit({ onToast }: { onToast: Toast }) {
  const { state } = useDemoStore();
  const moneyAction = useMoneyAction();
  const { treasury } = state;
  const [step, setStep] = useState<Step>('amount');
  const [amount, setAmount] = useState('');
  const [methodId, setMethodId] = useState<DepositMethodId>('bank');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorId = useId();

  const value = amount.trim() === '' ? NaN : Number(amount);
  const method = methodOf(methodId)!;
  const created = createdId ? ownTransactions(state).find(t => t.id === createdId) : undefined;
  const blocked = accountLockReason(state) ?? permissionBlocker(state, 'deposit');
  const open = ownTransactions(state).filter(t => t.type === 'Deposit' && t.status === 'Pending').length;
  const quick = QUICK_AMOUNTS.filter(a => a >= treasury.minDeposit && a <= treasury.maxDeposit);

  // Move focus to the new step's heading so keyboard and screen-reader users follow along.
  const go = (next: Step) => { setStep(next); requestAnimationFrame(() => headingRef.current?.focus()); };
  const checkAmount = () => {
    const problem = validateDeposit(state, value);
    if (problem) { setError(problem); amountRef.current?.focus(); return false; }
    setError(null); return true;
  };
  const submit = async () => {
    if (!checkAmount()) { go('amount'); return; }
    setBusy(true);
    const result = await moneyAction(s => requestDeposit(s, value, methodId, new Date()), () => api.requestDeposit({ amount: value, method: methodId }));
    setBusy(false);
    if (!result.ok) { setError(result.fieldErrors?.['amount'] ?? result.error); go('amount'); return; }
    setCreatedId(result.id ?? null);
    onToast(result.message);
  };
  const restart = () => { setCreatedId(null); setAmount(''); setMethodId('bank'); setError(null); go('amount'); };
  // Cancelled (or confirmed) from the history while its instructions were showing: start a fresh deposit
  // rather than falling back to the old review step, where it could be sent again by mistake.
  const settled = !!created && created.status !== 'Pending';
  useEffect(() => { if (settled) { setCreatedId(null); setAmount(''); setMethodId('bank'); setError(null); setStep('amount'); } }, [settled]);

  if (created && created.status === 'Pending') {
    return <section className="dp-card dp-pad" aria-label="New deposit" data-testid="card-new-deposit"><Instructions tx={created} onToast={onToast} onDone={restart} /></section>;
  }

  return <section className="dp-card dp-pad" aria-labelledby="dp-new-title" data-testid="card-new-deposit">
    <div className="dp-card-head"><div><h2 id="dp-new-title">New deposit</h2><p>{usd(treasury.minDeposit)} – {usd(treasury.maxDeposit)} per deposit · no fee charged</p></div><Stepper step={step} /></div>
    {blocked && <div className="dp-alert" role="alert" data-testid="notice-deposit-blocked"><CircleAlert size={15} aria-hidden="true" /><span>{blocked}</span></div>}
    {!blocked && open >= MAX_PENDING_DEPOSITS && <div className="dp-alert" role="status" data-testid="notice-deposit-limit"><Clock3 size={15} aria-hidden="true" /><span>You have {open} deposits waiting to be confirmed, the most allowed at once. Cancel one below or wait for finance to confirm them.</span></div>}

    {step === 'amount' && <form className="dp-step-body" noValidate onSubmit={e => { e.preventDefault(); if (checkAmount()) go('method'); }}>
      <h3 ref={headingRef} tabIndex={-1} className="dp-step-title">How much are you adding?</h3>
      <label className="dp-label" htmlFor="deposit-amount">Amount (USD)</label>
      <div className={`dp-amount ${error ? 'invalid' : ''}`}>
        <span aria-hidden="true">$</span>
        <input ref={amountRef} id="deposit-amount" type="number" inputMode="decimal" min={treasury.minDeposit} max={treasury.maxDeposit} step="0.01" placeholder="0.00" autoComplete="off"
          value={amount} onChange={e => { setAmount(e.target.value); setError(null); }} aria-invalid={!!error} aria-describedby={error ? errorId : `${errorId}-hint`} data-testid="input-deposit-amount" />
        <small>USD</small>
      </div>
      {error ? <p className="dp-error" id={errorId} role="alert" data-testid="text-deposit-error">{error}</p> : <p className="dp-hint" id={`${errorId}-hint`}>Minimum {usd(treasury.minDeposit)}, maximum {usd(treasury.maxDeposit)}.</p>}
      <div className="dp-chips" role="group" aria-label="Quick amounts">{quick.map(a => <button key={a} type="button" className={`dp-chip ${value === a ? 'active' : ''}`} aria-pressed={value === a}
        onClick={() => { setAmount(String(a)); setError(null); }} data-testid={`button-quick-amount-${a}`}>{shortUsd(a)}</button>)}</div>
      <div className="dp-actions"><button type="submit" className="dp-btn primary" disabled={!!blocked} data-testid="button-deposit-continue">Continue <ArrowRight size={14} /></button></div>
    </form>}

    {step === 'method' && <form className="dp-step-body" onSubmit={e => { e.preventDefault(); go('review'); }}>
      <h3 ref={headingRef} tabIndex={-1} className="dp-step-title">How will you send {usd(value)}?</h3>
      <fieldset className="dp-methods"><legend className="dp-sr">Deposit method</legend>
        {DEPOSIT_METHODS.map(m => <label key={m.id} className={`dp-method ${methodId === m.id ? 'active' : ''}`}>
          <input type="radio" name="deposit-method" value={m.id} checked={methodId === m.id} onChange={() => setMethodId(m.id)} data-testid={`radio-deposit-${m.id}`} />
          <span className="dp-method-icon"><MethodIcon id={m.id} size={18} /></span>
          <span className="dp-method-copy"><strong>{m.name}</strong><small><Clock3 size={11} aria-hidden="true" /> {m.timing}</small></span>
          <span className="dp-radio" aria-hidden="true" />
        </label>)}
      </fieldset>
      <div className="dp-actions split"><button type="button" className="dp-btn ghost" onClick={() => go('amount')} data-testid="button-deposit-back"><ArrowLeft size={14} /> Back</button>
        <button type="submit" className="dp-btn primary" data-testid="button-deposit-continue">Continue <ArrowRight size={14} /></button></div>
    </form>}

    {step === 'review' && <form className="dp-step-body" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <h3 ref={headingRef} tabIndex={-1} className="dp-step-title">Review your deposit</h3>
      <dl className="dp-review" data-testid="panel-deposit-review">
        <div><dt>Amount</dt><dd className="dp-review-amount" data-testid="text-review-amount">{usd(value)}</dd></div>
        <div><dt>Method</dt><dd data-testid="text-review-method"><MethodIcon id={methodId} size={14} /> {method.name}</dd></div>
        <div><dt>Usually arrives</dt><dd>{method.timing}</dd></div>
        <div><dt>Fee</dt><dd>None</dd></div>
        <div><dt>Credited to</dt><dd>Deposit balance, once finance confirms</dd></div>
      </dl>
      <p className="dp-note"><FileText size={14} aria-hidden="true" /> Next you'll get a payment reference and the receiving details. Send the transfer from your own account and include the reference.</p>
      <div className="dp-actions split"><button type="button" className="dp-btn ghost" onClick={() => go('method')} disabled={busy} data-testid="button-deposit-back"><ArrowLeft size={14} /> Back</button>
        <button type="submit" className="dp-btn primary" disabled={busy || !!blocked} data-testid="button-submit-deposit">{busy ? <LoaderCircle size={14} className="dp-spin" /> : <Receipt size={14} />} Confirm and get reference</button></div>
    </form>}
  </section>;
}

// ---------- Side cards ----------

function HowItWorks() {
  const steps = [
    { title: 'Announce the deposit', body: 'Choose an amount and method here to get a payment reference.' },
    { title: 'Send the transfer', body: 'Pay the receiving details from your own account, quoting the reference.' },
    { title: 'Finance confirms it', body: 'The grant team matches your transfer by its reference.' },
    { title: 'Balance credited', body: "You're notified and the amount appears in your deposit balance." },
  ];
  return <section className="dp-card dp-pad" aria-labelledby="dp-how-title" data-testid="card-deposit-how">
    <div className="dp-card-head"><div><h2 id="dp-how-title">How deposits work</h2><p>Nothing is taken from your account automatically.</p></div></div>
    <ol className="dp-timeline">{steps.map((s, i) => <li key={s.title}><span className="dp-timeline-dot">{i + 1}</span><div><strong>{s.title}</strong><p>{s.body}</p></div></li>)}</ol>
  </section>;
}

function FeesCard() {
  const { state } = useDemoStore();
  const t = state.treasury;
  const rows: { icon: ReactNode; label: string; note: string; amount: string; testId: string }[] = [
    { icon: <ShieldCheck size={15} />, label: 'Payout reserve', note: 'Kept in your balance, not charged', amount: usd(t.depositThreshold), testId: 'fee-reserve' },
    { icon: <FileText size={15} />, label: 'Application fee', note: 'Charged once, when you first submit an application', amount: t.applicationFee > 0 ? usd(t.applicationFee) : 'None', testId: 'fee-application' },
    { icon: <CreditCard size={15} />, label: 'Physical card', note: 'Issuance fee', amount: usd(t.physicalCardFee), testId: 'fee-physical-card' },
    { icon: <Banknote size={15} />, label: 'Card delivery', note: 'Shipping for a physical card', amount: usd(t.cardDeliveryFee), testId: 'fee-card-delivery' },
  ];
  return <section className="dp-card dp-pad" aria-labelledby="dp-fees-title" data-testid="card-deposit-fees">
    <div className="dp-card-head"><div><h2 id="dp-fees-title">What your deposit balance pays for</h2><p>Set by the finance team. Grant funds are never used for these.</p></div></div>
    <ul className="dp-fees">{rows.map(r => <li key={r.label} data-testid={r.testId}><span className="dp-fee-icon">{r.icon}</span><div><strong>{r.label}</strong><small>{r.note}</small></div><b>{r.amount}</b></li>)}</ul>
  </section>;
}

// ---------- History ----------

function DetailsModal({ tx, onClose, onToast }: { tx: Transaction; onClose: () => void; onToast: Toast }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Kept in a ref so re-renders (toasts, background refreshes) don't re-run the focus handling below.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); returnTo?.focus?.(); };
  }, []);
  return <div className="dp-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="dp-modal" role="dialog" aria-modal="true" aria-label={`Payment details for ${tx.reference ?? tx.id}`} data-testid="modal-deposit-details">
      <div className="dp-modal-head"><button ref={closeRef} type="button" className="dp-icon-btn" onClick={onClose} aria-label="Close" data-testid="button-deposit-modal-close"><X size={16} /></button></div>
      <Instructions tx={tx} onToast={onToast} />
    </div>
  </div>;
}

function DepositRow({ tx, onCancel, onDetails }: { tx: Transaction; onCancel: (id: string) => Promise<void>; onDetails: (tx: Transaction) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const method = methodOf(tx.method);
  return <tr data-testid={`row-deposit-${tx.id}`} data-status={tx.status}>
    <td data-label="Reference"><span className="dp-mono dp-ref">{tx.reference ?? tx.id}</span></td>
    <td data-label="Method"><span className="dp-method-cell"><MethodIcon id={tx.method} size={14} />{method?.name ?? '—'}</span></td>
    <td data-label="Amount" className="dp-num">{usd(tx.amount)}</td>
    <td data-label="Date">{fmtDateTime(tx.createdAt)}</td>
    <td data-label="Status"><Pill tone={STATUS_TONE[tx.status]} testId={`status-deposit-${tx.id}`}>{STATUS_LABEL[tx.status]}</Pill>
      {tx.status === 'Failed' && tx.failureReason && <p className="dp-reason" data-testid={`text-deposit-reason-${tx.id}`}>{tx.failureReason}</p>}
      {tx.status === 'Completed' && tx.processedAt && <p className="dp-reason">Credited {format(new Date(tx.processedAt), 'MMM d, yyyy')}</p>}</td>
    <td data-label="" className="dp-row-actions">{tx.status === 'Pending' && (confirming
      ? <span className="dp-confirm"><span>Cancel this deposit?</span>
        <button type="button" className="dp-btn danger small" disabled={busy} onClick={async () => { setBusy(true); await onCancel(tx.id); setBusy(false); setConfirming(false); }} data-testid={`button-confirm-cancel-${tx.id}`}>{busy ? <LoaderCircle size={12} className="dp-spin" /> : null}Yes, cancel</button>
        <button type="button" className="dp-btn ghost small" disabled={busy} onClick={() => setConfirming(false)} data-testid={`button-keep-deposit-${tx.id}`}>Keep</button></span>
      : <span className="dp-confirm"><button type="button" className="dp-btn ghost small" onClick={() => onDetails(tx)} data-testid={`button-deposit-details-${tx.id}`}>Payment details</button>
        <button type="button" className="dp-text-btn" onClick={() => setConfirming(true)} data-testid={`button-cancel-${tx.id}`}>Cancel</button></span>)}</td>
  </tr>;
}

function DepositHistory({ onToast }: { onToast: Toast }) {
  const { state } = useDemoStore();
  const moneyAction = useMoneyAction();
  const [filter, setFilter] = useState<Filter>('all');
  const [details, setDetails] = useState<Transaction | null>(null);
  const deposits = useMemo(() => ownTransactions(state).filter(t => t.type === 'Deposit').sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(f => [f.id, f.status ? deposits.filter(d => d.status === f.status).length : deposits.length])) as Record<Filter, number>, [deposits]);
  const status = FILTERS.find(f => f.id === filter)!.status;
  const shown = status ? deposits.filter(d => d.status === status) : deposits;
  const cancel = async (id: string) => {
    const result = await moneyAction(s => cancelDeposit(s, id, new Date()), () => api.cancelDeposit(id));
    onToast(result.ok ? result.message : result.error);
  };
  return <section className="dp-card dp-pad" aria-labelledby="dp-history-title" data-testid="card-deposit-history">
    <div className="dp-card-head"><div><h2 id="dp-history-title">Your deposits</h2><p>Cancel a pending deposit if you decide not to send it.</p></div></div>
    <div className="dp-tabs" role="group" aria-label="Show deposits">{FILTERS.map(f => <button key={f.id} type="button" aria-pressed={filter === f.id} className={filter === f.id ? 'active' : ''}
      onClick={() => setFilter(f.id)} data-testid={`tab-deposits-${f.id}`}>{f.label}<span className="dp-count" aria-label={`${counts[f.id]} deposits`}>{counts[f.id]}</span></button>)}</div>
    <div className="dp-table-wrap">
      <table className="dp-table" data-testid="table-deposits">
        <thead><tr><th scope="col">Reference</th><th scope="col">Method</th><th scope="col" className="dp-num">Amount</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col"><span className="dp-sr">Actions</span></th></tr></thead>
        <tbody>{shown.length
          ? shown.map(tx => <DepositRow key={tx.id} tx={tx} onCancel={cancel} onDetails={setDetails} />)
          : <tr><td colSpan={6} className="dp-empty" data-testid="empty-deposits">{filter === 'all' ? "No deposits yet. Deposits you announce appear here." : `No ${FILTERS.find(f => f.id === filter)!.label.toLowerCase()} deposits.`}</td></tr>}</tbody>
      </table>
    </div>
    {details && <DetailsModal tx={details} onClose={() => setDetails(null)} onToast={onToast} />}
  </section>;
}

// ---------- The page ----------

export function DepositsPage({ onToast }: { onToast: Toast }) {
  const { state } = useDemoStore();
  const { connected } = useServerData();
  const own = ownTransactions(state);
  const balances = computeBalances(own);
  const open = own.filter(t => t.type === 'Deposit' && t.status === 'Pending').length;
  return <div className="dp-page" data-testid="page-deposits">
    <div className="dp-intro"><p>Top up your deposit balance by bank transfer or mobile money. {connected ? 'Requests are saved to your account and checked by the finance team.' : 'In this preview, deposits are saved in this browser only.'}</p></div>
    <BalanceHero deposit={balances.deposit} pending={balances.pendingDeposits} grant={balances.grant} reserve={state.treasury.depositThreshold} open={open} />
    <div className="dp-grid">
      <NewDeposit onToast={onToast} />
      <div className="dp-side"><HowItWorks /><FeesCard /></div>
    </div>
    <DepositHistory onToast={onToast} />
  </div>;
}
