import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { format } from 'date-fns';
import {
  ArrowLeft, ArrowRight, Banknote, Check, CircleAlert, Clock3, Copy, CreditCard, FileText, Info, LoaderCircle, Paperclip, Plus, Receipt, ShieldCheck, Wallet, X,
} from 'lucide-react';
import * as api from '@workspace/api-client-react';
import { enabledDepositMethods, findDepositMethod } from '@workspace/domain/depositMethods';
import {
  cancelDeposit, depositBlocker, depositCredit, depositFee, depositMethodName, MAX_PENDING_DEPOSITS, requestDeposit, validateDeposit,
} from '@workspace/domain/deposits';
import type { DepositMethod, Transaction, TransactionStatus } from '@workspace/domain/model';
import { computeBalances, ownTransactions } from '@workspace/domain/rules';
import { answerLimit, chargesLabel, checkAnswers } from '@workspace/domain/withdrawalMethods';
import { ProofFiles, ProofUploadButton } from '@/components/DepositProof';
import { MethodBadge } from '@/components/MethodBadge';
import { useMoneyAction, useServerData } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import './DepositsPage.css';
import './WithdrawalsPage.css';

// The applicant's Add funds page (/deposits): the deposit balance and its
// reserve, a flow to announce a transfer (method → amount → the method's form →
// review) that ends with the payment reference, where to send the money, and
// proof-of-payment uploads; what the deposit balance pays for; and the deposit
// history. Methods, with their receiving details, limits, charges, and forms,
// are set by finance (Settings → Deposit methods); only available ones are
// shown. Nothing moves money here: the balance is credited (less the method's
// charge) when finance confirms the transfer arrived. Signed in, requests go
// through the API; in the browser-only preview, the same rules run on the
// sample data.

type Toast = (message: string) => void;
type Step = 'method' | 'amount' | 'details' | 'review';
type Filter = 'all' | 'pending' | 'completed' | 'failed' | 'cancelled';

const STEPS: { id: Step; label: string }[] = [{ id: 'method', label: 'Method' }, { id: 'amount', label: 'Amount' }, { id: 'details', label: 'Details' }, { id: 'review', label: 'Review' }];
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
      <p className="dp-hero-sub" data-testid="text-deposit-balance-note">{deposit < 0 ? `Below zero because of a grant commission. Add ${usd(-deposit)} to clear it.` : 'Confirmed funds you\'ve added. Used for card fees, grant commissions, and the payout reserve.'}</p>
    </div>
    <div className="dp-hero-stats">
      <div className="dp-stat"><span>Awaiting confirmation</span><strong data-testid="text-pending-deposits">{usd(pending)}</strong><small data-testid="text-open-deposits">{open} of {MAX_PENDING_DEPOSITS} open deposits</small></div>
      <div className="dp-stat"><span>Grant balance</span><strong data-testid="text-grant-balance">{usd(grant)}</strong><small>Awarded funds, kept separately</small></div>
    </div>
    <div className="dp-reserve" data-testid="status-reserve" data-covered={covered}>
      <div className="dp-reserve-head"><span><ShieldCheck size={14} aria-hidden="true" /> Required reserve · {usd(reserve)}</span>
        <strong>{covered ? 'Covered' : `Add ${usd(reserve - Math.max(deposit, 0))} to cover it`}</strong></div>
      <div className="dp-meter" role="meter" aria-label="Reserve covered" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fill}><span style={{ width: `${fill}%` }} /></div>
      <small>The reserve stays in your deposit balance so you can request payouts from it and a physical card. Grant payouts don't need it.</small>
    </div>
  </section>;
}

// ---------- New deposit ----------

