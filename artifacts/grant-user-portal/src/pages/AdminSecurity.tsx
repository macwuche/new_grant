import { useState } from 'react';
import { ArrowRight, ShieldAlert, ShieldCheck } from 'lucide-react';
import { format } from 'date-fns';
import { applicantRecords } from '@workspace/domain/applicants';
import { MIN_REASON_LENGTH } from '@workspace/domain/accounts';
import { applicantName, openEscalations } from '@workspace/domain/review';
import { findGrant } from '@workspace/domain/rules';
import { assessRisk } from '@workspace/domain/risk';
import { endLockdown, startLockdown } from '@workspace/domain/security';
import { useDemoStore } from '@/lib/store';
import type { Result } from '@workspace/domain/model';
import { RiskBadge } from './AdminRisk';
import { RoleNotice, useCan, useStaffCommand } from './AdminStaff';

const when = (iso: string) => format(new Date(iso), 'dd MMM yyyy, HH:mm');
const pad = (value: number) => String(value).padStart(2, '0');
const KYC_ORDER = { Pending: 0, Rejected: 1, 'Not submitted': 2, Verified: 3 } as const;
const kycTone = { Verified: 'verified', Pending: 'submitted', Rejected: 'declined', 'Not submitted': 'draft' } as const;

export function AdminSecurity({ openApplicant, openReview }: { openApplicant: (id: string) => void; openReview: (id: string) => void }) {
  const { state } = useDemoStore();
  const now = new Date();
  const people = applicantRecords(state).map(p => ({ ...p, risk: assessRisk(state, p.id, now) })).sort((a, b) => b.risk.score - a.risk.score);
  const kycQueue = [...people].sort((a, b) => KYC_ORDER[a.account.kyc.status] - KYC_ORDER[b.account.kyc.status] || (a.account.kyc.submittedAt ?? '').localeCompare(b.account.kyc.submittedAt ?? ''));
  const escalations = openEscalations(state);
  const pendingKyc = people.filter(p => p.account.kyc.status === 'Pending').length;
  const high = people.filter(p => p.risk.level === 'High').length;

  return <>
    <div className="admin-overview-metrics">
      <div className={`admin-metric ${state.lockdown ? 'featured' : ''}`} data-testid="metric-admin-lockdown"><span className="admin-metric-label">System status</span><strong className="admin-metric-value" style={{ fontSize: 26 }}>{state.lockdown ? 'Lockdown' : 'Normal'}</strong><span className="admin-metric-foot">{state.lockdown ? `Since ${when(state.lockdown.since)}` : 'Payouts flowing normally'}</span></div>
      <div className="admin-metric" data-testid="metric-admin-high-risk"><span className="admin-metric-label">High-risk applicants</span><strong className="admin-metric-value">{pad(high)}</strong><span className="admin-metric-foot">Score 60 or more</span></div>
      <div className="admin-metric" data-testid="metric-admin-kyc-pending"><span className="admin-metric-label">Identity checks waiting</span><strong className="admin-metric-value">{pad(pendingKyc)}</strong><span className="admin-metric-foot">Oldest first below</span></div>
      <div className="admin-metric" data-testid="metric-admin-escalations"><span className="admin-metric-label">Open escalations</span><strong className="admin-metric-value">{pad(escalations.length)}</strong><span className="admin-metric-foot">Approval blocked until cleared</span></div>
    </div>

    <LockdownPanel />

    <div className="admin-overview-bottom" style={{ marginTop: 17 }}>
      <section className="admin-panel" data-testid="panel-admin-kyc-queue"><div className="admin-panel-head"><div><h2>Identity checks</h2><p>Waiting checks first. Open one to approve or reject it.</p></div></div>
        {kycQueue.filter(p => p.account.kyc.status !== 'Verified').length ? <div className="admin-list">{kycQueue.filter(p => p.account.kyc.status !== 'Verified').map(p => <div className="admin-list-item" key={p.id} data-testid={`item-admin-kyc-${p.id}`}>
          <span className="admin-list-copy"><strong>{p.name}</strong><small>{p.account.kyc.documentType ? `${p.account.kyc.documentType} · submitted ${when(p.account.kyc.submittedAt!)}` : 'Nothing submitted yet'}</small></span>
          <span className={`admin-badge ${kycTone[p.account.kyc.status]}`}>{p.account.kyc.status}</span>
          <button type="button" className="admin-icon-button" onClick={() => openApplicant(p.id)} aria-label={`Open identity check for ${p.name}`} data-testid={`button-admin-open-kyc-${p.id}`}><ArrowRight size={15} /></button>
        </div>)}</div> : <p className="admin-review-hint">Every applicant is verified.</p>}
      </section>
      <section className="admin-panel" data-testid="panel-admin-escalations"><div className="admin-panel-head"><div><h2>Escalated applications</h2><p>Sent to compliance by a reviewer. Clear them from the review panel.</p></div></div>
        {escalations.length ? <div className="admin-list">{escalations.map(a => <div className="admin-list-item" key={a.id} data-testid={`item-admin-escalation-${a.id}`}>
          <span className="admin-list-icon"><ShieldAlert size={17} /></span>
          <span className="admin-list-copy"><strong>{a.businessName} · {a.id}</strong><small>{applicantName(state, a.applicantId)} · {findGrant(state, a.grantId)?.name} · by {a.escalation!.by}: {a.escalation!.reason}</small></span>
          <button type="button" className="admin-icon-button" onClick={() => openReview(a.id)} aria-label={`Open escalated application ${a.id}`} data-testid={`button-admin-open-escalation-${a.id}`}><ArrowRight size={15} /></button>
        </div>)}</div> : <p className="admin-review-hint">No open escalations.</p>}
      </section>
    </div>

    <section className="admin-panel" style={{ marginTop: 17 }} data-testid="panel-admin-risk-watchlist"><div className="admin-panel-head"><div><h2>Risk watchlist</h2><p>Every applicant's automated fraud score (0–100), highest first. Scores are recalculated from current data; device and sign-in location signals are fictional.</p></div></div>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Applicant</th><th>Score</th><th>Why</th><th>Account</th><th><span className="admin-eyebrow" style={{ margin: 0 }}>Open</span></th></tr></thead><tbody>{people.map(p => <tr key={p.id} data-testid={`row-admin-risk-${p.id}`}>
        <td><span className="admin-table-primary">{p.name}</span><span className="admin-table-secondary">{p.id} · Tier {p.tier}</span></td>
        <td><RiskBadge risk={p.risk} /></td>
        <td className="admin-table-muted" style={{ maxWidth: 360 }}>{p.risk.factors.length ? p.risk.factors.map(f => `${f.label} (+${f.points})`).join(' · ') : 'No signals'}</td>
        <td><span className={`admin-badge ${p.account.status === 'Locked' ? 'declined' : 'active'}`}>{p.account.status}</span></td>
        <td><button type="button" className="admin-icon-button" onClick={() => openApplicant(p.id)} aria-label={`Open ${p.name}`} data-testid={`button-admin-open-risk-${p.id}`}><ArrowRight size={15} /></button></td>
      </tr>)}</tbody></table></div>
    </section>
  </>;
}

