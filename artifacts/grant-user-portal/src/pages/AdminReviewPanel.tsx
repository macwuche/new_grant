import { useEffect, useRef, useState } from 'react';
import { Check, Info, RefreshCw, X } from 'lucide-react';
import { format } from 'date-fns';
import { findGrant } from '@/domain/rules';
import {
  addInternalNote, applicantName, approveApplication, declineApplication, MAX_NOTE_LENGTH,
  MIN_MESSAGE_LENGTH, programBudget, requestChanges, startReview, validateAward,
} from '@/domain/review';
import { DEMO_REVIEWER } from '@/domain/seed';
import { useDemoStore } from '@/domain/store';
import type { Result } from '@/domain/model';
import './AdminReviewPanel.css';

type Decision = 'approve' | 'changes' | 'decline';

const usd = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string) => format(new Date(iso), 'dd MMM yyyy, HH:mm');
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function AdminReviewPanel({ appId, onClose }: { appId: string; onClose: () => void }) {
  const { state, run } = useDemoStore();
  const app = state.applications.find(a => a.id === appId);
  const closeRef = useRef<HTMLButtonElement>(null);
  // The version the reviewer has actually read. Decisions are checked against it.
  const [seenVersion, setSeenVersion] = useState(app?.updatedAt ?? '');
  const [decision, setDecision] = useState<Decision>('approve');
  const [award, setAward] = useState('');
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const grant = app && findGrant(app.grantId);
  const budget = app ? programBudget(state, app.grantId) : null;
  useEffect(() => {
    if (app && grant && budget) setAward(String(Math.max(0, Math.min(app.requestedAmount, grant.maxFunding, budget.remaining))));
    // Reset the suggested award only when a different version is being reviewed.
  }, [appId, seenVersion]);

  if (!app || !grant || !budget || app.status === 'Draft') {
    return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow={appId}><h2 id="admin-detail-title">Not in the queue</h2><p className="admin-detail-lead">This application no longer exists or has not been submitted.</p></ReviewFrame>;
  }

  const stale = app.updatedAt !== seenVersion;
  const after = (result: Result, clear?: () => void) => {
    setConfirming(false);
    if (!result.ok) { setErrors(result.fieldErrors ?? {}); setFlash({ tone: 'error', text: result.error }); return; }
    setErrors({}); clear?.();
    setFlash({ tone: 'ok', text: result.message });
    const updated = result.state.applications.find(a => a.id === appId);
    if (updated) setSeenVersion(updated.updatedAt);
  };
  const now = () => new Date();
  const awardValue = award.trim() === '' ? NaN : Number(award);
  const awardError = validateAward(state, app, awardValue);
  const pickDecision = (next: Decision) => { setDecision(next); setConfirming(false); setErrors({}); setFlash(null); };

  const submitDecision = () => {
    if (decision === 'approve') {
      if (awardError) { setErrors({ award: awardError }); return; }
      if (!confirming) { setConfirming(true); return; }
      after(run(s => approveApplication(s, app.id, seenVersion, awardValue, DEMO_REVIEWER, now())));
    } else if (decision === 'decline') {
      if (message.trim().length < MIN_MESSAGE_LENGTH) { setErrors({ reason: `Write at least ${MIN_MESSAGE_LENGTH} characters; the applicant sees this reason.` }); return; }
      if (!confirming) { setConfirming(true); return; }
      after(run(s => declineApplication(s, app.id, seenVersion, message, DEMO_REVIEWER, now())), () => setMessage(''));
    } else {
      after(run(s => requestChanges(s, app.id, seenVersion, message, DEMO_REVIEWER, now())), () => setMessage(''));
    }
  };
  const decisionLabel = decision === 'approve'
    ? (confirming ? `Confirm: approve ${Number.isFinite(awardValue) ? usd(awardValue) : ''}` : 'Approve')
    : decision === 'decline' ? (confirming ? 'Confirm decline' : 'Decline') : 'Send change request';
  const messageKey = decision === 'decline' ? 'reason' : 'message';

  return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow={`${app.id} / Review`}>
    <div className="admin-review-title"><h2 id="admin-detail-title" data-testid="text-admin-detail-title">{app.businessName}</h2><span className={`admin-badge ${app.status === 'Under review' ? 'review' : slug(app.status)}`} data-testid="status-admin-review">{app.status}</span></div>
    <p className="admin-detail-lead">{applicantName(state, app.applicantId)} · {grant.name}</p>

    {stale && <div className="admin-review-stale" role="alert" data-testid="notice-admin-stale"><span>This application changed since you opened it{app.history[app.history.length - 1]!.actor === 'Applicant' ? ' — the applicant updated it' : ''}.</span><button type="button" onClick={() => { setSeenVersion(app.updatedAt); setConfirming(false); setFlash(null); }} data-testid="button-admin-load-latest"><RefreshCw size={13} /> Load latest</button></div>}
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-review-flash">{flash.text}</div>}

    <dl className="admin-detail-fields">
      <Field label="Requested" value={usd(app.requestedAmount)} />
      {app.awardedAmount !== null && <Field label="Awarded" value={usd(app.awardedAmount)} />}
      <Field label="Submitted" value={app.submittedAt ? when(app.submittedAt) : '—'} />
      <Field label="Registration" value={app.registrationNumber || 'Not provided'} />
      <Field label="Reviewer" value={app.reviewer ?? 'Unassigned'} />
      <Field label="Program budget left" value={`${usd(budget.remaining)} of ${usd(budget.budget)}`} />
    </dl>

    <section className="admin-review-section"><h3>Funding plan</h3><p className="admin-review-text">{app.purpose}</p></section>
    <section className="admin-review-section"><h3>Requirements confirmed</h3><ul className="admin-review-checklist">{grant.requirements.map(req => { const ok = app.checklist.includes(req); return <li key={req} className={ok ? 'ok' : 'missing'}>{ok ? <Check size={13} /> : <X size={13} />}{req}</li>; })}</ul><p className="admin-review-hint">Applicants confirm readiness only; documents can't be uploaded or inspected yet.</p></section>

    <section className="admin-review-section admin-review-actions" aria-label="Decision">
      <h3>Decision</h3>
      {app.status === 'Submitted' && <><p className="admin-review-hint">Start the review to assign it to yourself and unlock decisions. The applicant will see it is under review.</p><button type="button" className="admin-btn primary" disabled={stale} onClick={() => after(run(s => startReview(s, app.id, seenVersion, DEMO_REVIEWER, now())))} data-testid="button-admin-start-review">Start review</button></>}
      {app.status === 'Under review' && <>
        <div className="admin-segment" role="tablist" aria-label="Decision type">{([['approve', 'Approve'], ['changes', 'Request changes'], ['decline', 'Decline']] as const).map(([key, label]) => <button type="button" role="tab" key={key} aria-selected={decision === key} className={decision === key ? 'active' : ''} onClick={() => pickDecision(key)} data-testid={`tab-admin-decision-${key}`}>{label}</button>)}</div>
        {decision === 'approve' ? <label className="admin-review-field"><span>Award amount (USD)</span><input className="admin-input" type="number" inputMode="decimal" step="0.01" min="0" value={award} onChange={e => { setAward(e.target.value); setConfirming(false); setErrors({}); }} aria-invalid={!!errors.award} data-testid="input-admin-award" /><small className={errors.award ? 'admin-field-error' : ''}>{errors.award ?? `Up to ${usd(Math.min(app.requestedAmount, grant.maxFunding, budget.remaining))}. Approval credits the applicant's grant balance immediately.`}</small></label>
          : <label className="admin-review-field"><span>{decision === 'decline' ? 'Reason for declining (sent to applicant)' : 'What should the applicant change? (sent to applicant)'}</span><textarea className="admin-input" rows={4} value={message} onChange={e => { setMessage(e.target.value); setConfirming(false); setErrors({}); }} aria-invalid={!!errors[messageKey]} data-testid="textarea-admin-decision-message" /><small className={errors[messageKey] ? 'admin-field-error' : ''}>{errors[messageKey] ?? `At least ${MIN_MESSAGE_LENGTH} characters.`}</small></label>}
        <div className="admin-review-buttons">
          {confirming && <button type="button" className="admin-btn" onClick={() => setConfirming(false)} data-testid="button-admin-cancel-decision">Cancel</button>}
          <button type="button" className={`admin-btn ${decision === 'decline' ? 'danger' : 'primary'}`} disabled={stale} onClick={submitDecision} data-testid="button-admin-submit-decision">{decisionLabel}</button>
        </div>
        {confirming && <p className="admin-review-hint">Decisions are final and visible to the applicant.</p>}
      </>}
      {app.status === 'Changes requested' && <p className="admin-review-hint">Waiting for the applicant to update and resubmit. It returns to the queue as submitted.</p>}
      {(app.status === 'Approved' || app.status === 'Declined') && <p className="admin-review-hint">Final decision recorded {when(app.updatedAt)} by {app.reviewer ?? 'a reviewer'}.</p>}
    </section>

    <section className="admin-review-section"><h3>History</h3><ol className="admin-review-history">{[...app.history].reverse().map(h => <li key={`${h.at}-${h.status}`}><strong>{h.status}</strong><span>{when(h.at)} · {h.actor === 'Reviewer' ? 'Grant team' : 'Applicant'}</span><p>{h.note}</p></li>)}</ol></section>

    <section className="admin-review-section"><h3>Internal notes</h3><p className="admin-review-hint">Staff only. Never shown to the applicant.</p>
      {app.internalNotes.length ? <ul className="admin-review-notes">{app.internalNotes.map(n => <li key={n.at}><span>{n.author} · {when(n.at)}</span><p>{n.text}</p></li>)}</ul> : null}
      <label className="admin-review-field"><span className="sr-only">New internal note</span><textarea className="admin-input" rows={3} maxLength={MAX_NOTE_LENGTH} value={note} onChange={e => { setNote(e.target.value); setErrors(({ note: _, ...rest }) => rest); }} placeholder="Add context for other reviewers…" aria-invalid={!!errors.note} data-testid="textarea-admin-note" />{errors.note && <small className="admin-field-error">{errors.note}</small>}</label>
      <button type="button" className="admin-btn" onClick={() => after(run(s => addInternalNote(s, app.id, note, DEMO_REVIEWER, now())), () => setNote(''))} data-testid="button-admin-add-note">Add note</button>
    </section>

    <div className="admin-detail-note"><Info size={17} /><span>Demo review workflow. Decisions are saved in this browser only and update the applicant preview here. There is no staff sign-in or authorization yet, so never use this with real applicant data.</span></div>
  </ReviewFrame>;
}

function Field({ label, value }: { label: string; value: string }) {
  return <div className="admin-detail-field"><dt>{label}</dt><dd data-testid={`text-admin-detail-${slug(label)}`}>{value}</dd></div>;
}

export function ReviewFrame({ eyebrow, onClose, closeRef, children }: { eyebrow: string; onClose: () => void; closeRef: React.RefObject<HTMLButtonElement | null>; children: React.ReactNode }) {
  return <div className="admin-detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }} data-testid="overlay-admin-review">
    <aside className="admin-detail admin-review" role="dialog" aria-modal="true" aria-labelledby="admin-detail-title">
      <div className="admin-detail-header"><span className="admin-eyebrow" style={{ margin: 0 }}>{eyebrow}</span><button ref={closeRef} type="button" className="admin-icon-button" onClick={onClose} aria-label="Close review" data-testid="button-close-admin-review"><X size={17} /></button></div>
      {children}
    </aside>
  </div>;
}