function Stepper({ step, steps }: { step: Step; steps: { id: Step; label: string }[] }) {
  const at = steps.findIndex(s => s.id === step);
  return <ol className="dp-steps" aria-label="New deposit steps">
    {steps.map((s, i) => <li key={s.id} className={i < at ? 'done' : i === at ? 'current' : ''} aria-current={i === at ? 'step' : undefined} data-testid={`step-${s.id}`}>
      <span className="dp-step-dot">{i < at ? <Check size={12} /> : i + 1}</span><span className="dp-step-label">{s.label}</span>
    </li>)}
  </ol>;
}

/** Proof of payment for a pending deposit: what's uploaded, and a button to add more. */
function ProofSection({ tx, onToast }: { tx: Transaction; onToast: Toast }) {
  const { state } = useDemoStore();
  const rule = tx.proofRequired ? 'required' : findDepositMethod(state, tx.method)?.proof ?? 'optional';
  const files = tx.proof?.length ?? 0;
  if (rule === 'off' && !files) return null;
  const pending = tx.status === 'Pending';
  return <section className="dp-proof" aria-labelledby={`proof-${tx.id}`} data-testid="panel-deposit-proof">
    <div className="dp-proof-head">
      <h4 id={`proof-${tx.id}`}>Proof of payment {rule === 'required' ? <Pill tone={files ? 'ok' : 'warn'} testId="status-proof-required">{files ? 'Added' : 'Required'}</Pill> : <span className="dp-optional">(optional)</span>}</h4>
      <p>{rule === 'required' && !files && pending
        ? 'After you send the money, upload the receipt or a screenshot. Finance can\'t confirm this deposit without it.'
        : pending ? 'A receipt or screenshot helps finance find your transfer faster. PDF, JPG, or PNG.' : 'The files you added for this deposit.'}</p>
    </div>
    <ProofFiles tx={tx} editable={pending} onToast={onToast} buttonClass="dp-btn ghost small" />
    {pending && rule !== 'off' && <ProofUploadButton tx={tx} onToast={onToast} className="dp-btn ghost small" />}
  </section>;
}

function Instructions({ tx, onToast, onDone }: { tx: Transaction; onToast: Toast; onDone?: () => void }) {
  const { state } = useDemoStore();
  const method = findDepositMethod(state, tx.method);
  const reference = tx.reference ?? tx.id;
  const payTo = tx.payTo ?? method?.receivingDetails ?? [];
  const fee = tx.fee ?? 0;
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
    {payTo.length > 0 && <div className="dp-payto" data-testid="panel-deposit-payto">
      <h4><MethodBadge name={depositMethodName(tx)} photoUrl={method?.photoUrl ?? ''} size={22} /> Send to · {depositMethodName(tx)}</h4>
      <dl>{payTo.map((d, i) => <div key={d.label} className="dp-payto-line"><dt>{d.label}</dt>
        <dd><span className="dp-mono" data-testid={`text-deposit-payto-${i}`}>{d.value}</span><CopyButton text={d.value} what={d.label} onToast={onToast} testId={`button-copy-payto-${i}`} /></dd></div>)}</dl>
    </div>}
    {method?.instructions && <p className="dp-note" data-testid="text-deposit-method-instructions"><Info size={14} aria-hidden="true" /> {method.instructions}</p>}
    <dl className="dp-details">
      <div><dt>Amount to send</dt><dd data-testid="text-instructions-amount">{usd(tx.amount)}</dd></div>
      <div><dt>Credited to you</dt><dd data-testid="text-instructions-credit">{usd(depositCredit(tx))}{fee > 0 && <small className="dp-muted-note">after {usd(fee)} charge</small>}</dd></div>
      <div><dt>Usually arrives</dt><dd>{method?.processingTime ?? '—'}</dd></div>
      <div><dt>Status</dt><dd><Pill tone={STATUS_TONE[tx.status]}>{STATUS_LABEL[tx.status]}</Pill></dd></div>
      {(tx.depositDetails ?? []).map(d => <div key={d.fieldId} className="dp-details-wide"><dt>{d.label}</dt><dd className="wd-answer-left">{d.value}</dd></div>)}
    </dl>
    {tx.dualControl && tx.status === 'Pending' && <p className="dp-note"><ShieldCheck size={14} aria-hidden="true" /> Deposits of {usd(state.treasury.depositDualControlThreshold)} or more are checked by two members of the finance team, so they can take a little longer.</p>}
    <p className="dp-note"><CircleAlert size={14} aria-hidden="true" /> Include the reference exactly as shown, or finance can't match your transfer to your account.</p>
    <ProofSection tx={tx} onToast={onToast} />
    {onDone && <div className="dp-actions"><button type="button" className="dp-btn primary" onClick={onDone} data-testid="button-new-deposit"><Plus size={14} /> Make another deposit</button></div>}
  </div>;
}

