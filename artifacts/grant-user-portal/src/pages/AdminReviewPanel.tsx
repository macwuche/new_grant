import { useEffect, useRef, useState } from 'react';
import { Check, Info, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { differenceInDays, format } from 'date-fns';
import { findGrant } from '@workspace/domain/rules';
import {
  addInternalNote, applicantName, approveApplication, clearEscalation, declineApplication, escalateApplication, MAX_NOTE_LENGTH,
  commissionOn, MIN_MESSAGE_LENGTH, requestChanges, startReview, validateAward,
} from '@workspace/domain/review';
import { findApplicant } from '@workspace/domain/applicants';
import { assessRisk } from '@workspace/domain/risk';
import * as api from '@workspace/api-client-react';
import { adoptServerApplication } from '@workspace/domain/sync';
import { apiError, useServerData } from '@/lib/serverData';
import { DocumentFiles, useStaffDocuments } from '@/lib/documents';
import { useDemoStore } from '@/lib/store';
import type { Application, Result } from '@workspace/domain/model';
import { RoleNotice, useCan, useStaffCommand } from './AdminStaff';
import { RiskBadge } from './AdminRisk';
import './AdminReviewPanel.css';

type Decision = 'approve' | 'changes' | 'decline';
type Outcome = { ok: true; message: string; version?: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };

const usd = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string) => format(new Date(iso), 'dd MMM yyyy, HH:mm');
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function AdminReviewPanel({ appId, onClose }: { appId: string; onClose: () => void }) {
  const { state, run } = useDemoStore();
  const { connected, refreshApplications } = useServerData();
  const [busy, setBusy] = useState(false);
  const command = useStaffCommand();
  const can = useCan();
  const app = state.applications.find(a => a.id === appId);
  const closeRef = useRef<HTMLButtonElement>(null);
  // The version the reviewer has actually read. Decisions are checked against it.
  const [seenVersion, setSeenVersion] = useState(app?.updatedAt ?? '');
  const [decision, setDecision] = useState<Decision>('approve');
  const [award, setAward] = useState('');
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const [escalationText, setEscalationText] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const mayOpenEvidence = can('applications.review') || can('applications.clearEscalation') || can('kyc.review');
  const evidence = useStaffDocuments(connected && mayOpenEvidence, { applicationId: appId });

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const grant = app && findGrant(state, app.grantId);
  useEffect(() => {
    if (app && grant) setAward(String(Math.max(0, Math.min(app.requestedAmount, grant.maxFunding))));
    // Reset the suggested award only when a different version is being reviewed.
  }, [appId, seenVersion]);

  if (!app || !grant || app.status === 'Draft') {
    return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow={appId}><h2 id="admin-detail-title">Not in the queue</h2><p className="admin-detail-lead">This application no longer exists or has not been submitted.</p></ReviewFrame>;
  }

  const stale = app.updatedAt !== seenVersion;
  const after = (result: Outcome, clear?: () => void) => {
    setConfirming(false);
    if (!result.ok) { setErrors(result.fieldErrors ?? {}); setFlash({ tone: 'error', text: result.error }); return; }
    setErrors({}); clear?.();
    setFlash({ tone: 'ok', text: result.message });
    if (result.version) setSeenVersion(result.version);
  };
  // Without sign-in the rule runs on this browser's store (role-checked and audited there);
  // signed in, the API runs it under the program's lock and the store takes the saved application.
  const act = async (local: () => Result, remote: () => Promise<api.ApplicationResult>, clear?: () => void) => {
    if (!connected) {
      const result = local();
      after(result.ok ? { ok: true, message: result.message, version: result.state.applications.find(a => a.id === appId)?.updatedAt } : result, clear);
      return;
    }
    setBusy(true);
    try {
      const res = await remote();
      run(s => adoptServerApplication(s, res.application as Application));
      after({ ok: true, message: res.message, version: res.application.updatedAt }, clear);
    } catch (err) {
      const failure = apiError(err, "Couldn't reach the server. Nothing was changed; try again.");
      if (failure.status === 409 || failure.status === 404) void refreshApplications();
      after({ ok: false, error: failure.error, fieldErrors: failure.fieldErrors });
    } finally { setBusy(false); }
  };
  const now = () => new Date();
  const awardValue = award.trim() === '' ? NaN : Number(award);
  const awardError = validateAward(state, app, awardValue);
  const commission = commissionOn(state, app, Number.isFinite(awardValue) ? awardValue : 0);
  const pickDecision = (next: Decision) => { setDecision(next); setConfirming(false); setErrors({}); setFlash(null); };

  const review = (action: string, fn: Parameters<typeof command>[2]) => command('applications.review', { action, target: app.id }, fn);
  const submitDecision = () => {
    if (decision === 'approve') {
      if (awardError) { setErrors({ award: awardError }); return; }
      if (!confirming) { setConfirming(true); return; }
      void act(() => review('Approve application', (s, actor) => approveApplication(s, app.id, seenVersion, awardValue, actor.name, now())), () => api.approveApplication(app.id, { version: seenVersion, award: awardValue }));
    } else if (decision === 'decline') {
      if (message.trim().length < MIN_MESSAGE_LENGTH) { setErrors({ reason: `Write at least ${MIN_MESSAGE_LENGTH} characters; the applicant sees this reason.` }); return; }
      if (!confirming) { setConfirming(true); return; }
      void act(() => review('Decline application', (s, actor) => declineApplication(s, app.id, seenVersion, message, actor.name, now())), () => api.declineApplication(app.id, { version: seenVersion, reason: message }), () => setMessage(''));
    } else {
      void act(() => review('Request changes', (s, actor) => requestChanges(s, app.id, seenVersion, message, actor.name, now())), () => api.requestApplicationChanges(app.id, { version: seenVersion, message }), () => setMessage(''));
    }
  };
  const canReview = can('applications.review');
  const person = findApplicant(state, app.applicantId);
  const risk = assessRisk(state, app.applicantId, new Date());
  const escalation = app.escalation;
  const escalationOpen = escalation?.status === 'Open';
  const canEscalate = can('applications.escalate') && ['Submitted', 'Under review', 'Changes requested'].includes(app.status) && !escalationOpen;
  const canClear = can('applications.clearEscalation') && escalationOpen;
  const submitEscalation = () => {
    if (escalationOpen) void act(() => command('applications.clearEscalation', { action: 'Clear escalation', target: app.id }, (s, actor) => clearEscalation(s, app.id, escalationText, actor.name, now())), () => api.clearEscalation(app.id, { resolution: escalationText }), () => setEscalationText(''));
    else void act(() => command('applications.escalate', { action: 'Escalate to security', target: app.id }, (s, actor) => escalateApplication(s, app.id, escalationText, actor.name, now())), () => api.escalateApplication(app.id, { reason: escalationText }), () => setEscalationText(''));
  };
  const decisionLabel = decision === 'approve'
    ? (confirming ? `Confirm: approve ${Number.isFinite(awardValue) ? usd(awardValue) : ''}` : 'Approve')
    : decision === 'decline' ? (confirming ? 'Confirm decline' : 'Decline') : 'Send change request';
  const messageKey = decision === 'decline' ? 'reason' : 'message';

  return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow={`${app.id} / Review`}>
    <div className="admin-review-title"><h2 id="admin-detail-title" data-testid="text-admin-detail-title">{app.businessName}</h2><span className="admin-review-badges">{escalationOpen && <span className="admin-badge declined" data-testid="status-admin-escalated">Escalated</span>}<span className={`admin-badge ${app.status === 'Under review' ? 'review' : slug(app.status)}`} data-testid="status-admin-review">{app.status}</span></span></div>
    <p className="admin-detail-lead">{applicantName(state, app.applicantId)} · {grant.name}</p>

    {stale && <div className="admin-review-stale" role="alert" data-testid="notice-admin-stale"><span>This application changed since you opened it{app.history[app.history.length - 1]!.actor === 'Applicant' ? ' — the applicant updated it' : ''}.</span><button type="button" onClick={() => { setSeenVersion(app.updatedAt); setConfirming(false); setFlash(null); }} data-testid="button-admin-load-latest"><RefreshCw size={13} /> Load latest</button></div>}
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-review-flash">{flash.text}</div>}

    <dl className="admin-detail-fields">
      <Field label="Requested" value={usd(app.requestedAmount)} />
      {app.awardedAmount !== null && <Field label="Awarded" value={usd(app.awardedAmount)} />}
      <Field label="Commission" value={commission.rate > 0 ? `${commission.rate}%${app.awardedAmount !== null ? ` · ${usd(commissionOn(state, app, app.awardedAmount).amount)} taken` : ''}` : 'None'} />
      <Field label="Submitted" value={app.submittedAt ? when(app.submittedAt) : '—'} />
      <Field label="Registration" value={app.registrationNumber || 'Not provided'} />
      <Field label="Reviewer" value={app.reviewer ?? 'Unassigned'} />
      {person && <Field label="Account" value={`Tier ${person.tier} · ${person.identityVerified ? 'identity verified' : 'identity not verified'} · ${differenceInDays(new Date(), new Date(`${person.joined}T00:00:00`))} days old${person.account.status === 'Locked' ? ' · LOCKED' : ''}`} />}
      <div className="admin-detail-field"><dt>Fraud risk</dt><dd data-testid="text-admin-detail-risk"><RiskBadge risk={risk} />{risk.factors.length > 0 && <span className="admin-risk-factors">{risk.factors.map(f => `${f.label} (+${f.points})`).join(' · ')}</span>}</dd></div>
    </dl>

    <section className="admin-review-section"><h3>Funding plan</h3><p className="admin-review-text">{app.purpose}</p></section>
    {connected
      ? <section className="admin-review-section" data-testid="section-admin-evidence"><h3>Requirements and files</h3>
        {!mayOpenEvidence ? <p className="admin-review-hint">Your role can't open application files.</p>
          : evidence.error ? <p className="admin-field-error">{evidence.error}</p>
          : evidence.docs === null ? <p className="admin-review-hint">Loading…</p>
          : [...grant.requirements.map(r => ({ slot: r, label: r })), ...grant.questions.filter(q => q.type === 'file').map(q => ({ slot: `field:${q.id}`, label: `${q.label}${q.required ? '' : ' (optional)'}` }))].map(({ slot, label }) => { const files = evidence.docs!.filter(d => d.requirement === slot); return <div key={slot}><p className={`admin-review-req ${files.length ? 'ok' : 'missing'}`}>{files.length ? <Check size={13} /> : <X size={13} />}{label}</p><DocumentFiles docs={files} editable={false} buttonClass="admin-btn" onToast={text => setFlash({ tone: 'error', text })} empty="No file." /></div>; })}
        <p className="admin-review-hint">Opening a file is recorded in the audit log.</p></section>
      : <section className="admin-review-section"><h3>Requirements confirmed</h3><ul className="admin-review-checklist">{grant.requirements.map(req => { const ok = app.checklist.includes(req); return <li key={req} className={ok ? 'ok' : 'missing'}>{ok ? <Check size={13} /> : <X size={13} />}{req}</li>; })}</ul><p className="admin-review-hint">Preview: applicants confirm readiness only; no files are uploaded.</p></section>}
    {grant.questions.some(q => q.type !== 'file') && <section className="admin-review-section"><h3>Application form</h3><dl className="admin-detail-fields">{grant.questions.filter(q => q.type !== 'file').map(q => <div className="admin-detail-field" key={q.id}><dt>{q.label}</dt><dd data-testid={`text-admin-answer-${q.id}`}>{app.answers[q.id] || <span className="admin-table-muted">Not answered</span>}</dd></div>)}</dl></section>}

    <section className="admin-review-section admin-review-actions" aria-label="Decision">
      <h3>Decision</h3>
      <RoleNotice permission="applications.review" />
      {escalationOpen && app.status === 'Under review' && <p className="admin-review-hint admin-role-notice"><ShieldAlert size={11} /> Escalated to security: approval is blocked until compliance clears it. You can still request changes or decline.</p>}
      {app.status === 'Submitted' && <><p className="admin-review-hint">Start the review to assign it to yourself and unlock decisions. The applicant will see it is under review.</p><button type="button" className="admin-btn primary" disabled={stale || !canReview || busy} onClick={() => void act(() => review('Start review', (s, actor) => startReview(s, app.id, seenVersion, actor.name, now())), () => api.startReview(app.id, { version: seenVersion }))} data-testid="button-admin-start-review">Start review</button></>}
      {app.status === 'Under review' && <>
        <div className="admin-segment" role="tablist" aria-label="Decision type">{([['approve', 'Approve'], ['changes', 'Request changes'], ['decline', 'Decline']] as const).map(([key, label]) => <button type="button" role="tab" key={key} aria-selected={decision === key} className={decision === key ? 'active' : ''} onClick={() => pickDecision(key)} data-testid={`tab-admin-decision-${key}`}>{label}</button>)}</div>
        {decision === 'approve' ? <label className="admin-review-field"><span>Award amount (USD)</span><input className="admin-input" type="number" inputMode="decimal" step="0.01" min="0" value={award} onChange={e => { setAward(e.target.value); setConfirming(false); setErrors({}); }} aria-invalid={!!errors.award} data-testid="input-admin-award" /><small className={errors.award ? 'admin-field-error' : ''}>{errors.award ?? `Up to ${usd(Math.min(app.requestedAmount, grant.maxFunding))}. Approval credits the applicant's grant balance immediately${commission.rate > 0 ? ` and takes a ${commission.rate}% commission (${usd(commission.amount)}) from their deposit balance, even below zero` : ''}.`}</small></label>
          : <label className="admin-review-field"><span>{decision === 'decline' ? 'Reason for declining (sent to applicant)' : 'What should the applicant change? (sent to applicant)'}</span><textarea className="admin-input" rows={4} value={message} onChange={e => { setMessage(e.target.value); setConfirming(false); setErrors({}); }} aria-invalid={!!errors[messageKey]} data-testid="textarea-admin-decision-message" /><small className={errors[messageKey] ? 'admin-field-error' : ''}>{errors[messageKey] ?? `At least ${MIN_MESSAGE_LENGTH} characters.`}</small></label>}
        <div className="admin-review-buttons">
          {confirming && <button type="button" className="admin-btn" onClick={() => setConfirming(false)} data-testid="button-admin-cancel-decision">Cancel</button>}
          <button type="button" className={`admin-btn ${decision === 'decline' ? 'danger' : 'primary'}`} disabled={stale || !canReview || busy || (decision === 'approve' && escalationOpen)} onClick={submitDecision} data-testid="button-admin-submit-decision">{decisionLabel}</button>
        </div>
        {confirming && <p className="admin-review-hint">Decisions are final and visible to the applicant.</p>}
      </>}
      {app.status === 'Changes requested' && <p className="admin-review-hint">Waiting for the applicant to update and resubmit. It returns to the queue as submitted.</p>}
      {(app.status === 'Approved' || app.status === 'Declined') && <p className="admin-review-hint">Final decision recorded {when(app.updatedAt)} by {app.reviewer ?? 'a reviewer'}.</p>}
    </section>

    <section className="admin-review-section" aria-label="Security escalation" data-testid="section-admin-escalation"><h3>Security escalation</h3>
      {escalation ? <div className={`admin-escalation ${escalation.status === 'Open' ? 'open' : ''}`}><strong>{escalation.status === 'Open' ? 'Open' : 'Cleared'}</strong><span>Escalated by {escalation.by} · {when(escalation.at)}</span><p>{escalation.reason}</p>{escalation.status === 'Cleared' && <><span>Cleared by {escalation.clearedBy} · {when(escalation.clearedAt!)}</span><p>{escalation.resolution}</p></>}</div>
        : <p className="admin-review-hint">Send this application to compliance for a fraud or identity check. The applicant isn't told, and approval is blocked until it's cleared.</p>}
      {(canEscalate || canClear) && <><label className="admin-review-field"><span>{escalationOpen ? 'What did the check find? (staff only)' : 'What should compliance check? (staff only)'}</span><textarea className="admin-input" rows={2} value={escalationText} onChange={e => { setEscalationText(e.target.value); setErrors(({ escalation: _, resolution: __, ...rest }) => rest); }} aria-invalid={!!(errors.escalation ?? errors.resolution)} data-testid="textarea-admin-escalation" /><small className={errors.escalation ?? errors.resolution ? 'admin-field-error' : ''}>{errors.escalation ?? errors.resolution ?? `At least ${MIN_MESSAGE_LENGTH} characters.`}</small></label>
        <div className="admin-review-buttons"><button type="button" className={`admin-btn ${escalationOpen ? 'primary' : 'danger'}`} onClick={submitEscalation} disabled={busy} data-testid="button-admin-escalation">{escalationOpen ? 'Clear escalation' : 'Escalate to security'}</button></div></>}
      {escalationOpen && !canClear && <RoleNotice permission="applications.clearEscalation" />}
    </section>

    <section className="admin-review-section"><h3>History</h3><ol className="admin-review-history">{[...app.history].reverse().map(h => <li key={`${h.at}-${h.status}`}><strong>{h.status}</strong><span>{when(h.at)} · {h.actor === 'Reviewer' ? 'Grant team' : 'Applicant'}</span><p>{h.note}</p></li>)}</ol></section>

    <section className="admin-review-section"><h3>Internal notes</h3><p className="admin-review-hint">Staff only. Never shown to the applicant.</p>
      {app.internalNotes.length ? <ul className="admin-review-notes">{app.internalNotes.map((n, i) => <li key={`${n.at}-${i}`}><span>{n.author} · {when(n.at)}</span><p>{n.text}</p></li>)}</ul> : null}
      <label className="admin-review-field"><span className="sr-only">New internal note</span><textarea className="admin-input" rows={3} maxLength={MAX_NOTE_LENGTH} value={note} onChange={e => { setNote(e.target.value); setErrors(({ note: _, ...rest }) => rest); }} placeholder="Add context for other reviewers…" aria-invalid={!!errors.note} data-testid="textarea-admin-note" />{errors.note && <small className="admin-field-error">{errors.note}</small>}</label>
      <button type="button" className="admin-btn" disabled={!can('notes.add') || busy} onClick={() => void act(() => command('notes.add', { action: 'Add internal note', target: app.id }, (s, actor) => addInternalNote(s, app.id, note, actor.name, now())), () => api.addInternalNote(app.id, { text: note }), () => setNote(''))} data-testid="button-admin-add-note">Add note</button>
    </section>

    <div className="admin-detail-note"><Info size={17} /><span>{connected
      ? 'Decisions are saved on the server, role-checked there, and shown to the applicant. Approved awards are credited to the applicant\'s grant balance and the plan\'s commission is taken from their deposit balance. The applicant is notified in the app and by email.'
      : 'Preview review workflow. Decisions are saved in this browser only and update the applicant preview here. Actions are checked against the acting staff member\'s role and audited, but there is no real staff sign-in yet, so never use this with real applicant data.'}</span></div>
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
