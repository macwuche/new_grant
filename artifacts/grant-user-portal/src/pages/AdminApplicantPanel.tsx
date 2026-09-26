import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { differenceInDays, format } from 'date-fns';
import * as api from '@workspace/api-client-react';
import type { DemoState, Result, StaffMember, Tier } from '@workspace/domain/model';
import { findApplicant } from '@workspace/domain/applicants';
import {
  approveKyc, lockAccount, MIN_REASON_LENGTH, rejectKyc, requestReverification, requireCredentialReset, setApplicantTier, unlockAccount,
} from '@workspace/domain/accounts';
import { computeBalances, findGrant } from '@workspace/domain/rules';
import { assessRisk, RISK_HIGH, RISK_MEDIUM } from '@workspace/domain/risk';
import { adoptServerApplicant } from '@workspace/domain/sync';
import { apiError, toServerApplicant, useServerData } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import { ReviewFrame } from './AdminReviewPanel';
import { RiskBadge } from './AdminRisk';
import { RoleNotice, useCan, useStaffCommand } from './AdminStaff';

const usd = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string) => format(new Date(iso), 'dd MMM yyyy, HH:mm');
const day = (iso: string) => format(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso), 'dd MMM yyyy');
const kycTone = { Verified: 'verified', Pending: 'submitted', Rejected: 'declined', 'Not submitted': 'draft' } as const;

type Action = 'tier' | 'lock' | 'kyc-reject' | 'reverify';
type Outcome = { ok: true; message: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };
/** One account action: the permission and audit label, the browser rule, and the API call used when signed in. */
type Act = { permission: Parameters<ReturnType<typeof useStaffCommand>>[0]; action: string; local: (s: DemoState, actor: StaffMember) => Result; remote: () => Promise<api.ApplicantResult> };