/** The method's form, rendered from its definition. */
function DetailsForm({ method, answers, errors, onChange }: { method: DepositMethod; answers: Record<string, string>; errors: Record<string, string>; onChange: (id: string, value: string) => void }) {
  const uid = useId();
  return <div className="wd-form" data-testid="form-deposit-details">
    {method.fields.map(f => {
      const id = `${uid}-${f.id}`;
      const error = errors[`details.${f.id}`];
      const common = { id, value: answers[f.id] ?? '', 'aria-invalid': !!error, 'aria-describedby': error ? `${id}-error` : f.help ? `${id}-help` : undefined, 'data-testid': `input-deposit-detail-${f.id}`, maxLength: answerLimit(f.type) };
      return <div className="wd-field" key={f.id}>
        <label className="dp-label" htmlFor={id}>{f.label}{f.required ? <span aria-hidden="true"> *</span> : <span className="wd-optional"> (optional)</span>}</label>
        {f.type === 'textarea' ? <textarea className="wd-input" rows={3} placeholder={f.placeholder} required={f.required} onChange={e => onChange(f.id, e.target.value)} {...common} />
          : f.type === 'select' ? <select className="wd-input" required={f.required} onChange={e => onChange(f.id, e.target.value)} {...common}><option value="">Choose…</option>{f.options.map(o => <option key={o} value={o}>{o}</option>)}</select>
            : <input className="wd-input" type={f.type === 'email' ? 'email' : 'text'} inputMode={f.type === 'number' ? 'decimal' : f.type === 'email' ? 'email' : undefined} autoComplete="off" placeholder={f.placeholder} required={f.required} onChange={e => onChange(f.id, e.target.value)} {...common} />}
        {error ? <p className="dp-error" id={`${id}-error`} role="alert" data-testid={`text-deposit-detail-error-${f.id}`}>{error}</p> : f.help ? <p className="dp-hint" id={`${id}-help`}>{f.help}</p> : null}
      </div>;
    })}
  </div>;
}