function LockdownPanel() {
  const { state } = useDemoStore();
  const command = useStaffCommand();
  const allowed = useCan()('security.lockdown');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const pending = state.transactions.filter(t => t.type === 'Withdrawal' && t.status === 'Pending').length;
  const after = (result: Result) => {
    setConfirming(false);
    if (!result.ok) { setError(result.fieldErrors?.reason ?? null); setFlash({ tone: 'error', text: result.error }); return; }
    setError(null); setReason(''); setFlash({ tone: 'ok', text: result.message });
  };
  const start = () => {
    if (reason.trim().length < MIN_REASON_LENGTH) { setError(`Write at least ${MIN_REASON_LENGTH} characters.`); return; }
    if (!confirming) { setConfirming(true); return; }
    after(command('security.lockdown', { action: 'Start system lockdown', target: 'lockdown' }, (s, actor) => startLockdown(s, reason, actor.name, new Date())));
  };
  return <section className={`admin-panel admin-lockdown ${state.lockdown ? 'active' : ''}`} data-testid="panel-admin-lockdown">
    <div className="admin-panel-head"><div><h2>{state.lockdown ? <ShieldAlert size={16} style={{ display: 'inline', verticalAlign: '-3px' }} /> : <ShieldCheck size={16} style={{ display: 'inline', verticalAlign: '-3px' }} />} Emergency lockdown</h2><p>Freezes pending payouts and blocks new payout requests during a suspected breach. Deposits, reviews, and marking payouts failed (which returns funds) keep working.</p></div></div>
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-lockdown-flash">{flash.text}</div>}
    <RoleNotice permission="security.lockdown" />
    {state.lockdown ? <>
      <p className="admin-review-text"><strong>Active</strong> since {when(state.lockdown.since)} · started by {state.lockdown.by}</p>
      <p className="admin-review-hint">{state.lockdown.reason}</p>
      <div className="admin-review-buttons"><button type="button" className="admin-btn primary" disabled={!allowed} onClick={() => after(command('security.lockdown', { action: 'End system lockdown', target: 'lockdown' }, (s, actor) => endLockdown(s, actor.name, new Date())))} data-testid="button-admin-end-lockdown">Lift lockdown</button></div>
    </> : allowed && <>
      <label className="admin-review-field"><span>Reason (recorded in the audit log)</span><textarea className="admin-input" rows={2} value={reason} onChange={e => { setReason(e.target.value); setError(null); setConfirming(false); }} aria-invalid={!!error} data-testid="textarea-admin-lockdown-reason" /><small className={error ? 'admin-field-error' : ''}>{error ?? `At least ${MIN_REASON_LENGTH} characters. ${pending} pending payout${pending === 1 ? '' : 's'} will be frozen and those applicants notified.`}</small></label>
      <div className="admin-review-buttons">{confirming && <button type="button" className="admin-btn" onClick={() => setConfirming(false)} data-testid="button-admin-cancel-lockdown">Cancel</button>}<button type="button" className="admin-btn danger" onClick={start} data-testid="button-admin-start-lockdown">{confirming ? 'Confirm lockdown' : 'Start lockdown'}</button></div>
    </>}
  </section>;
}
