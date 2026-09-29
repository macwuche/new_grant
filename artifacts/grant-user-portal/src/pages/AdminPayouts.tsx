import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Info, Search } from 'lucide-react';
import { format } from 'date-fns';
import { applicantName } from '@workspace/domain/review';
import { approvePayoutRelease, markPayoutFailed, markPayoutPaid, MIN_FAILURE_REASON_LENGTH, needsSecondSignOff, payoutAmounts, payoutQueue, pendingPayoutTotal } from '@workspace/domain/payouts';
import { actingStaff } from '@workspace/domain/staff';
import * as api from '@workspace/api-client-react';
import { useStaffMoney, type Outcome } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import type { Result, Transaction } from '@workspace/domain/model';
import { ReviewFrame } from './AdminReviewPanel';
import { RoleNotice, useCan, useStaffCommand } from './AdminStaff';

const usd = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string) => format(new Date(iso), 'dd MMM yyyy, HH:mm');
const day = (iso: string) => format(new Date(iso), 'dd MMM yyyy');
/** Finance wording for ledger statuses. */
const label = (tx: Transaction) => tx.status === 'Completed' ? 'Paid' : tx.status;
const badgeClass = (tx: Transaction) => `admin-badge ${tx.status === 'Completed' ? 'approved' : tx.status === 'Failed' ? 'declined' : tx.status === 'Cancelled' ? 'draft' : 'submitted'}`;

