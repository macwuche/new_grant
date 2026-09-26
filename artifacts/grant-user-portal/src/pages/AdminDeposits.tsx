import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Info, Search } from 'lucide-react';
import { format } from 'date-fns';
import { applicantName } from '@workspace/domain/review';
import { confirmDeposit, DEPOSIT_METHODS, depositQueue, MIN_REJECTION_REASON_LENGTH, pendingDepositTotal, rejectDeposit } from '@workspace/domain/deposits';
import { actingStaff } from '@workspace/domain/staff';
import * as api from '@workspace/api-client-react';
import { useStaffMoney, type Outcome } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import { RoleNotice, useCan, useStaffCommand } from './AdminStaff';
import type { Result, Transaction } from '@workspace/domain/model';
import { ReviewFrame } from './AdminReviewPanel';

const usd = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string) => format(new Date(iso), 'dd MMM yyyy, HH:mm');
const day = (iso: string) => format(new Date(iso), 'dd MMM yyyy');
const label = (tx: Transaction) => tx.status === 'Completed' ? 'Received' : tx.status === 'Failed' ? 'Rejected' : tx.status;
const badgeClass = (tx: Transaction) => `admin-badge ${tx.status === 'Completed' ? 'approved' : tx.status === 'Failed' ? 'declined' : tx.status === 'Cancelled' ? 'draft' : 'submitted'}`;
const methodName = (tx: Transaction) => DEPOSIT_METHODS.find(m => m.id === tx.method)?.name ?? 'Unknown method';

export function AdminDeposits() {
  const { state } = useDemoStore();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All statuses');
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const queue = depositQueue(state);
  const pending = queue.filter(t => t.status === 'Pending');
  const high = pending.filter(t => t.amount >= state.treasury.highValueDeposit);
  const rows = queue.filter(tx => (filter === 'All statuses' || label(tx) === filter) && `${tx.reference ?? ''} ${tx.id} ${applicantName(state, tx.applicantId)}`.toLowerCase().includes(query.toLowerCase()));
  const received = queue.filter(t => t.status === 'Completed').reduce((sum, t) => sum + t.amount, 0);

  return <>
    <div className="admin-overview-metrics">
      <div className="admin-metric featured" data-testid="metric-admin-deposits-pending"><span className="admin-metric-label">Waiting to be confirmed</span><strong className="admin-metric-value">{String(pending.length).padStart(2, '0')}</strong><span className="admin-metric-foot">Oldest first · match by reference</span></div>
      <div className="admin-metric" data-testid="metric-admin-deposits-amount"><span className="admin-metric-label">Announced, not yet received</span><strong className="admin-metric-value">{usd(pendingDepositTotal(state))}</strong><span className="admin-metric-foot">Not counted in balances</span></div>
      <div className="admin-metric" data-testid="metric-admin-deposits-high"><span className="admin-metric-label">High-value pending</span><strong className="admin-metric-value">{String(high.length).padStart(2, '0')}</strong><span className="admin-metric-foot">{usd(state.treasury.highValueDeposit)} or more</span></div>
      <div className="admin-metric" data-testid="metric-admin-deposits-received"><span className="admin-metric-label">Confirmed received</span><strong className="admin-metric-value">{usd(received)}</strong><span className="admin-metric-foot">Demo records</span></div>
    </div>
    <section className="admin-panel">
      <div className="admin-panel-head"><div><h2>Deposits</h2><p>Transfers applicants say they've sent. Check the receiving account for the reference, then confirm or reject. No bank feed is connected.</p></div></div>
      <div className="admin-toolbar"><div className="admin-toolbar-left"><label className="admin-search"><Search size={15} /><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search reference or applicant" aria-label="Search deposits" data-testid="input-admin-search-deposits" /></label><select className="admin-filter" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter deposits by status" data-testid="select-admin-filter-deposits"><option>All statuses</option><option>Pending</option><option>Received</option><option>Rejected</option><option>Cancelled</option></select></div><span className="admin-count" data-testid="text-admin-deposits-count">{rows.length} of {queue.length} deposits</span></div>
      {rows.length ? <>
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Reference</th><th>Method</th><th>Amount</th><th>Status</th><th>Announced</th><th><span className="admin-eyebrow" style={{ margin: 0 }}>Process</span></th></tr></thead><tbody>{rows.map(tx => <tr key={tx.id} data-testid={`row-admin-deposit-${tx.id}`}><td><span className="admin-table-primary">{tx.reference ?? tx.id}{tx.status === 'Pending' && tx.amount >= state.treasury.highValueDeposit && <span className="admin-flag">High value</span>}</span><span className="admin-table-secondary">{applicantName(state, tx.applicantId)}</span></td><td className="admin-table-muted">{methodName(tx)}</td><td className="admin-table-number">{usd(tx.amount)}</td><td><span className={badgeClass(tx)}>{label(tx)}</span></td><td className="admin-table-muted">{day(tx.createdAt)}</td><td><button type="button" className="admin-icon-button" onClick={() => setOpenId(tx.id)} aria-label={`Open deposit ${tx.reference}`} data-testid={`button-open-admin-deposit-${tx.id}`}><ArrowRight size={15} /></button></td></tr>)}</tbody></table></div>
        <div className="admin-mobile-records" role="list" aria-label="Deposits">{rows.map(tx => <article className="admin-mobile-record" role="listitem" key={tx.id} data-testid={`card-admin-deposit-${tx.id}`}>
          <div className="admin-mobile-record-top"><div className="admin-mobile-record-identity"><strong>{tx.reference ?? tx.id}</strong><span>{applicantName(state, tx.applicantId)}</span></div><span className={badgeClass(tx)}>{label(tx)}</span></div>
          <dl className="admin-mobile-record-facts"><div><dt>Amount</dt><dd>{usd(tx.amount)}</dd></div><div><dt>Method</dt><dd>{methodName(tx)}</dd></div><div><dt>Announced</dt><dd>{day(tx.createdAt)}</dd></div></dl>
          <button type="button" className="admin-mobile-record-action" onClick={() => setOpenId(tx.id)} data-testid={`button-open-admin-deposit-mobile-${tx.id}`}>{tx.status === 'Pending' ? 'Confirm or reject' : 'View deposit'} <ArrowRight size={15} /></button>
        </article>)}</div>
      </> : <div className="admin-empty" data-testid="empty-admin-deposits"><Search size={25} /><h3>No deposits in this view</h3><p>Deposits applicants announce appear here.</p></div>}
    </section>
    {openId && <DepositPanel txId={openId} onClose={close} />}
  </>;
}

