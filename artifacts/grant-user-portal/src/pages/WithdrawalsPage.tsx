import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { format } from 'date-fns';
import { Link } from 'wouter';
import { ArrowLeft, ArrowRight, Check, CircleAlert, Clock3, FileText, Info, LoaderCircle, Plus, Receipt, ShieldCheck, Wallet, X } from 'lucide-react';
import * as api from '@workspace/api-client-react';
import type { PayoutBalance, Transaction, TransactionStatus, WithdrawalMethod } from '@workspace/domain/model';
import { availableFor, cancelWithdrawal, channelFee, enabledChannels, grantPayoutHold, payoutBlocker, requestWithdrawal, validateWithdrawal, withdrawalBalance } from '@workspace/domain/money';
import { computeBalances, ownTransactions } from '@workspace/domain/rules';
import { permissionsOf } from '@workspace/domain/applicants';
import { answerLimit, BALANCE_LABELS, chargesLabel, checkAnswers, methodBalances } from '@workspace/domain/withdrawalMethods';
import { MethodBadge } from '@/components/MethodBadge';
import { useMoneyAction, useServerData } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import './DepositsPage.css';
import './WithdrawalsPage.css';

// The applicant's Withdrawals page (/withdrawals): what can be withdrawn from
// each balance, a four-step request (method → amount and balance → the
// method's form → review), and the request history. Methods, with their
// limits, charges, processing time, instructions, balance, and form, are set
// by finance (Settings → Withdrawal methods); only available ones are shown.
// The form's answers are remembered per method and pre-filled next time.
// No payment provider is connected: finance sends the money and records it.

type Toast = (message: string) => void;
type Step = 'method' | 'amount' | 'details' | 'review';
type Filter = 'all' | 'pending' | 'paid' | 'failed' | 'cancelled';

const STEPS: { id: Step; label: string }[] = [{ id: 'method', label: 'Method' }, { id: 'amount', label: 'Amount' }, { id: 'details', label: 'Details' }, { id: 'review', label: 'Review' }];
const FILTERS: { id: Filter; label: string; status?: TransactionStatus }[] = [
  { id: 'all', label: 'All' }, { id: 'pending', label: 'Pending', status: 'Pending' }, { id: 'paid', label: 'Paid', status: 'Completed' },
  { id: 'failed', label: 'Failed', status: 'Failed' }, { id: 'cancelled', label: 'Cancelled', status: 'Cancelled' },
];
const STATUS_LABEL: Record<TransactionStatus, string> = { Pending: 'Pending', Completed: 'Paid', Failed: 'Failed', Cancelled: 'Cancelled' };
const STATUS_TONE: Record<TransactionStatus, string> = { Pending: 'warn', Completed: 'ok', Failed: 'bad', Cancelled: 'muted' };

const usd = (amount: number) => `${amount < 0 ? '−' : ''}$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDateTime = (iso: string) => format(new Date(iso), 'MMM d, yyyy · HH:mm');
const gross = (tx: Transaction) => Math.abs(tx.amount);
const net = (tx: Transaction) => Math.round((gross(tx) - (tx.fee ?? 0)) * 100) / 100;

function Pill({ tone, children, testId }: { tone: string; children: ReactNode; testId?: string }) {
  return <span className={`dp-pill ${tone}`} data-testid={testId}>{children}</span>;
}

function Stepper({ step }: { step: Step }) {
  const at = STEPS.findIndex(s => s.id === step);
  return <ol className="dp-steps" aria-label="Withdrawal steps">
    {STEPS.map((s, i) => <li key={s.id} className={i < at ? 'done' : i === at ? 'current' : ''} aria-current={i === at ? 'step' : undefined} data-testid={`step-${s.id}`}>
      <span className="dp-step-dot">{i < at ? <Check size={12} /> : i + 1}</span><span className="dp-step-label">{s.label}</span>
    </li>)}
  </ol>;
}

// ---------- Balances ----------

function BalanceHero() {
  const { state } = useDemoStore();
  const balances = computeBalances(ownTransactions(state));
  const pending = ownTransactions(state).filter(t => t.type === 'Withdrawal' && t.status === 'Pending');
  const reserve = state.treasury.depositThreshold;
  const hold = grantPayoutHold(state);
  return <section className="dp-hero wd-hero" aria-labelledby="wd-hero-title">
    <div className="dp-hero-glow" aria-hidden="true" />
    <div className="dp-hero-main">
      <p className="dp-eyebrow" id="wd-hero-title"><Wallet size={14} aria-hidden="true" /> Available to withdraw</p>
      <p className="dp-hero-amount" data-testid="text-withdraw-grant">{usd(availableFor(state, 'grant'))}</p>
      <p className="dp-hero-sub" data-testid="text-withdraw-hold">{hold ?? `From your grant balance. Methods that pay from your deposit balance can use what's above the ${usd(reserve)} reserve.`}</p>
    </div>
    <div className="dp-hero-stats">
      <div className="dp-stat"><span>Deposit balance available</span><strong data-testid="text-withdraw-deposit-available">{usd(availableFor(state, 'deposit'))}</strong><small>{balances.deposit < 0 ? `${usd(balances.deposit)}: below zero, a deposit clears it` : `${usd(balances.deposit)} held, ${usd(reserve)} reserve kept`}</small></div>
      <div className="dp-stat"><span>Pending payouts</span><strong data-testid="text-withdraw-pending">{usd(pending.reduce((sum, t) => sum + gross(t), 0))}</strong><small data-testid="text-withdraw-pending-count">{pending.length} request{pending.length === 1 ? '' : 's'} with finance</small></div>
    </div>
  </section>;
}