export function AdminPayouts() {
  const { state } = useDemoStore();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All statuses');
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const queue = payoutQueue(state);
  const pending = queue.filter(t => t.status === 'Pending');
  const rows = queue.filter(tx => (filter === 'All statuses' || label(tx) === filter) && `${tx.id} ${applicantName(state, tx.applicantId)} ${tx.destination ?? tx.description}`.toLowerCase().includes(query.toLowerCase()));
  const paidTotal = queue.filter(t => t.status === 'Completed').reduce((sum, t) => sum + payoutAmounts(t).net, 0);

  return <>
    <div className="admin-overview-metrics">
      <div className="admin-metric featured" data-testid="metric-admin-payouts-pending"><span className="admin-metric-label">Waiting to be paid</span><strong className="admin-metric-value">{String(pending.length).padStart(2, '0')}</strong><span className="admin-metric-foot">Oldest request first</span></div>
      <div className="admin-metric" data-testid="metric-admin-payouts-held"><span className="admin-metric-label">Held for pending payouts</span><strong className="admin-metric-value">{usd(pendingPayoutTotal(state))}</strong><span className="admin-metric-foot">Deducted from grant balances</span></div>
      <div className="admin-metric" data-testid="metric-admin-payouts-paid"><span className="admin-metric-label">Marked paid</span><strong className="admin-metric-value">{usd(paidTotal)}</strong><span className="admin-metric-foot">Net of fees</span></div>
      <div className="admin-metric" data-testid="metric-admin-payouts-failed"><span className="admin-metric-label">Failed</span><strong className="admin-metric-value">{String(queue.filter(t => t.status === 'Failed').length).padStart(2, '0')}</strong><span className="admin-metric-foot">Funds returned to applicants</span></div>
    </div>
    {state.lockdown && <div className="admin-review-stale" role="alert" data-testid="notice-admin-payouts-lockdown"><span><strong>System lockdown:</strong> payouts can't be released or marked paid until a super admin lifts it. Marking a payout failed (returning the funds) still works.</span></div>}
    <section className="admin-panel">
      <div className="admin-panel-head"><div><h2>Payout requests</h2><p>Withdrawal requests from applicants. No payment provider is connected; marking a payout paid only records it.</p></div></div>
      <div className="admin-toolbar"><div className="admin-toolbar-left"><label className="admin-search"><Search size={15} /><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search applicant, reference, destination" aria-label="Search payouts" data-testid="input-admin-search-payouts" /></label><select className="admin-filter" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter payouts by status" data-testid="select-admin-filter-payouts"><option>All statuses</option><option>Pending</option><option>Paid</option><option>Failed</option><option>Cancelled</option></select></div><span className="admin-count" data-testid="text-admin-payouts-count">{rows.length} of {queue.length} requests</span></div>
      {rows.length ? <>
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Request</th><th>Destination</th><th>Amount</th><th>Applicant receives</th><th>Status</th><th>Requested</th><th><span className="admin-eyebrow" style={{ margin: 0 }}>Process</span></th></tr></thead><tbody>{rows.map(tx => { const a = payoutAmounts(tx); return <tr key={tx.id} data-testid={`row-admin-payout-${tx.id}`}><td><span className="admin-table-primary">{applicantName(state, tx.applicantId)}</span><span className="admin-table-secondary">{tx.id}</span></td><td className="admin-table-muted">{tx.destination ?? tx.description}</td><td className="admin-table-number">{usd(a.gross)}</td><td className="admin-table-number">{usd(a.net)}</td><td><span className={badgeClass(tx)}>{label(tx)}</span>{tx.status === 'Pending' && needsSecondSignOff(state, tx) && <span className="admin-flag">{tx.releaseApproval ? 'Released' : '2 sign-offs'}</span>}</td><td className="admin-table-muted">{day(tx.createdAt)}</td><td><button type="button" className="admin-icon-button" onClick={() => setOpenId(tx.id)} aria-label={`Open payout ${tx.id}`} data-testid={`button-open-admin-payout-${tx.id}`}><ArrowRight size={15} /></button></td></tr>; })}</tbody></table></div>
        <div className="admin-mobile-records" role="list" aria-label="Payout requests">{rows.map(tx => { const a = payoutAmounts(tx); return <article className="admin-mobile-record" role="listitem" key={tx.id} data-testid={`card-admin-payout-${tx.id}`}>
          <div className="admin-mobile-record-top"><div className="admin-mobile-record-identity"><strong>{applicantName(state, tx.applicantId)}</strong><span>{tx.id}</span></div><span className={badgeClass(tx)}>{label(tx)}</span></div>
          <dl className="admin-mobile-record-facts"><div><dt>Amount</dt><dd>{usd(a.gross)}</dd></div><div><dt>Receives</dt><dd>{usd(a.net)}</dd></div><div><dt>Requested</dt><dd>{day(tx.createdAt)}</dd></div></dl>
          <button type="button" className="admin-mobile-record-action" onClick={() => setOpenId(tx.id)} data-testid={`button-open-admin-payout-mobile-${tx.id}`}>{tx.status === 'Pending' ? 'Process payout' : 'View payout'} <ArrowRight size={15} /></button>
        </article>; })}</div>
      </> : <div className="admin-empty" data-testid="empty-admin-payouts"><Search size={25} /><h3>No payout requests in this view</h3><p>Applicants' withdrawal requests appear here.</p></div>}
    </section>
    {openId && <PayoutPanel txId={openId} onClose={close} />}
  </>;
}

function PayoutPanel({ txId, onClose }: { txId: string; onClose: () => void }) {
  const { state } = useDemoStore();
  const command = useStaffCommand();
  const staffMoney = useStaffMoney();
  const can = useCan();
  const me = actingStaff(state);
  const tx = state.transactions.find(t => t.id === txId);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<'paid' | 'failed'>('paid');
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

  if (!tx || tx.type !== 'Withdrawal') return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow={txId}><h2 id="admin-detail-title">Payout not found</h2></ReviewFrame>;
  const amounts = payoutAmounts(tx);
  const after = (result: Outcome) => {
    setConfirming(false);
    if (!result.ok) { setError(result.fieldErrors?.reason ?? null); setFlash({ tone: 'error', text: result.error }); return; }
    setError(null); setReason(''); setFlash({ tone: 'ok', text: result.message });
  };
  const submit = () => {
    if (mode === 'failed' && reason.trim().length < MIN_FAILURE_REASON_LENGTH) { setError(`Write at least ${MIN_FAILURE_REASON_LENGTH} characters; the applicant sees this reason.`); return; }
    if (!confirming) { setConfirming(true); return; }
    if (staffMoney.connected) { void staffMoney.entry(() => mode === 'paid' ? api.markPayoutPaid(tx.id) : api.markPayoutFailed(tx.id, { reason })).then(after); return; }
    after(command('payments.process', { action: mode === 'paid' ? 'Mark payout paid' : 'Mark payout failed', target: tx.id }, (s, actor) => mode === 'paid' ? markPayoutPaid(s, tx.id, actor.name, new Date()) : markPayoutFailed(s, tx.id, reason, actor.name, new Date())));
  };
  const dual = needsSecondSignOff(state, tx);
  const release = () => staffMoney.connected
    ? void staffMoney.entry(() => api.approvePayoutRelease(tx.id)).then(after)
    : after(command('payments.release', { action: 'Approve payout release', target: tx.id }, (s, actor) => approvePayoutRelease(s, tx.id, actor.name, new Date())));
  const pick = (next: 'paid' | 'failed') => { setMode(next); setConfirming(false); setError(null); setFlash(null); };

  return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow={`${tx.id} / Payout`}>
    <div className="admin-review-title"><h2 id="admin-detail-title" data-testid="text-admin-detail-title">{usd(amounts.gross)}</h2><span className={badgeClass(tx)} data-testid="status-admin-payout">{label(tx)}</span></div>
    <p className="admin-detail-lead">{applicantName(state, tx.applicantId)} · requested {when(tx.createdAt)}</p>
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-payout-flash">{flash.text}</div>}
    <dl className="admin-detail-fields">
      {[['Destination', tx.destination ?? tx.description], ['Requested amount', usd(amounts.gross)], ['Processing fee', usd(amounts.fee)], ['Applicant receives', usd(amounts.net)], ...(tx.processedAt ? [[tx.status === 'Cancelled' ? 'Cancelled' : 'Processed', `${when(tx.processedAt)} by ${tx.status === 'Cancelled' ? 'the applicant' : tx.processedBy ?? 'finance'}`]] : [])].map(([k, v]) => <div className="admin-detail-field" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
    <section className="admin-review-section admin-review-actions" aria-label="Process payout">
      <h3>Process</h3>
      {tx.status === 'Pending' ? <>
        {dual && <div className="admin-dual-control" data-testid="panel-admin-dual-control">
          <strong>Two sign-offs required</strong>
          <p className="admin-review-hint">At or above the {usd(state.treasury.dualControlThreshold)} threshold, a second staff member (compliance or a super admin) approves the release, and someone else marks it paid.</p>
          <ol className="admin-dual-steps"><li className={tx.releaseApproval ? 'done' : ''}>Release approved{tx.releaseApproval ? ` by ${tx.releaseApproval.by} · ${when(tx.releaseApproval.at)}` : ' — waiting'}</li><li>Marked paid by a different person</li></ol>
          {!tx.releaseApproval && (can('payments.release') ? <button type="button" className="admin-btn primary" disabled={!!state.lockdown} onClick={release} data-testid="button-admin-payout-release">Approve release</button> : <RoleNotice permission="payments.release" />)}
          {tx.releaseApproval && me?.name === tx.releaseApproval.by && <p className="admin-review-hint admin-role-notice">You approved the release, so a different staff member must mark it paid.</p>}
        </div>}
        <RoleNotice permission="payments.process" />
        <p className="admin-review-hint">Send {usd(amounts.net)} to the destination outside this app, then record the result.{me ? <> Acting as <strong>{me.name}</strong>.</> : null}</p>
        <div className="admin-segment" role="tablist" aria-label="Payout result">{([['paid', 'Mark as paid'], ['failed', 'Mark as failed']] as const).map(([key, text]) => <button type="button" role="tab" key={key} aria-selected={mode === key} className={mode === key ? 'active' : ''} onClick={() => pick(key)} data-testid={`tab-admin-payout-${key}`}>{text}</button>)}</div>
        {mode === 'failed' && <label className="admin-review-field"><span>Why did it fail? (sent to applicant)</span><textarea className="admin-input" rows={3} value={reason} onChange={e => { setReason(e.target.value); setConfirming(false); setError(null); }} aria-invalid={!!error} data-testid="textarea-admin-payout-reason" /><small className={error ? 'admin-field-error' : ''}>{error ?? `At least ${MIN_FAILURE_REASON_LENGTH} characters. The ${usd(amounts.gross)} returns to the applicant's grant balance.`}</small></label>}
        <div className="admin-review-buttons">
          {confirming && <button type="button" className="admin-btn" onClick={() => setConfirming(false)} data-testid="button-admin-cancel-payout">Cancel</button>}
          <button type="button" className={`admin-btn ${mode === 'failed' ? 'danger' : 'primary'}`} disabled={!can('payments.process') || (mode === 'paid' && (!!state.lockdown || (dual && (!tx.releaseApproval || me?.name === tx.releaseApproval.by))))} onClick={submit} data-testid="button-admin-submit-payout">{confirming ? (mode === 'paid' ? `Confirm: paid ${usd(amounts.net)}` : 'Confirm failure') : mode === 'paid' ? 'Mark as paid' : 'Mark as failed'}</button>
        </div>
        {confirming && <p className="admin-review-hint">This can't be undone.</p>}
      </> : <p className="admin-review-hint">{tx.status === 'Completed' ? 'Recorded as paid. This is final.' : tx.status === 'Cancelled' ? 'The applicant cancelled this request before it was processed. Do not send it.' : `Recorded as failed: ${tx.failureReason}. The amount was returned to the applicant's grant balance.`}</p>}
    </section>
    <div className="admin-detail-note"><Info size={17} /><span>{staffMoney.connected
      ? 'No payment provider is connected: send the money outside the app, then record it here. Results are saved on the server, role-checked, and audited; large payouts need two different people.'
      : 'Preview finance workflow. No bank or mobile-money provider is connected, so no money moves. Results are saved in this browser only and audited against the acting staff member, but there is no real staff sign-in yet.'}</span></div>
  </ReviewFrame>;
}