/** Staff view of one applicant: profile, money, risk, identity check, and account controls. */
export function AdminApplicantPanel({ applicantId, onClose }: { applicantId: string; onClose: () => void }) {
  const { state, run } = useDemoStore();
  const { connected, refreshApplicants } = useServerData();
  const [busy, setBusy] = useState(false);
  const command = useStaffCommand();
  const can = useCan();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [tier, setTier] = useState<Tier | null>(null);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const person = findApplicant(state, applicantId);
  if (!person) return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow={applicantId}><h2 id="admin-detail-title">Applicant not found</h2></ReviewFrame>;

  const now = new Date();
  const risk = assessRisk(state, applicantId, now);
  const balances = computeBalances(state.transactions.filter(t => t.applicantId === applicantId));
  const apps = state.applications.filter(a => a.applicantId === applicantId && a.status !== 'Draft');
  const awarded = apps.filter(a => a.status === 'Approved').reduce((sum, a) => sum + (a.awardedAmount ?? 0), 0);
  const { account } = person;
  const kyc = account.kyc;

  const after = (result: Outcome) => {
    if (!result.ok) { setError(result.fieldErrors?.reason ?? null); setFlash({ tone: 'error', text: result.error }); return; }
    setError(null); setReason(''); setPending(null); setTier(null); setFlash({ tone: 'ok', text: result.message });
  };
  const start = (action: Action) => { setPending(action); setReason(''); setError(null); setFlash(null); };
  const needsReason = () => {
    if (reason.trim().length >= MIN_REASON_LENGTH) return false;
    setError(`Write at least ${MIN_REASON_LENGTH} characters.`);
    return true;
  };
  // Without sign-in the rule runs on this browser's store (role-checked and audited there);
  // signed in, the API runs it and the store takes the saved applicant.
  const perform = async (act: Act) => {
    if (!connected) { after(command(act.permission, { action: act.action, target: applicantId }, act.local)); return; }
    setBusy(true);
    try {
      const res = await act.remote();
      run(s => adoptServerApplicant(s, toServerApplicant(res.applicant)));
      after({ ok: true, message: res.message });
    } catch (err) {
      const failure = apiError(err, "Couldn't reach the server. Nothing was changed; try again.");
      if (failure.status === 409 || failure.status === 404) void refreshApplicants();
      after({ ok: false, error: failure.error, fieldErrors: failure.fieldErrors });
    } finally { setBusy(false); }
  };
  const id = applicantId;
  const acts = {
    approve: { permission: 'kyc.review', action: 'Approve identity check', local: (s, actor) => approveKyc(s, id, actor.name, new Date()), remote: () => api.approveIdentityCheck(id) },
    unlock: { permission: 'accounts.manage', action: 'Unlock account', local: s => unlockAccount(s, id, new Date()), remote: () => api.unlockApplicant(id) },
    resetPassword: { permission: 'accounts.manage', action: 'Force password reset', local: s => requireCredentialReset(s, id, 'password', new Date()), remote: () => api.requireCredentialReset(id, { kind: 'password' }) },
    resetTwoFactor: { permission: 'accounts.manage', action: 'Reset two-step sign-in', local: s => requireCredentialReset(s, id, 'twoFactor', new Date()), remote: () => api.requireCredentialReset(id, { kind: 'twoFactor' }) },
  } satisfies Record<string, Act>;
  const withReason = (action: Action): Act | null => {
    const text = reason;
    if (action === 'tier' && tier) return { permission: 'accounts.tier', action: 'Change account tier', local: s => setApplicantTier(s, id, tier, text, new Date()), remote: () => api.setApplicantTier(id, { tier, reason: text }) };
    if (action === 'lock') return { permission: 'accounts.manage', action: 'Lock account', local: (s, actor) => lockAccount(s, id, text, actor.name, new Date()), remote: () => api.lockApplicant(id, { reason: text }) };
    if (action === 'kyc-reject') return { permission: 'kyc.review', action: 'Reject identity check', local: (s, actor) => rejectKyc(s, id, text, actor.name, new Date()), remote: () => api.rejectIdentityCheck(id, { reason: text }) };
    if (action === 'reverify') return { permission: 'kyc.review', action: 'Request re-verification', local: (s, actor) => requestReverification(s, id, text, actor.name, new Date()), remote: () => api.requestReverification(id, { reason: text }) };
    return null;
  };
  const submit = () => {
    if (!pending || needsReason()) return;
    const act = withReason(pending);
    if (act) void perform(act);
  };
  const pendingLabel: Record<Action, string> = {
    tier: `Reason for moving to Tier ${tier ?? ''} (sent to applicant)`, lock: 'Why is the account being locked? (sent to applicant)',
    'kyc-reject': 'Why is the identity check rejected? (sent to applicant)', reverify: 'Why must they verify again? (sent to applicant)',
  };
  const pendingButton: Record<Action, string> = { tier: 'Confirm tier change', lock: 'Confirm lock', 'kyc-reject': 'Confirm rejection', reverify: 'Ask to verify again' };

  return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow={`${person.id} / Applicant`}>
    <div className="admin-review-title"><h2 id="admin-detail-title" data-testid="text-admin-detail-title">{person.name}</h2><span className="admin-review-badges">{account.status === 'Locked' && <span className="admin-badge declined" data-testid="status-admin-account-locked">Locked</span>}<RiskBadge risk={risk} /></span></div>
    <p className="admin-detail-lead">{person.email} · {person.sector} · {person.country}{person.current ? ' · applicant-portal demo user' : ''}</p>
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-applicant-flash">{flash.text}</div>}

    <dl className="admin-detail-fields">
      <Field label="Account tier" value={`Tier ${person.tier}`} />
      <Field label="Account age" value={`${differenceInDays(now, new Date(`${person.joined}T00:00:00`))} days (joined ${day(person.joined)})`} />
      <Field label="Grant balance" value={usd(balances.grant)} />
      <Field label="Deposit balance" value={`${usd(balances.deposit)}${balances.pendingDeposits ? ` (+${usd(balances.pendingDeposits)} pending)` : ''}`} />
      <Field label="Active grants" value={`${apps.filter(a => a.status === 'Approved').length} approved · ${usd(awarded)} awarded`} />
      <Field label="Applications" value={apps.length ? apps.map(a => `${a.id} ${findGrant(state, a.grantId)?.name ?? ''} (${a.status.toLowerCase()})`).join(', ') : 'None submitted'} />
    </dl>

    <section className="admin-review-section"><h3>Fraud risk</h3>
      {risk.factors.length ? <ul className="admin-risk-list" data-testid="list-admin-risk-factors">{risk.factors.map(f => <li key={f.label}><span>{f.label}</span><strong>+{f.points}</strong></li>)}<li className="total"><span>Score (max 100)</span><strong>{risk.score}</strong></li></ul> : <p className="admin-review-hint">No risk signals.</p>}
      <p className="admin-review-hint">{connected ? 'Sign-in location and device signals aren\'t collected yet.' : 'Sign-in location and device signals are fictional demo values.'} Medium from {RISK_MEDIUM}, high from {RISK_HIGH}.</p>
    </section>

    <section className="admin-review-section admin-review-actions" aria-label="Identity verification"><h3>Identity check</h3>
      <div className="admin-detail-fields" style={{ marginBottom: 10 }}>
        <Field label="Status" value={<span className={`admin-badge ${kycTone[kyc.status]}`} data-testid="status-admin-kyc">{kyc.status}</span>} />
        {kyc.documentType && <Field label="Document" value={`${kyc.documentType} ending ${kyc.documentLast4}`} />}
        {kyc.nameOnDocument && <Field label="Name on document" value={kyc.nameOnDocument} />}
        {kyc.submittedAt && <Field label="Submitted" value={when(kyc.submittedAt)} />}
        {kyc.reviewedBy && <Field label="Last reviewed" value={`${kyc.reviewedBy} · ${when(kyc.reviewedAt!)}`} />}
        {kyc.rejectionReason && <Field label="Reason given" value={kyc.rejectionReason} />}
      </div>
      <RoleNotice permission="kyc.review" />
      {can('kyc.review') && <div className="admin-review-buttons">
        {kyc.status === 'Pending' && <><button type="button" className="admin-btn" onClick={() => start('kyc-reject')} data-testid="button-admin-kyc-reject">Reject</button><button type="button" className="admin-btn primary" disabled={busy} onClick={() => void perform(acts.approve)} data-testid="button-admin-kyc-approve">Approve identity</button></>}
        {kyc.status === 'Verified' && <button type="button" className="admin-btn" onClick={() => start('reverify')} data-testid="button-admin-kyc-reverify">Ask to verify again</button>}
      </div>}
      <p className="admin-review-hint">No documents are uploaded yet; staff see only the details the applicant entered.</p>
    </section>

    <section className="admin-review-section admin-review-actions" aria-label="Account controls"><h3>Account controls</h3>
      <div className="admin-form-row">
        <label className="admin-review-field"><span>Account tier</span><select className="admin-input" value={tier ?? person.tier} disabled={!can('accounts.tier')} onChange={e => { const next = Number(e.target.value) as Tier; setTier(next === person.tier ? null : next); if (next !== person.tier) start('tier'); else setPending(null); }} data-testid="select-admin-applicant-tier"><option value={1}>Tier 1 · Basic</option><option value={2}>Tier 2 · Verified</option><option value={3}>Tier 3 · Enterprise</option></select></label>
        <div className="admin-review-field"><span>Access</span>{account.status === 'Locked'
          ? <button type="button" className="admin-btn primary" disabled={!can('accounts.manage') || busy} onClick={() => void perform(acts.unlock)} data-testid="button-admin-unlock">Unlock account</button>
          : <button type="button" className="admin-btn danger" disabled={!can('accounts.manage')} onClick={() => start('lock')} data-testid="button-admin-lock">Lock account</button>}</div>
      </div>
      {account.status === 'Locked' && <p className="admin-review-hint">Locked by {account.lockedBy} · {when(account.lockedAt!)}: {account.lockReason}</p>}
      <div className="admin-review-buttons" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="admin-btn" disabled={!can('accounts.manage') || account.passwordResetRequired || busy} onClick={() => void perform(acts.resetPassword)} data-testid="button-admin-force-password">{account.passwordResetRequired ? 'Password reset pending' : 'Force password reset'}</button>
        <button type="button" className="admin-btn" disabled={!can('accounts.manage') || account.twoFactorResetRequired || busy} onClick={() => void perform(acts.resetTwoFactor)} data-testid="button-admin-force-2fa">{account.twoFactorResetRequired ? '2FA reset pending' : 'Reset two-step sign-in'}</button>
      </div>
      <RoleNotice permission="accounts.manage" />
    </section>

    {pending && <section className="admin-review-section" aria-label="Confirm action">
      <label className="admin-review-field"><span>{pendingLabel[pending]}</span><textarea className="admin-input" rows={3} value={reason} onChange={e => { setReason(e.target.value); setError(null); }} aria-invalid={!!error} data-testid="textarea-admin-applicant-reason" /><small className={error ? 'admin-field-error' : ''}>{error ?? `At least ${MIN_REASON_LENGTH} characters.`}</small></label>
      <div className="admin-review-buttons"><button type="button" className="admin-btn" onClick={() => { setPending(null); setTier(null); setError(null); }} data-testid="button-admin-applicant-cancel">Cancel</button><button type="button" className={`admin-btn ${pending === 'tier' ? 'primary' : 'danger'}`} onClick={submit} disabled={busy} data-testid="button-admin-applicant-confirm">{pendingButton[pending]}</button></div>
    </section>}

    <div className="admin-detail-note"><Info size={17} /><span>{connected
      ? 'Account changes are saved on the server and role-checked there. Password and two-step resets are recorded for the applicant to complete, not enforced at sign-in. Balances and applications shown here are still this browser\'s demo records.'
      : 'Fictional applicant. Account changes are saved in this browser, role-checked, and audited. Sign-in isn\'t connected, so password and two-step resets are recorded, not enforced.'}</span></div>
  </ReviewFrame>;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="admin-detail-field"><dt>{label}</dt><dd>{value}</dd></div>;
}