function NewDeposit({ onToast }: { onToast: Toast }) {
  const { state } = useDemoStore();
  const moneyAction = useMoneyAction();
  const methods = enabledDepositMethods(state);
  const blocked = depositBlocker(state);
  const [step, setStep] = useState<Step>('method');
  const [methodId, setMethodId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorId = useId();

  const method = methodId ? methods.find(m => m.id === methodId) : undefined;
  const steps = STEPS.filter(s => s.id !== 'details' || !method || method.fields.length > 0);
  const value = amount.trim() === '' ? NaN : Number(amount);
  const fee = method ? depositFee(method, value) : 0;
  const created = createdId ? ownTransactions(state).find(t => t.id === createdId) : undefined;
  const quick = method ? QUICK_AMOUNTS.filter(a => a >= method.min && a <= method.max) : [];

  // A method finance hid or deleted while the applicant was choosing: start again.
  useEffect(() => { if (methodId && !method && !createdId) { setMethodId(null); setStep('method'); } }, [methodId, method, createdId]);

  // Move focus to the new step's heading so keyboard and screen-reader users follow along.
  const go = (next: Step) => { setStep(next); requestAnimationFrame(() => headingRef.current?.focus()); };
  const checkAmount = () => {
    if (!method) return false;
    const problem = validateDeposit(state, value, method.id);
    if (problem) { setErrors({ amount: problem }); amountRef.current?.focus(); return false; }
    setErrors({}); return true;
  };
  const checkDetails = () => {
    if (!method) return false;
    const checked = checkAnswers(method, answers);
    if ('errors' in checked) { setErrors(checked.errors); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="input-deposit-detail-${Object.keys(checked.errors)[0]!.slice(8)}"]`)?.focus()); return false; }
    setErrors({}); return true;
  };
  const submit = async () => {
    if (!method) return;
    if (!checkAmount()) { go('amount'); return; }
    if (!checkDetails()) { go('details'); return; }
    setBusy(true);
    const result = await moneyAction(s => requestDeposit(s, value, method.id, new Date(), answers), () => api.requestDeposit({ amount: value, method: method.id, details: answers }));
    setBusy(false);
    if (!result.ok) {
      const fieldErrors = result.fieldErrors ?? {};
      setErrors(Object.keys(fieldErrors).length ? fieldErrors : { amount: result.error });
      go(Object.keys(fieldErrors).some(k => k.startsWith('details.')) ? 'details' : 'amount');
      return;
    }
    setCreatedId(result.id ?? null);
    onToast(result.message);
  };
  const reset = () => { setCreatedId(null); setMethodId(null); setAmount(''); setAnswers({}); setErrors({}); };
  const restart = () => { reset(); go('method'); };
  // Cancelled (or confirmed) from the history while its instructions were showing: start a fresh deposit
  // rather than falling back to the old review step, where it could be sent again by mistake.
  const settled = !!created && created.status !== 'Pending';
  useEffect(() => { if (settled) { reset(); setStep('method'); } }, [settled]);

  if (created && created.status === 'Pending') {
    return <section className="dp-card dp-pad" aria-label="New deposit" data-testid="card-new-deposit"><Instructions tx={created} onToast={onToast} onDone={restart} /></section>;
  }

  return <section className="dp-card dp-pad" aria-labelledby="dp-new-title" data-testid="card-new-deposit">
    <div className="dp-card-head"><div><h2 id="dp-new-title">New deposit</h2><p>{method ? `${method.name} · ${usd(method.min)} – ${usd(method.max)} per deposit · ${chargesLabel(method).toLowerCase()}` : 'Choose how you\'ll send the money.'}</p></div><Stepper step={step} steps={steps} /></div>
    {blocked && <div className="dp-alert" role="alert" data-testid="notice-deposit-blocked"><CircleAlert size={15} aria-hidden="true" /><span>{blocked}</span></div>}

    {step === 'method' && <form className="dp-step-body" onSubmit={e => { e.preventDefault(); if (method) go('amount'); }}>
      <h3 ref={headingRef} tabIndex={-1} className="dp-step-title">How will you send the money?</h3>
      {methods.length ? <fieldset className="dp-methods"><legend className="dp-sr">Deposit method</legend>
        {methods.map(m => <label key={m.id} className={`dp-method wd-method ${methodId === m.id ? 'active' : ''}`} data-testid={`card-deposit-method-${m.id}`}>
          <input type="radio" name="deposit-method" value={m.id} checked={methodId === m.id} onChange={() => { setMethodId(m.id); setAnswers({}); setErrors({}); }} data-testid={`radio-deposit-${m.id}`} />
          <MethodBadge name={m.name} photoUrl={m.photoUrl} size={42} testId={`badge-deposit-method-${m.id}`} />
          <span className="dp-method-copy"><strong>{m.name}</strong>
            <small><Clock3 size={11} aria-hidden="true" /> {m.processingTime}</small>
            <small className="wd-method-facts">{usd(m.min)} – {usd(m.max)} · {chargesLabel(m)}{m.proof === 'required' ? ' · receipt required' : ''}</small></span>
          <span className="dp-radio" aria-hidden="true" />
        </label>)}
      </fieldset> : <p className="dp-empty wd-empty" data-testid="empty-deposit-methods">No deposit method is available right now. Please check back later.</p>}
      <div className="dp-actions"><button type="submit" className="dp-btn primary" disabled={!method || !!blocked} data-testid="button-deposit-continue">Continue <ArrowRight size={14} /></button></div>
    </form>}

    {step === 'amount' && method && <form className="dp-step-body" noValidate onSubmit={e => { e.preventDefault(); if (checkAmount()) go(method.fields.length ? 'details' : 'review'); }}>
      <h3 ref={headingRef} tabIndex={-1} className="dp-step-title">How much are you adding by {method.name}?</h3>
      <label className="dp-label" htmlFor="deposit-amount">Amount (USD)</label>
      <div className={`dp-amount ${errors.amount ? 'invalid' : ''}`}>
        <span aria-hidden="true">$</span>
        <input ref={amountRef} id="deposit-amount" type="number" inputMode="decimal" min={method.min} max={method.max} step="0.01" placeholder="0.00" autoComplete="off"
          value={amount} onChange={e => { setAmount(e.target.value); setErrors({}); }} aria-invalid={!!errors.amount} aria-describedby={errors.amount ? errorId : `${errorId}-hint`} data-testid="input-deposit-amount" />
        <small>USD</small>
      </div>
      {errors.amount ? <p className="dp-error" id={errorId} role="alert" data-testid="text-deposit-error">{errors.amount}</p> : <p className="dp-hint" id={`${errorId}-hint`}>Minimum {usd(method.min)}, maximum {usd(method.max)}.</p>}
      <div className="dp-chips" role="group" aria-label="Quick amounts">{quick.map(a => <button key={a} type="button" className={`dp-chip ${value === a ? 'active' : ''}`} aria-pressed={value === a}
        onClick={() => { setAmount(String(a)); setErrors({}); }} data-testid={`button-quick-amount-${a}`}>{shortUsd(a)}</button>)}</div>
      <dl className="dp-review wd-fees" data-testid="panel-deposit-fees">
        <div><dt>You send</dt><dd>{usd(Number.isFinite(value) ? value : 0)}</dd></div>
        <div><dt>Charge ({chargesLabel(method)})</dt><dd data-testid="text-deposit-fee">{usd(fee)}</dd></div>
        <div><dt>Credited to your deposit balance</dt><dd className="dp-review-amount" data-testid="text-deposit-credit">{usd(Number.isFinite(value) ? Math.max(0, value - fee) : 0)}</dd></div>
      </dl>
      <div className="dp-actions split"><button type="button" className="dp-btn ghost" onClick={() => go('method')} data-testid="button-deposit-back"><ArrowLeft size={14} /> Back</button>
        <button type="submit" className="dp-btn primary" disabled={!!blocked} data-testid="button-deposit-continue">Continue <ArrowRight size={14} /></button></div>
    </form>}

    {step === 'details' && method && <form className="dp-step-body" noValidate onSubmit={e => { e.preventDefault(); if (checkDetails()) go('review'); }}>
      <h3 ref={headingRef} tabIndex={-1} className="dp-step-title">{method.formTitle || 'Your details'}</h3>
      <DetailsForm method={method} answers={answers} errors={errors} onChange={(id, v) => { setAnswers(a => ({ ...a, [id]: v })); setErrors(({ [`details.${id}`]: _, ...rest }) => rest); }} />
      <div className="dp-actions split"><button type="button" className="dp-btn ghost" onClick={() => go('amount')} data-testid="button-deposit-back"><ArrowLeft size={14} /> Back</button>
        <button type="submit" className="dp-btn primary" data-testid="button-deposit-continue">Continue <ArrowRight size={14} /></button></div>
    </form>}

    {step === 'review' && method && <form className="dp-step-body" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <h3 ref={headingRef} tabIndex={-1} className="dp-step-title">Review your deposit</h3>
      <dl className="dp-review" data-testid="panel-deposit-review">
        <div><dt>Method</dt><dd data-testid="text-review-method"><MethodBadge name={method.name} photoUrl={method.photoUrl} size={20} /> {method.name}</dd></div>
        <div><dt>You send</dt><dd className="dp-review-amount" data-testid="text-review-amount">{usd(value)}</dd></div>
        <div><dt>Charge</dt><dd data-testid="text-review-fee">{fee > 0 ? usd(fee) : 'None'}</dd></div>
        <div><dt>Credited to</dt><dd data-testid="text-review-credit">{usd(value - fee)} to your deposit balance, once finance confirms</dd></div>
        <div><dt>Usually arrives</dt><dd>{method.processingTime}</dd></div>
        {method.fields.filter(f => (answers[f.id] ?? '').trim()).map(f => <div key={f.id}><dt>{f.label}</dt><dd className="wd-answer" data-testid={`text-review-detail-${f.id}`}>{answers[f.id]!.trim()}</dd></div>)}
      </dl>
      {state.treasury.depositDualControlThreshold > 0 && value >= state.treasury.depositDualControlThreshold && <p className="dp-note"><ShieldCheck size={14} aria-hidden="true" /> Deposits of {usd(state.treasury.depositDualControlThreshold)} or more are checked by two members of the finance team, so they can take a little longer.</p>}
      <p className="dp-note"><FileText size={14} aria-hidden="true" /> Next you'll get a payment reference and where to send the money.{method.proof === 'required' ? ' After sending, upload the receipt or a screenshot so finance can confirm it.' : ''}</p>
      <div className="dp-actions split"><button type="button" className="dp-btn ghost" onClick={() => go(method.fields.length ? 'details' : 'amount')} disabled={busy} data-testid="button-deposit-back"><ArrowLeft size={14} /> Back</button>
        <button type="submit" className="dp-btn primary" disabled={busy || !!blocked} data-testid="button-submit-deposit">{busy ? <LoaderCircle size={14} className="dp-spin" /> : <Receipt size={14} />} Confirm and get reference</button></div>
    </form>}
  </section>;
}

// ---------- Side cards ----------

function HowItWorks() {
  const steps = [
    { title: 'Announce the deposit', body: 'Choose a method and amount here to get a payment reference and where to send it.' },
    { title: 'Send the transfer', body: 'Pay from your own account, quoting the reference, then upload the receipt if asked.' },
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
    { icon: <ShieldCheck size={15} />, label: 'Payout reserve', note: 'Kept in your balance for payouts from it, not charged', amount: usd(t.depositThreshold), testId: 'fee-reserve' },
    { icon: <FileText size={15} />, label: 'Grant commission', note: 'A percentage set on each grant, taken when an application is approved. Your balance can go below zero; a deposit clears it.', amount: 'Per grant', testId: 'fee-commission' },
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
  const needsProof = tx.status === 'Pending' && !!tx.proofRequired && !tx.proof?.length;
  return <tr data-testid={`row-deposit-${tx.id}`} data-status={tx.status}>
    <td data-label="Reference"><span className="dp-mono dp-ref">{tx.reference ?? tx.id}</span></td>
    <td data-label="Method"><span className="dp-method-cell">{depositMethodName(tx)}</span></td>
    <td data-label="Amount" className="dp-num">{usd(tx.amount)}</td>
    <td data-label="Credited" className="dp-num">{tx.status === 'Failed' || tx.status === 'Cancelled' ? '—' : usd(depositCredit(tx))}</td>
    <td data-label="Date">{fmtDateTime(tx.createdAt)}</td>
    <td data-label="Status"><Pill tone={STATUS_TONE[tx.status]} testId={`status-deposit-${tx.id}`}>{STATUS_LABEL[tx.status]}</Pill>
      {needsProof && <p className="dp-reason dp-reason-warn" data-testid={`text-deposit-proof-needed-${tx.id}`}>Upload your receipt</p>}
      {!!tx.proof?.length && <p className="dp-reason"><Paperclip size={11} aria-hidden="true" /> {tx.proof.length} file{tx.proof.length === 1 ? '' : 's'}</p>}
      {tx.status === 'Failed' && tx.failureReason && <p className="dp-reason" data-testid={`text-deposit-reason-${tx.id}`}>{tx.failureReason}</p>}
      {tx.status === 'Completed' && tx.processedAt && <p className="dp-reason">Credited {format(new Date(tx.processedAt), 'MMM d, yyyy')}</p>}</td>
    <td data-label="" className="dp-row-actions">{tx.status === 'Pending' && (confirming
      ? <span className="dp-confirm"><span>Cancel this deposit?</span>
        <button type="button" className="dp-btn danger small" disabled={busy} onClick={async () => { setBusy(true); await onCancel(tx.id); setBusy(false); setConfirming(false); }} data-testid={`button-confirm-cancel-${tx.id}`}>{busy ? <LoaderCircle size={12} className="dp-spin" /> : null}Yes, cancel</button>
        <button type="button" className="dp-btn ghost small" disabled={busy} onClick={() => setConfirming(false)} data-testid={`button-keep-deposit-${tx.id}`}>Keep</button></span>
      : <span className="dp-confirm"><button type="button" className={`dp-btn small ${needsProof ? 'primary' : 'ghost'}`} onClick={() => onDetails(tx)} data-testid={`button-deposit-details-${tx.id}`}>{needsProof ? 'Add receipt' : 'Payment details'}</button>
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
        <thead><tr><th scope="col">Reference</th><th scope="col">Method</th><th scope="col" className="dp-num">Amount</th><th scope="col" className="dp-num">Credited</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col"><span className="dp-sr">Actions</span></th></tr></thead>
        <tbody>{shown.length
          ? shown.map(tx => <DepositRow key={tx.id} tx={tx} onCancel={cancel} onDetails={setDetails} />)
          : <tr><td colSpan={7} className="dp-empty" data-testid="empty-deposits">{filter === 'all' ? "No deposits yet. Deposits you announce appear here." : `No ${FILTERS.find(f => f.id === filter)!.label.toLowerCase()} deposits.`}</td></tr>}</tbody>
      </table>
    </div>
    {details && <DetailsModal tx={deposits.find(d => d.id === details.id) ?? details} onClose={() => setDetails(null)} onToast={onToast} />}
  </section>;
}

// ---------- The page ----------

export function DepositsPage({ onToast }: { onToast: Toast }) {
  const { state } = useDemoStore();
  const { connected } = useServerData();
  const own = ownTransactions(state);
  const balances = computeBalances(own);
  const open = own.filter(t => t.type === 'Deposit' && t.status === 'Pending').length;
  const names = enabledDepositMethods(state).map(m => m.name);
  const by = names.length > 1 ? ` by ${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names.length ? ` by ${names[0]}` : '';
  return <div className="dp-page" data-testid="page-deposits">
    <div className="dp-intro"><p>Top up your deposit balance{by}. {connected ? 'Requests are saved to your account and checked by the finance team.' : 'In this preview, deposits are saved in this browser only.'}</p></div>
    <BalanceHero deposit={balances.deposit} pending={balances.pendingDeposits} grant={balances.grant} reserve={state.treasury.depositThreshold} open={open} />
    <div className="dp-grid">
      <NewDeposit onToast={onToast} />
      <div className="dp-side"><HowItWorks /><FeesCard /></div>
    </div>
    <DepositHistory onToast={onToast} />
  </div>;
}