function DepositPanel({ txId, onClose }: { txId: string; onClose: () => void }) {
  const { state } = useDemoStore();
  const command = useStaffCommand();
  const staffMoney = useStaffMoney();
  const can = useCan();
  const tx = state.transactions.find(t => t.id === txId);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<'confirm' | 'reject'>('confirm');
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!tx || tx.type !== 'Deposit') return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow={txId}><h2 id="admin-detail-title">Deposit not found</h2></ReviewFrame>;
  const after = (result: Outcome) => {
    setConfirming(false);
    if (!result.ok) { setError(result.fieldErrors?.reason ?? null); setFlash({ tone: 'error', text: result.error }); return; }
    setError(null); setReason(''); setFlash({ tone: 'ok', text: result.message });
  };
  const submit = () => {
    if (mode === 'reject' && reason.trim().length < MIN_REJECTION_REASON_LENGTH) { setError(`Write at least ${MIN_REJECTION_REASON_LENGTH} characters; the applicant sees this reason.`); return; }
    if (!confirming) { setConfirming(true); return; }
    if (staffMoney.connected) { void staffMoney.entry(() => mode === 'confirm' ? api.confirmDeposit(tx.id) : api.rejectDeposit(tx.id, { reason })).then(after); return; }
    after(command('payments.process', { action: mode === 'confirm' ? 'Confirm deposit' : 'Reject deposit', target: tx.id }, (s, actor) => mode === 'confirm' ? confirmDeposit(s, tx.id, actor.name, new Date()) : rejectDeposit(s, tx.id, reason, actor.name, new Date())));
  };
  const pick = (next: 'confirm' | 'reject') => { setMode(next); setConfirming(false); setError(null); setFlash(null); };
  const high = tx.amount >= state.treasury.highValueDeposit;

  return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow={`${tx.reference ?? tx.id} / Deposit`}>
    <div className="admin-review-title"><h2 id="admin-detail-title" data-testid="text-admin-detail-title">{usd(tx.amount)}</h2><span className={badgeClass(tx)} data-testid="status-admin-deposit">{label(tx)}</span></div>
    <p className="admin-detail-lead">{applicantName(state, tx.applicantId)} · announced {when(tx.createdAt)}</p>
    {high && tx.status === 'Pending' && <div className="admin-review-stale" role="note"><span>High-value deposit ({usd(state.treasury.highValueDeposit)} or more). Confirm the sender's identity matches the applicant before crediting.</span></div>}
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-deposit-flash">{flash.text}</div>}
    <dl className="admin-detail-fields">
      {[['Reference', tx.reference ?? '—'], ['Method', methodName(tx)], ['Amount announced', usd(tx.amount)], ...(tx.processedAt ? [[tx.status === 'Cancelled' ? 'Cancelled' : 'Processed', `${when(tx.processedAt)}${tx.processedBy && tx.status !== 'Cancelled' ? ` by ${tx.processedBy}` : ' by the applicant'}`]] : [])].map(([k, v]) => <div className="admin-detail-field" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
    <section className="admin-review-section admin-review-actions" aria-label="Process deposit">
      <h3>Process</h3>
      {tx.status === 'Pending' ? <>
        <p className="admin-review-hint">Look for {usd(tx.amount)} with reference <strong>{tx.reference}</strong> in the receiving account. {actingStaff(state) ? <> Acting as <strong>{actingStaff(state)!.name}</strong>.</> : null}</p><RoleNotice permission="payments.process" />
        <div className="admin-segment" role="tablist" aria-label="Deposit result">{([['confirm', 'Confirm received'], ['reject', 'Reject']] as const).map(([key, text]) => <button type="button" role="tab" key={key} aria-selected={mode === key} className={mode === key ? 'active' : ''} onClick={() => pick(key)} data-testid={`tab-admin-deposit-${key}`}>{text}</button>)}</div>
        {mode === 'reject' && <label className="admin-review-field"><span>Why wasn't it credited? (sent to applicant)</span><textarea className="admin-input" rows={3} value={reason} onChange={e => { setReason(e.target.value); setConfirming(false); setError(null); }} aria-invalid={!!error} data-testid="textarea-admin-deposit-reason" /><small className={error ? 'admin-field-error' : ''}>{error ?? `At least ${MIN_REJECTION_REASON_LENGTH} characters, e.g. "No transfer with this reference arrived within 5 days."`}</small></label>}
        <div className="admin-review-buttons">
          {confirming && <button type="button" className="admin-btn" onClick={() => setConfirming(false)} data-testid="button-admin-cancel-deposit">Cancel</button>}
          <button type="button" className={`admin-btn ${mode === 'reject' ? 'danger' : 'primary'}`} disabled={!can('payments.process')} onClick={submit} data-testid="button-admin-submit-deposit">{confirming ? (mode === 'confirm' ? `Confirm: credit ${usd(tx.amount)}` : 'Confirm rejection') : mode === 'confirm' ? 'Confirm received' : 'Reject deposit'}</button>
        </div>
        {confirming && <p className="admin-review-hint">This can't be undone.</p>}
      </> : <p className="admin-review-hint">{tx.status === 'Completed' ? 'Confirmed and credited to the applicant’s deposit balance. This is final.' : tx.status === 'Cancelled' ? 'The applicant cancelled this deposit. If the money arrives anyway, return it outside the app.' : `Rejected: ${tx.failureReason}`}</p>}
    </section>
    <div className="admin-detail-note"><Info size={17} /><span>{staffMoney.connected
      ? 'No bank or mobile-money feed is connected, so check that the money really arrived before confirming. Results are saved on the server, role-checked, and audited.'
      : 'Demo finance workflow. No bank or mobile-money feed is connected, so arrival can\'t be checked automatically. Results are saved in this browser only, and there is no real staff sign-in yet (actions are role-checked and audited).'}</span></div>
  </ReviewFrame>;
}