// ---------- The request ----------

/** The method's form, rendered from its definition. */
function DetailsForm({ method, answers, errors, onChange, prefilled }: { method: WithdrawalMethod; answers: Record<string, string>; errors: Record<string, string>; onChange: (id: string, value: string) => void; prefilled: boolean }) {
  const uid = useId();
  return <div className="wd-form" data-testid="form-payout-details">
    {method.instructions && <p className="dp-note wd-instructions" data-testid="text-method-instructions"><Info size={14} aria-hidden="true" /> {method.instructions}</p>}
    {prefilled && <p className="dp-hint" data-testid="note-details-prefilled">Filled in from your last {method.name} request. Check they're still right.</p>}
    {method.fields.map(f => {
      const id = `${uid}-${f.id}`;
      const error = errors[`details.${f.id}`];
      const common = { id, value: answers[f.id] ?? '', 'aria-invalid': !!error, 'aria-describedby': error ? `${id}-error` : f.help ? `${id}-help` : undefined, 'data-testid': `input-detail-${f.id}`, maxLength: answerLimit(f.type) };
      return <div className="wd-field" key={f.id}>
        <label className="dp-label" htmlFor={id}>{f.label}{f.required ? <span aria-hidden="true"> *</span> : <span className="wd-optional"> (optional)</span>}</label>
        {f.type === 'textarea' ? <textarea className="wd-input" rows={3} placeholder={f.placeholder} required={f.required} onChange={e => onChange(f.id, e.target.value)} {...common} />
          : f.type === 'select' ? <select className="wd-input" required={f.required} onChange={e => onChange(f.id, e.target.value)} {...common}><option value="">Choose…</option>{f.options.map(o => <option key={o} value={o}>{o}</option>)}</select>
            : <input className="wd-input" type={f.type === 'email' ? 'email' : 'text'} inputMode={f.type === 'number' ? 'decimal' : f.type === 'email' ? 'email' : undefined} autoComplete={f.type === 'email' ? 'email' : 'off'} placeholder={f.placeholder} required={f.required} onChange={e => onChange(f.id, e.target.value)} {...common} />}
        {error ? <p className="dp-error" id={`${id}-error`} role="alert" data-testid={`text-detail-error-${f.id}`}>{error}</p> : f.help ? <p className="dp-hint" id={`${id}-help`}>{f.help}</p> : null}
      </div>;
    })}
  </div>;
}

function Success({ tx, method, onDone }: { tx: Transaction; method?: WithdrawalMethod; onDone: () => void }) {
  return <div className="dp-instructions" data-testid="panel-withdraw-success">
    <div className="dp-instructions-head"><span className="dp-success-icon"><Check size={18} /></span>
      <div><h3>Request {tx.id} sent to finance</h3><p>It's pending until the finance team sends the money. {method ? `${method.name} usually takes ${method.processingTime.toLowerCase()}.` : ''} We'll let you know when it's sent.</p></div></div>
    <dl className="dp-details">
      <div><dt>You requested</dt><dd data-testid="text-success-amount">{usd(gross(tx))}</dd></div>
      <div><dt>You receive</dt><dd data-testid="text-success-net">{usd(net(tx))}</dd></div>
      <div><dt>Method</dt><dd>{tx.description.replace(/^Payout to /, '')}</dd></div>
      <div><dt>Paid from</dt><dd>{BALANCE_LABELS[withdrawalBalance(tx)]}</dd></div>
    </dl>
    <div className="dp-actions"><button type="button" className="dp-btn primary" onClick={onDone} data-testid="button-new-withdrawal"><Plus size={14} /> Make another request</button></div>
  </div>;
}

function NewWithdrawal({ onToast }: { onToast: Toast }) {
  const { state } = useDemoStore();
  const moneyAction = useMoneyAction();
  const methods = enabledChannels(state);
  const blocker = payoutBlocker(state);
  const [step, setStep] = useState<Step>('method');
  const [methodId, setMethodId] = useState<string | null>(null);
  const [source, setSource] = useState<PayoutBalance | null>(null);
  const [amount, setAmount] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [prefilled, setPrefilled] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const uid = useId();

  const method = methodId ? methods.find(m => m.id === methodId) : undefined;
  const balances = method ? methodBalances(method) : [];
  const chosen: PayoutBalance | undefined = source ?? (balances.length === 1 ? balances[0] : undefined);
  const value = amount.trim() === '' ? NaN : Number(amount);
  const fee = method ? channelFee(method, value) : 0;
  const created = createdId ? ownTransactions(state).find(t => t.id === createdId) : undefined;

  // A method finance hid or deleted while the applicant was choosing: start again.
  useEffect(() => { if (methodId && !method && !createdId) { setMethodId(null); setStep('method'); } }, [methodId, method, createdId]);

  const go = (next: Step) => { setStep(next); requestAnimationFrame(() => headingRef.current?.focus()); };
  const pickMethod = (m: WithdrawalMethod) => {
    setMethodId(m.id);
    setSource(null);
    const saved = state.savedPayoutDetails[m.id] ?? {};
    const filled = Object.fromEntries(m.fields.filter(f => saved[f.id]).map(f => [f.id, saved[f.id]!]));
    setAnswers(filled); setPrefilled(Object.keys(filled).length > 0); setErrors({});
  };
  const checkAmount = () => {
    if (!method) return false;
    const problem = validateWithdrawal(state, value, method.id, chosen);
    if (problem) { setErrors({ amount: problem }); amountRef.current?.focus(); return false; }
    setErrors({}); return true;
  };
  const checkDetails = () => {
    if (!method) return false;
    const checked = checkAnswers(method, answers);
    if ('errors' in checked) { setErrors(checked.errors); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="input-detail-${Object.keys(checked.errors)[0]!.slice(8)}"]`)?.focus()); return false; }
    setErrors({}); return true;
  };
  const submit = async () => {
    if (!method || !chosen) return;
    if (!checkAmount()) { go('amount'); return; }
    if (!checkDetails()) { go('details'); return; }
    setBusy(true);
    const input = { amount: value, method: method.id, source: chosen, details: answers };
    const result = await moneyAction(s => requestWithdrawal(s, input, new Date()), () => api.requestWithdrawal({ amount: value, channel: method.id, source: chosen, details: answers }));
    setBusy(false);
    if (!result.ok) {
      const fieldErrors = result.fieldErrors ?? {};
      setErrors(Object.keys(fieldErrors).length ? fieldErrors : { amount: result.error });
      go(Object.keys(fieldErrors).some(k => k.startsWith('details.')) ? 'details' : 'amount');
      return;
    }
    setCreatedId(result.id ?? null);
    onToast(`${result.message} The finance team will process it.`);
  };
  const restart = () => { setCreatedId(null); setMethodId(null); setSource(null); setAmount(''); setAnswers({}); setErrors({}); go('method'); };

  if (created) return <section className="dp-card dp-pad" aria-label="New withdrawal" data-testid="card-new-withdrawal"><Success tx={created} method={state.treasury.channels.find(m => m.id === created.method)} onDone={restart} /></section>;

  return <section className="dp-card dp-pad" aria-labelledby="wd-new-title" data-testid="card-new-withdrawal">
    <div className="dp-card-head"><div><h2 id="wd-new-title">New withdrawal</h2><p>Finance reviews every request and sends the money.</p></div><Stepper step={step} /></div>
    {blocker && <div className="dp-alert" role="alert" data-testid="notice-payout-blocked"><CircleAlert size={15} aria-hidden="true" /><span>{blocker}{blocker.includes('deposit balance') && <> <Link className="wd-link" href="/deposits">Add funds</Link></>}{blocker.includes('Verify your identity') && <> <Link className="wd-link" href="/settings#verification">Verify now</Link></>}</span></div>}

    {step === 'method' && <form className="dp-step-body" onSubmit={e => { e.preventDefault(); if (method) go('amount'); }}>
      <h3 ref={headingRef} tabIndex={-1} className="dp-step-title">How do you want to be paid?</h3>
      {methods.length ? <fieldset className="dp-methods"><legend className="dp-sr">Withdrawal method</legend>
        {methods.map(m => <label key={m.id} className={`dp-method wd-method ${methodId === m.id ? 'active' : ''}`} data-testid={`card-method-${m.id}`}>
          <input type="radio" name="withdrawal-method" value={m.id} checked={methodId === m.id} onChange={() => pickMethod(m)} data-testid={`radio-method-${m.id}`} />
          <MethodBadge name={m.name} photoUrl={m.photoUrl} size={42} testId={`badge-method-${m.id}`} />
          <span className="dp-method-copy"><strong>{m.name}</strong>
            <small><Clock3 size={11} aria-hidden="true" /> {m.processingTime}</small>
            <small className="wd-method-facts">{usd(m.min)} – {usd(m.max)} · {chargesLabel(m)} · {m.source === 'both' ? 'Grant or deposit balance' : BALANCE_LABELS[m.source]}</small></span>
          <span className="dp-radio" aria-hidden="true" />
        </label>)}
      </fieldset> : <p className="dp-empty wd-empty" data-testid="empty-withdrawal-methods">No withdrawal method is available right now. Please check back later.</p>}
      <div className="dp-actions"><button type="submit" className="dp-btn primary" disabled={!method || !!blocker} data-testid="button-withdraw-continue">Continue <ArrowRight size={14} /></button></div>
    </form>}

    {step === 'amount' && method && <form className="dp-step-body" noValidate onSubmit={e => { e.preventDefault(); if (checkAmount()) go(method.fields.length ? 'details' : 'review'); }}>
      <h3 ref={headingRef} tabIndex={-1} className="dp-step-title">How much from {method.name}?</h3>
      {balances.length > 1 && <fieldset className="wd-sources"><legend className="dp-label">Withdraw from</legend>
        {balances.map(b => <label key={b} className={`wd-source ${chosen === b ? 'active' : ''}`}>
          <input type="radio" name="withdraw-source" checked={chosen === b} onChange={() => { setSource(b); setErrors({}); }} data-testid={`radio-source-${b}`} />
          <span><strong>{BALANCE_LABELS[b]}</strong><small data-testid={`text-source-available-${b}`}>{usd(availableFor(state, b))} available</small></span>
        </label>)}
      </fieldset>}
      <label className="dp-label" htmlFor={`${uid}-amount`}>Amount (USD)</label>
      <div className={`dp-amount ${errors.amount ? 'invalid' : ''}`}>
        <span aria-hidden="true">$</span>
        <input ref={amountRef} id={`${uid}-amount`} type="number" inputMode="decimal" min={method.min} max={method.max} step="0.01" placeholder="0.00" autoComplete="off"
          value={amount} onChange={e => { setAmount(e.target.value); setErrors({}); }} aria-invalid={!!errors.amount} aria-describedby={errors.amount ? `${uid}-amount-error` : `${uid}-amount-hint`} data-testid="input-withdraw-amount" />
        {chosen && <button type="button" className="dp-chip wd-max" onClick={() => { setAmount(String(Math.min(method.max, availableFor(state, chosen)))); setErrors({}); }} data-testid="button-withdraw-max">Max</button>}
      </div>
      {errors.amount ? <p className="dp-error" id={`${uid}-amount-error`} role="alert" data-testid="text-withdraw-error">{errors.amount}</p>
        : <p className="dp-hint" id={`${uid}-amount-hint`}>{usd(method.min)} – {usd(method.max)} per request{chosen ? ` · ${usd(availableFor(state, chosen))} available in your ${BALANCE_LABELS[chosen].toLowerCase()}` : ''}.</p>}
      <dl className="dp-review wd-fees" data-testid="panel-withdraw-fees">
        <div><dt>Amount</dt><dd>{usd(Number.isFinite(value) ? value : 0)}</dd></div>
        <div><dt>Charge ({chargesLabel(method)})</dt><dd data-testid="text-fee-charge">{usd(fee)}</dd></div>
        <div><dt>You receive</dt><dd className="dp-review-amount" data-testid="text-fee-receive">{usd(Number.isFinite(value) ? Math.max(0, value - fee) : 0)}</dd></div>
      </dl>
      <div className="dp-actions split"><button type="button" className="dp-btn ghost" onClick={() => go('method')} data-testid="button-withdraw-back"><ArrowLeft size={14} /> Back</button>
        <button type="submit" className="dp-btn primary" data-testid="button-withdraw-continue">Continue <ArrowRight size={14} /></button></div>
    </form>}

    {step === 'details' && method && <form className="dp-step-body" noValidate onSubmit={e => { e.preventDefault(); if (checkDetails()) go('review'); }}>
      <h3 ref={headingRef} tabIndex={-1} className="dp-step-title">{method.formTitle || 'Your details'}</h3>
      <DetailsForm method={method} answers={answers} errors={errors} prefilled={prefilled} onChange={(id, v) => { setAnswers(a => ({ ...a, [id]: v })); setErrors(({ [`details.${id}`]: _, ...rest }) => rest); }} />
      <div className="dp-actions split"><button type="button" className="dp-btn ghost" onClick={() => go('amount')} data-testid="button-withdraw-back"><ArrowLeft size={14} /> Back</button>
        <button type="submit" className="dp-btn primary" data-testid="button-withdraw-continue">Continue <ArrowRight size={14} /></button></div>
    </form>}

    {step === 'review' && method && chosen && <form className="dp-step-body" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <h3 ref={headingRef} tabIndex={-1} className="dp-step-title">Review your request</h3>
      <dl className="dp-review" data-testid="panel-withdraw-review">
        <div><dt>Method</dt><dd data-testid="text-review-method"><MethodBadge name={method.name} photoUrl={method.photoUrl} size={20} /> {method.name}</dd></div>
        <div><dt>From</dt><dd data-testid="text-review-source">{BALANCE_LABELS[chosen]}</dd></div>
        <div><dt>Amount</dt><dd data-testid="text-review-amount">{usd(value)}</dd></div>
        <div><dt>Charge</dt><dd>{usd(fee)}</dd></div>
        <div><dt>You receive</dt><dd className="dp-review-amount" data-testid="text-review-net">{usd(value - fee)}</dd></div>
        <div><dt>Processing time</dt><dd>{method.processingTime}</dd></div>
        {method.fields.filter(f => (answers[f.id] ?? '').trim()).map(f => <div key={f.id}><dt>{f.label}</dt><dd className="wd-answer" data-testid={`text-review-detail-${f.id}`}>{answers[f.id]!.trim()}</dd></div>)}
      </dl>
      {value >= state.treasury.dualControlThreshold && permissionsOf(state).payoutTwoSignOffs && <p className="dp-note"><ShieldCheck size={14} aria-hidden="true" /> Requests of {usd(state.treasury.dualControlThreshold)} or more need two members of the finance team to sign off, so they can take longer.</p>}
      <p className="dp-note"><FileText size={14} aria-hidden="true" /> The amount is held from your {BALANCE_LABELS[chosen].toLowerCase()} until finance sends it. You can cancel while it's pending.</p>
      <div className="dp-actions split"><button type="button" className="dp-btn ghost" onClick={() => go(method.fields.length ? 'details' : 'amount')} disabled={busy} data-testid="button-withdraw-back"><ArrowLeft size={14} /> Back</button>
        <button type="submit" className="dp-btn primary" disabled={busy || !!blocker} data-testid="button-submit-withdrawal">{busy ? <LoaderCircle size={14} className="dp-spin" /> : <Receipt size={14} />} Request withdrawal</button></div>
    </form>}
  </section>;
}

function HowItWorks() {
  const steps = [
    { title: 'Request', body: 'Choose a method, the amount, and fill in its details.' },
    { title: 'Finance reviews it', body: 'The amount is held from your balance meanwhile. You can cancel while it\'s pending.' },
    { title: 'Money sent', body: 'Finance sends it with the method you chose, minus its charge.' },
    { title: 'You\'re notified', body: 'If it can\'t be sent, the amount returns to the balance it came from.' },
  ];
  return <section className="dp-card dp-pad" aria-labelledby="wd-how-title" data-testid="card-withdraw-how">
    <div className="dp-card-head"><div><h2 id="wd-how-title">How withdrawals work</h2><p>No payment provider is connected; finance sends each payout.</p></div></div>
    <ol className="dp-timeline">{steps.map((s, i) => <li key={s.title}><span className="dp-timeline-dot">{i + 1}</span><div><strong>{s.title}</strong><p>{s.body}</p></div></li>)}</ol>
  </section>;
}

// ---------- History ----------

function DetailsModal({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
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
    <div className="dp-modal" role="dialog" aria-modal="true" aria-labelledby="wd-modal-title" data-testid="modal-withdrawal-details">
      <div className="dp-modal-head"><button ref={closeRef} type="button" className="dp-icon-btn" onClick={onClose} aria-label="Close" data-testid="button-withdrawal-modal-close"><X size={16} /></button></div>
      <h3 id="wd-modal-title" className="dp-step-title">{tx.id} · {tx.description.replace(/^Payout to /, '')}</h3>
      <dl className="dp-review">
        <div><dt>Status</dt><dd><Pill tone={STATUS_TONE[tx.status]}>{STATUS_LABEL[tx.status]}</Pill></dd></div>
        <div><dt>Amount</dt><dd>{usd(gross(tx))}</dd></div>
        <div><dt>Charge</dt><dd>{usd(tx.fee ?? 0)}</dd></div>
        <div><dt>You receive</dt><dd>{usd(net(tx))}</dd></div>
        <div><dt>Paid from</dt><dd>{BALANCE_LABELS[withdrawalBalance(tx)]}</dd></div>
        <div><dt>Requested</dt><dd>{fmtDateTime(tx.createdAt)}</dd></div>
        {(tx.payoutDetails ?? []).map(d => <div key={d.fieldId}><dt>{d.label}</dt><dd className="wd-answer">{d.value}</dd></div>)}
        {!tx.payoutDetails?.length && tx.destination && <div><dt>Destination</dt><dd className="wd-answer">{tx.destination}</dd></div>}
        {tx.status === 'Failed' && tx.failureReason && <div><dt>Why it failed</dt><dd className="wd-answer">{tx.failureReason}</dd></div>}
      </dl>
    </div>
  </div>;
}

function WithdrawalRow({ tx, onCancel, onDetails }: { tx: Transaction; onCancel: (id: string) => Promise<void>; onDetails: (tx: Transaction) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return <tr data-testid={`row-withdrawal-${tx.id}`} data-status={tx.status}>
    <td data-label="Request"><span className="dp-mono dp-ref">{tx.id}</span></td>
    <td data-label="Method">{tx.description.replace(/^Payout to /, '')}</td>
    <td data-label="Amount" className="dp-num">{usd(gross(tx))}</td>
    <td data-label="You receive" className="dp-num">{usd(net(tx))}</td>
    <td data-label="From">{BALANCE_LABELS[withdrawalBalance(tx)]}</td>
    <td data-label="Date">{fmtDateTime(tx.createdAt)}</td>
    <td data-label="Status"><Pill tone={STATUS_TONE[tx.status]} testId={`status-withdrawal-${tx.id}`}>{STATUS_LABEL[tx.status]}</Pill>
      {tx.status === 'Failed' && tx.failureReason && <p className="dp-reason">{tx.failureReason}</p>}</td>
    <td data-label="" className="dp-row-actions"><span className="dp-confirm">{confirming
      ? <><span>Cancel this request?</span>
        <button type="button" className="dp-btn danger small" disabled={busy} onClick={async () => { setBusy(true); await onCancel(tx.id); setBusy(false); setConfirming(false); }} data-testid={`button-confirm-cancel-withdrawal-${tx.id}`}>Yes, cancel</button>
        <button type="button" className="dp-btn ghost small" disabled={busy} onClick={() => setConfirming(false)} data-testid={`button-keep-withdrawal-${tx.id}`}>Keep</button></>
      : <><button type="button" className="dp-btn ghost small" onClick={() => onDetails(tx)} data-testid={`button-withdrawal-details-${tx.id}`}>Details</button>
        {tx.status === 'Pending' && <button type="button" className="dp-text-btn" onClick={() => setConfirming(true)} data-testid={`button-cancel-withdrawal-${tx.id}`}>Cancel</button>}</>}</span></td>
  </tr>;
}

function WithdrawalHistory({ onToast }: { onToast: Toast }) {
  const { state } = useDemoStore();
  const moneyAction = useMoneyAction();
  const [filter, setFilter] = useState<Filter>('all');
  const [details, setDetails] = useState<Transaction | null>(null);
  const rows = useMemo(() => ownTransactions(state).filter(t => t.type === 'Withdrawal').sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(f => [f.id, f.status ? rows.filter(r => r.status === f.status).length : rows.length])) as Record<Filter, number>, [rows]);
  const status = FILTERS.find(f => f.id === filter)!.status;
  const shown = status ? rows.filter(r => r.status === status) : rows;
  const cancel = async (id: string) => {
    const result = await moneyAction(s => cancelWithdrawal(s, id, new Date()), () => api.cancelWithdrawal(id));
    onToast(result.ok ? result.message : result.error);
  };
  return <section className="dp-card dp-pad" aria-labelledby="wd-history-title" data-testid="card-withdrawal-history">
    <div className="dp-card-head"><div><h2 id="wd-history-title">Your withdrawals</h2><p>Pending requests are held from their balance until finance sends them.</p></div></div>
    <div className="dp-tabs" role="group" aria-label="Show withdrawals">{FILTERS.map(f => <button key={f.id} type="button" aria-pressed={filter === f.id} className={filter === f.id ? 'active' : ''}
      onClick={() => setFilter(f.id)} data-testid={`tab-withdrawals-${f.id}`}>{f.label}<span className="dp-count" aria-label={`${counts[f.id]} requests`}>{counts[f.id]}</span></button>)}</div>
    <div className="dp-table-wrap">
      <table className="dp-table" data-testid="table-withdrawals">
        <thead><tr><th scope="col">Request</th><th scope="col">Method</th><th scope="col" className="dp-num">Amount</th><th scope="col" className="dp-num">You receive</th><th scope="col">From</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col"><span className="dp-sr">Actions</span></th></tr></thead>
        <tbody>{shown.length ? shown.map(tx => <WithdrawalRow key={tx.id} tx={tx} onCancel={cancel} onDetails={setDetails} />)
          : <tr><td colSpan={8} className="dp-empty" data-testid="empty-withdrawals">{filter === 'all' ? 'No withdrawals yet.' : `No ${FILTERS.find(f => f.id === filter)!.label.toLowerCase()} withdrawals.`}</td></tr>}</tbody>
      </table>
    </div>
    {details && <DetailsModal tx={details} onClose={() => setDetails(null)} />}
  </section>;
}

// ---------- The page ----------

export function WithdrawalsPage({ onToast }: { onToast: Toast }) {
  const { connected } = useServerData();
  return <div className="dp-page wd-page" data-testid="page-withdrawals">
    <div className="dp-intro"><p>Withdraw from your grant balance, or your deposit balance where a method allows it. {connected ? 'Requests are saved to your account and processed by the finance team.' : 'In this preview, requests are saved in this browser only.'}</p></div>
    <BalanceHero />
    <div className="dp-grid">
      <NewWithdrawal onToast={onToast} />
      <div className="dp-side"><HowItWorks /></div>
    </div>
    <WithdrawalHistory onToast={onToast} />
  </div>;
}
