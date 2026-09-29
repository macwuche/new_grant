import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { format } from 'date-fns';
import {
  ArrowLeft, BadgeCheck, CreditCard, Download, ExternalLink, FileText, Image as ImageIcon, KeyRound, Lock, LockOpen, Minus,
  Plus, RotateCw, Search, ShieldCheck, Smartphone, SlidersHorizontal, Wallet, X,
} from 'lucide-react';
import * as api from '@workspace/api-client-react';
import { AdjustBalanceBody } from '@workspace/api-zod';
import { PERMISSION_SWITCHES, setAccountPermission } from '@workspace/domain/accounts';
import { ADJUSTMENT_CATEGORIES, staffAdjustBalance, validateAdjustment, type AdjustmentInput, type AdjustmentTarget } from '@workspace/domain/adjustments';
import { findApplicant, permissionsOf } from '@workspace/domain/applicants';
import { auditToCsv } from '@workspace/domain/audit';
import type { CardHolder } from '@workspace/domain/cards';
import { DEPOSIT_METHODS } from '@workspace/domain/deposits';
import type { AccountPermissions, AdjustmentCategory, AuditEvent, Tier, Transaction } from '@workspace/domain/model';
import { assessRisk } from '@workspace/domain/risk';
import { findGrant, computeBalances } from '@workspace/domain/rules';
import { CURRENT_APPLICANT_ID } from '@workspace/domain/seed';
import { ROLE_LABELS } from '@workspace/domain/staff';
import { adoptServerApplicant } from '@workspace/domain/sync';
import { apiError, toServerApplicant, useServerData } from '@/lib/serverData';
import { fileSize, openDocument, useStaffDocuments, type DocumentRecord } from '@/lib/documents';
import { downloadText } from '@/lib/download';
import { useDemoStore } from '@/lib/store';
import { reasonAct, simpleActs, useAccountAction, type Outcome } from './AdminApplicantPanel';
import { ReasonDialog, TIER_LABELS } from './AdminAccountDialogs';
import { initials, KYC_TEXT, KYC_TONE } from './AdminApplicants';
import { CardManager, CardSettingsEditor, cardSettingsFor, useCardHolder, type CardMode } from './AdminCards';
import { AdminModal } from './AdminModal';
import { RoleNotice, useCan, useStaffCommand } from './AdminStaff';
import './AdminApplicantProfile.css';

// The admin user profile (/admin/applicants/<id>): one continuous page with
// (1) the overview header and quick actions, (2) personal details and the
// identity documents with an inspector, (3) balances with the adjustment form,
// (4) the cards, (5) the account's permission switches and card rules, (6) the
// full ledger, and (7) the audit trail for this applicant. Signed in, every
// change goes through the API (role-checked, audited, 409 on stale records) and
// staff data refreshes every 30 seconds and on focus.

const usd = (value: number) => `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string) => format(new Date(iso), 'dd MMM yyyy, HH:mm');
const day = (iso: string) => format(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso), 'dd MMM yyyy');
type Flash = { tone: 'ok' | 'error'; text: string } | null;
const toFlash = (o: Outcome): Flash => o.ok ? { tone: 'ok', text: o.message } : { tone: 'error', text: o.error };

const SECTIONS = [
  ['overview', 'Overview'], ['identity', 'Identity'], ['balances', 'Balances'], ['cards', 'Cards'], ['controls', 'Controls'], ['transactions', 'Transactions'], ['audit', 'Audit trail'],
] as const;

export function AdminApplicantProfile({ applicantId }: { applicantId: string }) {
  const { state } = useDemoStore();
  const { connected, applicantsError } = useServerData();
  const card = useCardHolder(applicantId);
  const person = findApplicant(state, applicantId);
  const [cardMode, setCardMode] = useState<CardMode | null>(null);
  const [ledgerGroup, setLedgerGroup] = useState<Group>('all');
  const [adjusting, setAdjusting] = useState<AdjustmentTarget | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const back = <Link href="/admin/applicants" className="aup-back" data-testid="link-admin-back-to-applicants"><ArrowLeft size={15} /> All applicants</Link>;

  if (!person) return <>{back}<section className="aup-card"><div className="aup-empty" data-testid="empty-admin-applicant-profile"><Search size={25} /><h3>{connected && !applicantsError ? 'Loading applicant…' : 'Applicant not found'}</h3><p>{applicantsError ?? 'They may have been removed, or the link is wrong.'}</p></div></section></>;

  const ledger = state.transactions.filter(t => t.applicantId === applicantId);
  const jump = (id: string) => document.getElementById(`aup-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const openCard = (mode: CardMode) => { setCardMode(mode); jump('card-actions'); };
  const showCardTransactions = () => { setLedgerGroup('card'); jump('transactions'); };

  return <div className="aup" data-testid="page-admin-applicant-profile">
    {back}
    <Overview applicantId={applicantId} onFlash={setFlash} />
    <nav className="aup-jump" aria-label="Profile sections">{SECTIONS.map(([id, label]) => <a key={id} href={`#aup-${id}`} onClick={e => { e.preventDefault(); jump(id); }}>{label}</a>)}</nav>
    {flash && <div className={`aup-flash ${flash.tone}`} role="status" data-testid="status-admin-profile-flash">{flash.text}<button type="button" onClick={() => setFlash(null)} aria-label="Dismiss"><X size={14} /></button></div>}

    <div className="aup-grid two" id="aup-identity">
      <PersonalInfo applicantId={applicantId} />
      <IdentityDocuments applicantId={applicantId} onFlash={setFlash} />
    </div>

    <Balances ledger={ledger} applicantId={applicantId} onAdjust={setAdjusting} />

    <section className="aup-card" id="aup-cards" aria-labelledby="aup-cards-title">
      <SectionTitle id="aup-cards-title" icon={<CreditCard size={17} />} title="Cards" text="Both cards spend from one shared card balance. The virtual card comes first; a physical card needs it. Cards are fictional: no issuer or network is connected." />
      {card.holder ? <>
        <CardRoster holder={card.holder} onAdjust={() => setAdjusting('card')} onMode={openCard} onTransactions={showCardTransactions} />
        <div id="aup-card-actions" className="aup-subsection"><h3>All card actions</h3><CardManager holder={card.holder} onHolder={card.replace} mode={cardMode} onMode={setCardMode} hideFacts /></div>
      </> : card.demoOnly ? <p className="aup-hint" data-testid="text-admin-profile-cards-demo">In preview mode only the applicant-portal user ({state.profile.name}) has cards.</p>
        : card.loadError ? <p className="aup-error">{card.loadError}</p> : <p className="aup-hint">Loading cards…</p>}
    </section>

    <div className="aup-grid two" id="aup-controls">
      <PermissionSwitches applicantId={applicantId} onFlash={setFlash} />
      <section className="aup-card" aria-labelledby="aup-card-rules-title">
        <SectionTitle id="aup-card-rules-title" icon={<SlidersHorizontal size={17} />} title="Card rules" text="Which balances the applicant may fund their card from, and whether creating cards needs a verified identity." />
        <CardSettingsEditor applicantId={applicantId} settings={cardSettingsFor(state, applicantId, card.holder)} onSaved={() => void card.reload()} />
      </section>
    </div>

    <Ledger ledger={ledger} group={ledgerGroup} onGroup={setLedgerGroup} />
    <AuditTrail applicantId={applicantId} name={person.name} />

    {adjusting && <AdjustBalanceDialog applicantId={applicantId} name={person.name} holder={card.holder} ledger={ledger} target={adjusting}
      onHolder={card.replace} onClose={() => setAdjusting(null)} onDone={outcome => { setAdjusting(null); setFlash(toFlash(outcome)); }} />}
  </div>;
}

function SectionTitle({ id, icon, title, text, action }: { id: string; icon: React.ReactNode; title: string; text?: string; action?: React.ReactNode }) {
  return <header className="aup-section-head"><div><h2 id={id}><span className="aup-section-icon" aria-hidden="true">{icon}</span>{title}</h2>{text && <p>{text}</p>}</div>{action}</header>;
}

// ---------- 1. Overview header and quick actions ----------

function Overview({ applicantId, onFlash }: { applicantId: string; onFlash: (f: Flash) => void }) {
  const { state } = useDemoStore();
  const can = useCan();
  const { busy, perform } = useAccountAction();
  const [dialog, setDialog] = useState<{ action: 'tier' | 'lock'; tier?: Tier } | null>(null);
  const person = findApplicant(state, applicantId)!;
  const { account } = person;
  const locked = account.status === 'Locked';
  const risk = assessRisk(state, applicantId, new Date());
  const acts = simpleActs(applicantId);
  const run = async (act: typeof acts[keyof typeof acts]) => onFlash(toFlash(await perform(act, applicantId)));
  const auditRows = state.audit.filter(e => e.applicantId === applicantId);
  const exportAudit = () => downloadText(`audit-${applicantId}-${format(new Date(), 'yyyyMMdd-HHmm')}.csv`, auditToCsv([...auditRows].reverse()), 'text/csv');

  return <section className="aup-hero" id="aup-overview" aria-label="Applicant overview">
    <div className="aup-hero-main">
      <span className="aup-hero-avatar" aria-hidden="true">{initials(person.name)}</span>
      <div className="aup-hero-id">
        <div className="aup-hero-name"><h1 data-testid="text-admin-detail-title">{person.name}</h1>
          <span className={`aup-pill ${locked ? 'bad' : 'good'}`} data-testid="status-admin-account">{locked ? 'Locked' : 'Active'}</span>
          <span className={`aup-pill ${KYC_TONE[account.kyc.status]}`}>Identity: {KYC_TEXT[account.kyc.status]}</span>
          <span className={`aup-pill ${risk.level === 'High' ? 'bad' : risk.level === 'Medium' ? 'warn' : 'neutral'}`} title={risk.factors.map(f => `${f.label} (+${f.points})`).join('\n') || 'No risk signals'}>Risk {risk.level} · {risk.score}</span>
        </div>
        <dl className="aup-hero-meta">
          <div><dt>Email</dt><dd>{person.email}</dd></div>
          <div><dt>Phone</dt><dd>{person.phone || '—'}</dd></div>
          <div><dt>Account ID</dt><dd className="mono" title={person.id}>{person.id.length > 14 ? `${person.id.slice(0, 8)}…${person.id.slice(-4)}` : person.id}</dd></div>
          <div><dt>Registered</dt><dd>{day(person.joined)}</dd></div>
        </dl>
        {locked && <p className="aup-hero-note"><Lock size={13} /> Locked by {account.lockedBy ?? 'staff'}{account.lockedAt ? ` · ${when(account.lockedAt)}` : ''}: {account.lockReason}</p>}
        {(account.passwordResetRequired || account.twoFactorResetRequired) && <p className="aup-hero-note"><KeyRound size={13} /> Waiting for the applicant to complete: {[account.passwordResetRequired && 'password reset', account.twoFactorResetRequired && 'two-step sign-in reset'].filter(Boolean).join(' and ')}.</p>}
      </div>
    </div>
    <div className="aup-hero-side">
      <label className="aup-tier"><span>Account tier</span>
        <select value={person.tier} disabled={!can('accounts.tier')} onChange={e => { const next = Number(e.target.value) as Tier; if (next !== person.tier) setDialog({ action: 'tier', tier: next }); }} data-testid="select-admin-applicant-tier">
          {([1, 2, 3] as Tier[]).map(t => <option key={t} value={t}>{TIER_LABELS[t]}</option>)}
        </select>
        <small>{person.tier === 1 ? 'Limited grant eligibility and card limits.' : person.tier === 2 ? 'Most programs and higher card limits.' : 'Every program and the highest card limits.'}</small>
      </label>
      <div className="aup-quick">
        {locked
          ? <button type="button" className="aup-btn lime" disabled={!can('accounts.manage') || busy} onClick={() => void run(acts.unlock)} data-testid="button-admin-unlock"><LockOpen size={15} /> Unlock account</button>
          : <button type="button" className="aup-btn danger-solid" disabled={!can('accounts.manage')} onClick={() => setDialog({ action: 'lock' })} data-testid="button-admin-lock"><Lock size={15} /> Lock account</button>}
        <button type="button" className="aup-btn ghost-dark" disabled={!can('accounts.manage') || account.passwordResetRequired || busy} onClick={() => void run(acts.resetPassword)} data-testid="button-admin-force-password"><KeyRound size={15} /> {account.passwordResetRequired ? 'Password reset pending' : 'Force password reset'}</button>
        <button type="button" className="aup-btn ghost-dark" disabled={!can('accounts.manage') || account.twoFactorResetRequired || busy} onClick={() => void run(acts.resetTwoFactor)} data-testid="button-admin-force-2fa"><Smartphone size={15} /> {account.twoFactorResetRequired ? 'Two-step reset pending' : 'Reset two-step sign-in'}</button>
        <button type="button" className="aup-btn ghost-dark" disabled={!can('audit.view') || !auditRows.length} title={!can('audit.view') ? 'Needs permission to view the audit log' : undefined} onClick={exportAudit} data-testid="button-admin-export-user-audit"><Download size={15} /> Export audit log</button>
      </div>
    </div>
    {dialog && <ReasonDialog applicantId={applicantId} name={person.name} action={dialog.action} tier={dialog.tier ?? null} onClose={() => setDialog(null)} onDone={o => { setDialog(null); onFlash(toFlash(o)); }} />}
  </section>;
}

// ---------- 2. Personal information and identity documents ----------

function PersonalInfo({ applicantId }: { applicantId: string }) {
  const { state } = useDemoStore();
  const person = findApplicant(state, applicantId)!;
  const apps = state.applications.filter(a => a.applicantId === applicantId && a.status !== 'Draft');
  const fields: [string, React.ReactNode][] = [
    ['Full name', person.name], ['Email address', person.email], ['Phone number', person.phone || '—'],
    ['Date of birth', person.birthDate ? day(person.birthDate) : 'Not given'], ['Residential address', person.address || 'Not given'],
    ['Country', person.country || '—'], ['Sector', person.sector || '—'],
    ['Applications', apps.length ? apps.map(a => `${a.id} · ${findGrant(state, a.grantId)?.name ?? 'Program'} (${a.status.toLowerCase()})`).join('\n') : 'None submitted'],
  ];
  return <section className="aup-card" aria-labelledby="aup-personal-title">
    <SectionTitle id="aup-personal-title" icon={<BadgeCheck size={17} />} title="Personal information" text="Given at sign-up; the applicant edits their phone and address in Settings. Tax IDs aren't collected." />
    <dl className="aup-fields">{fields.map(([k, v]) => <div key={k} className={k === 'Residential address' || k === 'Applications' ? 'wide' : ''}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
  </section>;
}

function IdentityDocuments({ applicantId, onFlash }: { applicantId: string; onFlash: (f: Flash) => void }) {
  const { state } = useDemoStore();
  const { connected } = useServerData();
  const can = useCan();
  const { busy, perform } = useAccountAction();
  const docs = useStaffDocuments(connected && can('kyc.review'), { applicantId });
  const [inspecting, setInspecting] = useState<DocumentRecord | 'details' | null>(null);
  const [dialog, setDialog] = useState<'kyc-reject' | 'reverify' | null>(null);
  const person = findApplicant(state, applicantId)!;
  const kyc = person.account.kyc;
  const identity = docs.docs?.filter(d => d.purpose === 'identity') ?? [];
  const approve = async () => { const o = await perform(simpleActs(applicantId).approve, applicantId); onFlash(toFlash(o)); if (o.ok) setInspecting(null); };
  const decisions = can('kyc.review') && (kyc.status === 'Pending' || kyc.status === 'Verified');

  return <section className="aup-card" aria-labelledby="aup-kyc-title">
    <SectionTitle id="aup-kyc-title" icon={<ShieldCheck size={17} />} title="Identity check" text="Open a document to inspect it. Approving or rejecting decides the whole identity check." action={<span className={`aup-pill ${KYC_TONE[kyc.status]}`} data-testid="status-admin-kyc">{KYC_TEXT[kyc.status]}</span>} />
    <dl className="aup-fields compact">
      <div><dt>Document</dt><dd>{kyc.documentType ? `${kyc.documentType} ending ${kyc.documentLast4}` : '—'}</dd></div>
      <div><dt>Name on document</dt><dd>{kyc.nameOnDocument ?? '—'}</dd></div>
      <div><dt>Submitted</dt><dd>{kyc.submittedAt ? when(kyc.submittedAt) : '—'}</dd></div>
      <div><dt>Last reviewed</dt><dd>{kyc.reviewedBy ? `${kyc.reviewedBy} · ${when(kyc.reviewedAt!)}` : '—'}</dd></div>
      {kyc.rejectionReason && <div className="wide"><dt>Reason given</dt><dd>{kyc.rejectionReason}</dd></div>}
    </dl>

    <div className="aup-docs" data-testid="section-admin-identity-documents">
      {!connected ? (kyc.documentType
        ? <button type="button" className="aup-doc" onClick={() => setInspecting('details')} data-testid="button-admin-inspect-details"><span className="aup-doc-icon"><FileText size={20} /></span><strong>{kyc.documentType}</strong><small>Details entered · no uploads in preview mode</small></button>
        : <p className="aup-hint">Nothing submitted yet.</p>)
        : !can('kyc.review') ? <p className="aup-hint">Only staff who review identity checks can open identity documents.</p>
        : docs.error ? <p className="aup-error">{docs.error}</p>
        : docs.docs === null ? <p className="aup-hint">Loading documents…</p>
        : identity.length ? identity.map(d => <button key={d.id} type="button" className="aup-doc" onClick={() => setInspecting(d)} data-testid={`button-admin-inspect-document-${d.id}`}>
          <span className="aup-doc-icon">{d.contentType === 'application/pdf' ? <FileText size={20} /> : <ImageIcon size={20} />}</span>
          <strong title={d.fileName}>{d.fileName}</strong><small>{d.contentType === 'application/pdf' ? 'PDF' : d.contentType === 'image/png' ? 'PNG' : 'JPEG'} · {fileSize(d.sizeBytes)} · {day(d.uploadedAt)}</small>
        </button>) : <p className="aup-hint">No documents uploaded.</p>}
    </div>
    {connected && can('kyc.review') && <p className="aup-hint">Opening a document is recorded in the audit log, so previews load only when you open one.</p>}

    {decisions && <div className="aup-actions">
      {kyc.status === 'Pending' && <><button type="button" className="aup-btn" onClick={() => setDialog('kyc-reject')} data-testid="button-admin-kyc-reject">Reject</button><button type="button" className="aup-btn primary" disabled={busy} onClick={() => void approve()} data-testid="button-admin-kyc-approve">Approve identity</button></>}
      {kyc.status === 'Verified' && <button type="button" className="aup-btn" onClick={() => setDialog('reverify')} data-testid="button-admin-kyc-reverify">Ask to verify again</button>}
    </div>}
    <RoleNotice permission="kyc.review" />

    {inspecting && <DocumentInspector doc={inspecting === 'details' ? null : inspecting} applicantId={applicantId} busy={busy} onApprove={approve} onClose={() => setInspecting(null)} onRejected={o => { setInspecting(null); onFlash(toFlash(o)); }} />}
    {dialog && <ReasonDialog applicantId={applicantId} name={person.name} action={dialog} onClose={() => setDialog(null)} onDone={o => { setDialog(null); onFlash(toFlash(o)); }} />}
  </section>;
}

/** The document viewer: zoom and rotate images, show PDFs, with the identity-check details and the decision beside it. */
function DocumentInspector({ doc, applicantId, busy, onApprove, onClose, onRejected }: {
  doc: DocumentRecord | null; applicantId: string; busy: boolean; onApprove: () => Promise<void>; onClose: () => void; onRejected: (o: Outcome) => void;
}) {
  const { state } = useDemoStore();
  const can = useCan();
  const { busy: rejecting, perform } = useAccountAction();
  const person = findApplicant(state, applicantId)!;
  const kyc = person.account.kyc;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [turn, setTurn] = useState(0);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  useEffect(() => {
    if (!doc) return;
    let live = true; let made: string | null = null;
    api.getDocumentFile(doc.id)
      .then(blob => { if (!live) return; made = URL.createObjectURL(new Blob([blob], { type: doc.contentType })); setUrl(made); })
      .catch(err => { if (live) setError(apiError(err, "Couldn't load the document.").error); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [doc]);

  const reject = async () => {
    const act = reasonAct(applicantId, 'kyc-reject', reason);
    if (!act) return;
    const o = await perform(act, applicantId);
    if (!o.ok) { setReasonError(o.fieldErrors?.reason ?? o.error); return; }
    onRejected(o);
  };
  const image = doc && doc.contentType !== 'application/pdf';
  const decide = can('kyc.review') && kyc.status === 'Pending';

  return <AdminModal wide title={doc ? doc.fileName : `${kyc.documentType ?? 'Identity'} details`} subtitle={`${person.name} · identity check ${KYC_TEXT[kyc.status].toLowerCase()}`} onClose={onClose} testId="dialog-admin-document-inspector">
    <div className="aup-inspector">
      <div className="aup-viewer">
        {!doc ? <div className="aup-viewer-empty"><FileText size={30} /><p>No file in preview mode: only the details the applicant entered.</p></div>
          : error ? <div className="aup-viewer-empty"><p className="aup-error">{error}</p></div>
          : !url ? <div className="aup-viewer-empty"><p>Loading…</p></div>
          : image ? <div className="aup-viewer-stage"><img src={url} alt={`${doc.fileName}, uploaded by ${person.name}`} style={{ transform: `scale(${zoom}) rotate(${turn}deg)` }} /></div>
          : <iframe title={doc.fileName} src={url} className="aup-viewer-pdf" />}
        {doc && <div className="aup-viewer-tools">
          {image && <>
            <button type="button" className="aup-icon-btn" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Zoom out" data-testid="button-inspector-zoom-out"><Minus size={15} /></button>
            <span className="aup-zoom" aria-live="polite">{Math.round(zoom * 100)}%</span>
            <button type="button" className="aup-icon-btn" onClick={() => setZoom(z => Math.min(4, +(z + 0.25).toFixed(2)))} aria-label="Zoom in" data-testid="button-inspector-zoom-in"><Plus size={15} /></button>
            <button type="button" className="aup-icon-btn" onClick={() => setTurn(t => (t + 90) % 360)} aria-label="Rotate 90 degrees" data-testid="button-inspector-rotate"><RotateCw size={15} /></button>
            <button type="button" className="aup-btn sm" onClick={() => { setZoom(1); setTurn(0); }}>Reset</button>
          </>}
          <button type="button" className="aup-btn sm" onClick={() => void openDocument(doc).then(e => e && setError(e))}><ExternalLink size={13} /> Open in new tab</button>
        </div>}
      </div>
      <aside className="aup-inspector-side">
        <h3>Compare with the applicant's details</h3>
        <dl className="aup-fields compact single">
          <div><dt>Account name</dt><dd>{person.name}</dd></div>
          <div><dt>Name on document</dt><dd>{kyc.nameOnDocument ?? '—'}</dd></div>
          <div><dt>Document</dt><dd>{kyc.documentType ? `${kyc.documentType} ending ${kyc.documentLast4}` : '—'}</dd></div>
          <div><dt>Date of birth</dt><dd>{person.birthDate ? day(person.birthDate) : 'Not given'}</dd></div>
          <div><dt>Submitted</dt><dd>{kyc.submittedAt ? when(kyc.submittedAt) : '—'}</dd></div>
          {doc && <div><dt>File</dt><dd>{fileSize(doc.sizeBytes)} · uploaded {when(doc.uploadedAt)}</dd></div>}
        </dl>
        <p className="aup-hint">No automated checks are connected (no OCR match score or expiry reading): check the name, number, dates, and photo yourself.{doc ? ' The server checks the file against its fingerprint on every download, so a changed file would fail to load.' : ''}</p>
        {decide ? rejectOpen
          ? <div className="aup-reject">
            <label className="aup-field"><span>Rejection reason (sent to the applicant)</span><textarea rows={3} value={reason} onChange={e => { setReason(e.target.value); setReasonError(null); }} aria-invalid={!!reasonError} data-autofocus data-testid="textarea-inspector-reject-reason" /><small className={reasonError ? 'aup-error' : ''}>{reasonError ?? 'At least 10 characters.'}</small></label>
            <div className="aup-actions"><button type="button" className="aup-btn" onClick={() => setRejectOpen(false)}>Back</button><button type="button" className="aup-btn danger" disabled={rejecting} onClick={() => void reject()} data-testid="button-inspector-confirm-reject">Reject identity check</button></div>
          </div>
          : <div className="aup-actions stretch"><button type="button" className="aup-btn danger" onClick={() => setRejectOpen(true)} data-testid="button-inspector-reject">Reject document</button><button type="button" className="aup-btn primary" disabled={busy} onClick={() => void onApprove()} data-testid="button-inspector-approve">Approve document</button></div>
          : <p className="aup-hint">{kyc.status === 'Pending' ? 'Your role can look but not decide.' : `The identity check is ${KYC_TEXT[kyc.status].toLowerCase()}; there's nothing to decide.`}</p>}
      </aside>
    </div>
  </AdminModal>;
}

// ---------- 3. Balances and the adjustment form ----------

function Balances({ ledger, applicantId, onAdjust }: { ledger: Transaction[]; applicantId: string; onAdjust: (t: AdjustmentTarget) => void }) {
  const { state } = useDemoStore();
  const { connected } = useServerData();
  const can = useCan();
  const b = computeBalances(ledger);
  const counted = ledger.filter(t => t.status === 'Completed');
  const totalDeposits = counted.filter(t => t.type === 'Deposit').reduce((s, t) => s + t.amount, 0);
  const totalPaid = counted.filter(t => t.type === 'Withdrawal').reduce((s, t) => s - t.amount, 0);
  const awarded = state.applications.filter(a => a.applicantId === applicantId && a.status === 'Approved').reduce((s, a) => s + (a.awardedAmount ?? 0), 0);
  const demoBlocked = !connected && applicantId !== CURRENT_APPLICANT_ID;
  return <section className="aup-card" id="aup-balances" aria-labelledby="aup-balances-title">
    <SectionTitle id="aup-balances-title" icon={<Wallet size={17} />} title="Balances" text="Always worked out from the ledger below. Adjustments add a ledger entry with a category and a reason the applicant sees."
      action={<button type="button" className="aup-btn lime" disabled={!can('payments.process') || demoBlocked} title={demoBlocked ? 'In preview mode only the applicant-portal user has a ledger' : undefined} onClick={() => onAdjust('grant')} data-testid="button-admin-adjust-balance"><SlidersHorizontal size={15} /> Adjust balance</button>} />
    <div className="aup-balances">
      <div className="aup-balance dark"><span>Grant balance</span><strong data-testid="text-admin-balance-grant">{usd(b.grant)}</strong><small>{usd(awarded)} awarded · {usd(b.pendingWithdrawals)} in pending payouts</small></div>
      <div className="aup-balance"><span>Deposit balance</span><strong data-testid="text-admin-balance-deposit">{usd(b.deposit)}</strong><small>{b.pendingDeposits ? `+${usd(b.pendingDeposits)} waiting for confirmation` : 'Pays card and application fees'}</small></div>
      <div className="aup-balance"><span>Card balance</span><strong data-testid="text-admin-balance-card">{usd(b.card)}</strong><small>Shared by the virtual and physical card</small></div>
      <div className="aup-balance split"><div><span>Total deposits</span><strong>{usd(totalDeposits)}</strong></div><div><span>Total paid out</span><strong>{usd(totalPaid)}</strong></div></div>
    </div>
    <RoleNotice permission="payments.process" />
  </section>;
}

const TARGET_LABELS: Record<AdjustmentTarget, string> = { grant: 'Grant balance', deposit: 'Deposit balance', card: 'Card balance (both cards)' };

function AdjustBalanceDialog({ applicantId, name, holder, ledger, target: initial, onHolder, onClose, onDone }: {
  applicantId: string; name: string; holder: CardHolder | null; ledger: Transaction[]; target: AdjustmentTarget;
  onHolder: (h: CardHolder) => void; onClose: () => void; onDone: (o: Outcome) => void;
}) {
  const { connected, refreshMoney, refreshActivity } = useServerData();
  const command = useStaffCommand();
  const [input, setInput] = useState<Omit<AdjustmentInput, 'amount'> & { amount: string }>({ target: initial, direction: 'credit', amount: '', category: initial === 'card' ? 'Card fee refund' : 'Grant adjustment', reason: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const balances = computeBalances(ledger);
  const noCard = !holder?.cards.virtual;
  const amount = Number(input.amount);
  const current = balances[input.target];
  const next = input.direction === 'credit' ? current + (Number.isFinite(amount) ? amount : 0) : current - (Number.isFinite(amount) ? amount : 0);
  const set = <K extends keyof typeof input>(key: K, value: (typeof input)[K]) => { setInput(i => ({ ...i, [key]: value })); setConfirming(false); setFailure(null); setErrors(({ [key as string]: _, ...rest }) => rest); };

  const body = (): AdjustmentInput => ({ ...input, amount, reason: input.reason.trim() });
  const check = () => {
    const found = validateAdjustment(body());
    // The same Zod schema the API validates with.
    const parsed = AdjustBalanceBody.safeParse(body());
    if (!parsed.success && !Object.keys(found).length) found.amount = 'Check the amount and fields.';
    if (input.target === 'card' && noCard) found.target = 'Create a virtual card for this applicant first.';
    if (input.direction === 'debit' && Number.isFinite(amount) && amount > current && !found.amount) found.amount = `Up to ${usd(current)}.`;
    setErrors(found);
    return !Object.keys(found).length;
  };
  const submit = async () => {
    if (!check()) return;
    if (!confirming) { setConfirming(true); return; }
    setBusy(true);
    try {
      if (!connected) {
        const result = command('payments.process', { action: 'Adjust balance', target: applicantId }, (s, actor) => staffAdjustBalance(s, body(), actor.name, new Date()));
        if (!result.ok) { setErrors(result.fieldErrors ?? {}); setFailure(result.error); setConfirming(false); return; }
        onDone({ ok: true, message: result.message });
        return;
      }
      const res = await api.adjustBalance(applicantId, body());
      onHolder(res.holder as CardHolder);
      void refreshMoney(); void refreshActivity();
      onDone({ ok: true, message: res.message });
    } catch (err) {
      const f = apiError(err, "Couldn't reach the server. Nothing was changed; try again.");
      setErrors(f.fieldErrors ?? {}); setFailure(f.error); setConfirming(false);
    } finally { setBusy(false); }
  };
  const field = (key: string, label: string, node: React.ReactNode, hint?: string) => <label className="aup-field"><span>{label}</span>{node}<small className={errors[key] ? 'aup-error' : ''}>{errors[key] ?? hint ?? ''}</small></label>;

  return <AdminModal title="Adjust balance" subtitle={`${name} · credit or debit by hand`} onClose={onClose} testId="dialog-admin-adjust-balance"
    footer={<>{confirming ? <button type="button" className="aup-btn" onClick={() => setConfirming(false)}>Back</button> : <button type="button" className="aup-btn" onClick={onClose}>Cancel</button>}
      <button type="button" className={`aup-btn ${input.direction === 'debit' ? 'danger' : 'primary'}`} disabled={busy} onClick={() => void submit()} data-testid="button-admin-adjust-submit">
        {busy ? 'Saving…' : confirming ? `Confirm ${input.direction} of ${usd(amount)}` : 'Review adjustment'}</button></>}>
    {failure && <div className="aup-flash error" role="alert">{failure}</div>}
    {field('target', 'Target account', <select value={input.target} onChange={e => set('target', e.target.value as AdjustmentTarget)} data-autofocus data-testid="select-admin-adjust-target">
      {(Object.keys(TARGET_LABELS) as AdjustmentTarget[]).map(t => <option key={t} value={t} disabled={t === 'card' && noCard}>{TARGET_LABELS[t]}{t === 'card' && noCard ? ' — no card yet' : ''}</option>)}
    </select>, `Now ${usd(current)}.`)}
    <div className="aup-field"><span>Action type</span>
      <div className="aup-segment" role="radiogroup" aria-label="Credit or debit">
        {(['credit', 'debit'] as const).map(d => <button key={d} type="button" role="radio" aria-checked={input.direction === d} className={input.direction === d ? `active ${d}` : ''} onClick={() => set('direction', d)} data-testid={`radio-admin-adjust-${d}`}>{d === 'credit' ? <><Plus size={14} /> Credit</> : <><Minus size={14} /> Debit</>}</button>)}
      </div>
    </div>
    <div className="aup-form-row">
      {field('amount', 'Amount (USD)', <input type="number" inputMode="decimal" min="0.01" step="0.01" value={input.amount} onChange={e => set('amount', e.target.value)} aria-invalid={!!errors.amount} data-testid="input-admin-adjust-amount" />, input.direction === 'debit' ? `Up to ${usd(current)}.` : undefined)}
      {field('category', 'Transaction category', <select value={input.category} onChange={e => set('category', e.target.value as AdjustmentCategory)} data-testid="select-admin-adjust-category">{ADJUSTMENT_CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>)}
    </div>
    {field('reason', 'Reason / audit note (the applicant sees this)', <textarea rows={3} maxLength={1000} value={input.reason} onChange={e => set('reason', e.target.value)} aria-invalid={!!errors.reason} data-testid="textarea-admin-adjust-reason" />, 'At least 10 characters. Recorded in the ledger and the audit log.')}
    {confirming && <div className="aup-confirm" data-testid="text-admin-adjust-summary"><span>{TARGET_LABELS[input.target]}</span><strong>{usd(current)} → {usd(next)}</strong><small>{input.category} · the applicant is notified</small></div>}
    {input.category === 'Fraud freeze' && <p className="aup-hint">The category only labels the entry. To stop the account, also lock it or freeze its cards.</p>}
  </AdminModal>;
}

// ---------- 4. Cards ----------

function CardRoster({ holder, onAdjust, onMode, onTransactions }: { holder: CardHolder; onAdjust: () => void; onMode: (m: CardMode) => void; onTransactions: () => void }) {
  const can = useCan();
  const { virtual, physical } = holder.cards;
  const physicalLive = physical.status === 'Active' || physical.status === 'Shipped';
  const tile = (kind: 'Virtual' | 'Physical', lastFour: string | undefined, status: string, tone: string, meta: string, actions: React.ReactNode) =>
    <article className={`aup-atm ${kind.toLowerCase()} ${tone === 'frozen' ? 'frozen' : ''}`} data-testid={`card-admin-${kind.toLowerCase()}-card`}>
      <div className="aup-atm-face">
        <div className="aup-atm-top"><span>{kind} card</span><span className={`aup-pill ${tone === 'good' ? 'good' : tone === 'frozen' ? 'neutral' : tone === 'warn' ? 'warn' : 'bad'}`}>{status}</span></div>
        <span className="aup-atm-chip" aria-hidden="true" />
        <span className="aup-atm-number">•••• •••• •••• {lastFour ?? '····'}</span>
        <div className="aup-atm-bottom"><span>{holder.name}</span><span>Balance <strong>{usd(holder.balance)}</strong></span></div>
      </div>
      <p className="aup-atm-meta">{meta}</p>
      <div className="aup-atm-actions">{actions}</div>
    </article>;

  return <div className="aup-roster">
    {virtual ? tile('Virtual', virtual.lastFour, virtual.frozen ? (virtual.frozenBy === 'staff' ? 'Frozen by staff' : 'Frozen by applicant') : 'Active', virtual.frozen ? 'frozen' : 'good',
      `Limit $${virtual.dailyLimit.toLocaleString('en-US')}/day${virtual.createdAt ? ` · created ${day(virtual.createdAt)}` : ''}${virtual.createdBy ? ` by ${virtual.createdBy}` : ''}${virtual.frozenReason ? ` · note: "${virtual.frozenReason}"` : ''}`,
      <>
        <button type="button" className="aup-btn sm" disabled={!can('payments.process')} onClick={onAdjust} data-testid="button-admin-card-topup">Top up / adjust</button>
        <button type="button" className="aup-btn sm" disabled={!can('accounts.manage')} onClick={() => onMode('freeze-virtual')} data-testid="button-admin-card-freeze-virtual">{virtual.frozen && virtual.frozenBy === 'staff' ? 'Unfreeze' : 'Freeze'}</button>
        <button type="button" className="aup-btn sm" onClick={onTransactions}>Transactions</button>
      </>)
      : <article className="aup-atm empty"><p>No virtual card yet.</p><button type="button" className="aup-btn sm" disabled={!can('payments.process')} onClick={() => onMode('create-virtual')} data-testid="button-admin-card-create-virtual">Create virtual card</button></article>}
    {physical.status !== 'Not requested' ? tile('Physical', physical.lastFour, physical.status === 'Active' && physical.frozen ? 'Frozen' : physical.status === 'Requested' ? 'Pending issue' : physical.status,
      physical.status === 'Active' ? (physical.frozen ? 'frozen' : 'good') : physical.status === 'Requested' || physical.status === 'Shipped' ? 'warn' : 'bad',
      [physical.requestedAt && `${physical.issuedBy ? 'Issued' : 'Applied'} ${day(physical.requestedAt)}`, physical.shippedAt && `shipped ${day(physical.shippedAt)}`, physical.trackingRef && `tracking ${physical.trackingRef}`, physical.activatedAt && `activated ${day(physical.activatedAt)}`, physical.declineReason && `declined: ${physical.declineReason}`, physical.cancelReason && `cancelled: ${physical.cancelReason}`].filter(Boolean).join(' · ') || '—',
      <>
        {physical.status === 'Requested' && <button type="button" className="aup-btn sm primary" disabled={!can('payments.process')} onClick={() => onMode('approve')} data-testid="button-admin-card-review">Review application</button>}
        {physicalLive && <button type="button" className="aup-btn sm" disabled={!can('payments.process')} onClick={onAdjust}>Top up / adjust</button>}
        {physical.status === 'Active' && <button type="button" className="aup-btn sm" disabled={!can('accounts.manage')} onClick={() => onMode('freeze-physical')} data-testid="button-admin-card-freeze-physical">{physical.frozen && physical.frozenBy === 'staff' ? 'Unfreeze' : 'Freeze'}</button>}
        <button type="button" className="aup-btn sm" onClick={onTransactions}>Transactions</button>
      </>)
      : <article className="aup-atm empty"><p>No physical card.</p>{virtual && <button type="button" className="aup-btn sm" disabled={!can('payments.process')} onClick={() => onMode('issue')}>Issue physical card</button>}</article>}
  </div>;
}

// ---------- 5. Permission switches ----------

function PermissionSwitches({ applicantId, onFlash }: { applicantId: string; onFlash: (f: Flash) => void }) {
  const { state, run } = useDemoStore();
  const { connected, refreshApplicants } = useServerData();
  const command = useStaffCommand();
  const can = useCan();
  const [busy, setBusy] = useState<keyof AccountPermissions | null>(null);
  const perms = permissionsOf(state, applicantId);
  const flip = async (key: keyof AccountPermissions) => {
    const value = !perms[key];
    if (!connected) { onFlash(toFlash(command('accounts.manage', { action: 'Change account permission', target: applicantId }, s => setAccountPermission(s, applicantId, key, value, new Date())))); return; }
    setBusy(key);
    try {
      const res = await api.setAccountPermission(applicantId, { key, value });
      run(s => adoptServerApplicant(s, toServerApplicant(res.applicant)));
      onFlash({ tone: 'ok', text: res.message });
    } catch (err) {
      const f = apiError(err, "Couldn't reach the server. Nothing was changed; try again.");
      if (f.status === 409) void refreshApplicants();
      onFlash({ tone: 'error', text: f.error });
    } finally { setBusy(null); }
  };
  const describe: Record<keyof AccountPermissions, string> = {
    payoutKyc: 'On: payout requests need a verified identity.',
    depositKyc: 'On: adding funds needs a verified identity.',
    emailNotifications: 'Email copies of notifications. Security notices are always emailed. The applicant can change this in Settings too.',
    cardApplications: 'Off: the applicant can’t create a card or apply for a physical one. Staff can still issue cards.',
    grantApplications: 'Off: the applicant can’t submit new applications. Resubmitting requested changes still works.',
  };
  return <section className="aup-card" aria-labelledby="aup-switches-title" data-testid="section-admin-permission-switches">
    <SectionTitle id="aup-switches-title" icon={<SlidersHorizontal size={17} />} title="Feature toggles" text="Each change takes effect at once, is audited, and the applicant is told." />
    <ul className="aup-switches">{PERMISSION_SWITCHES.map(p => <li key={p.key}>
      <div><strong>{p.label}</strong><small>{describe[p.key]}</small></div>
      <button type="button" role="switch" aria-checked={perms[p.key]} aria-label={p.label} className="aup-switch" disabled={!can('accounts.manage') || busy !== null} onClick={() => void flip(p.key)} data-testid={`switch-admin-${p.key}`}>
        <span aria-hidden="true" /><em>{busy === p.key ? '…' : perms[p.key] ? 'On' : 'Off'}</em>
      </button>
    </li>)}</ul>
    <RoleNotice permission="accounts.manage" />
  </section>;
}

// ---------- 6. Transaction ledger ----------

type Group = 'all' | 'grant' | 'deposit' | 'withdrawal' | 'card' | 'fee' | 'adjustment';
const GROUPS: Record<Group, { label: string; match: (t: Transaction) => boolean }> = {
  all: { label: 'All types', match: () => true },
  grant: { label: 'Grant disbursed', match: t => t.type === 'Grant' },
  deposit: { label: 'Wallet deposit', match: t => t.type === 'Deposit' },
  withdrawal: { label: 'Withdrawal', match: t => t.type === 'Withdrawal' },
  card: { label: 'Card moves and charges', match: t => t.type === 'Card top-up' || t.type === 'Card deduction' || t.type === 'Card fee' },
  fee: { label: 'Application fee', match: t => t.type === 'Application fee' },
  adjustment: { label: 'Admin balance adjustment', match: t => !!t.category || t.type === 'Grant adjustment' || t.type === 'Deposit adjustment' },
};
const TYPE_TEXT: Partial<Record<Transaction['type'], string>> = { Grant: 'Grant disbursed', Deposit: 'Wallet deposit', 'Grant adjustment': 'Admin adjustment · grant', 'Deposit adjustment': 'Admin adjustment · deposit' };
const STATUS_TONE: Record<Transaction['status'], string> = { Completed: 'good', Pending: 'warn', Failed: 'bad', Cancelled: 'neutral' };

function channelOf(t: Transaction, channels: { id: string; name: string }[]): string {
  if (t.category) return t.category;
  if (t.type === 'Withdrawal') return t.destination ?? channels.find(c => c.id === t.method)?.name ?? t.method ?? '—';
  if (t.type === 'Deposit') return `${DEPOSIT_METHODS.find(m => m.id === t.method)?.name ?? t.method ?? '—'}${t.reference ? ` · ${t.reference}` : ''}`;
  if (t.type === 'Card top-up' || t.type === 'Card deduction') return t.counterpart === 'none' ? 'Grant team' : `${t.counterpart} balance`;
  if (t.type === 'Card fee' || t.type === 'Application fee') return 'Deposit balance';
  if (t.type === 'Grant') return 'Award';
  return '—';
}

function Ledger({ ledger, group, onGroup }: { ledger: Transaction[]; group: Group; onGroup: (g: Group) => void }) {
  const { state } = useDemoStore();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'' | Transaction['status']>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(20);
  const start = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
  const end = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
  const q = query.trim().toLowerCase();
  const rows = useMemo(() => [...ledger].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [ledger])
    .filter(t => GROUPS[group].match(t) && (!status || t.status === status))
    .filter(t => { const at = new Date(t.createdAt).getTime(); return at >= start && at <= end; })
    .filter(t => !q || `${t.id} ${t.description} ${t.reference ?? ''} ${t.note ?? ''} ${t.processedBy ?? ''}`.toLowerCase().includes(q));
  const clear = () => { setQuery(''); setStatus(''); setFrom(''); setTo(''); onGroup('all'); };

  return <section className="aup-card" id="aup-transactions" aria-labelledby="aup-ledger-title">
    <SectionTitle id="aup-ledger-title" icon={<FileText size={17} />} title="Transaction history" text={`${ledger.length} ledger entr${ledger.length === 1 ? 'y' : 'ies'}: awards, deposits, payouts, fees, card moves, and adjustments.`} />
    <div className="aup-ledger-tools">
      <label className="aup-search"><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search ID, description, reference, note" aria-label="Search transactions" data-testid="input-admin-ledger-search" /><Search size={16} /></label>
      <select className="aup-input" value={group} onChange={e => onGroup(e.target.value as Group)} aria-label="Transaction type" data-testid="select-admin-ledger-type">{(Object.keys(GROUPS) as Group[]).map(g => <option key={g} value={g}>{GROUPS[g].label}</option>)}</select>
      <select className="aup-input" value={status} onChange={e => setStatus(e.target.value as typeof status)} aria-label="Status" data-testid="select-admin-ledger-status"><option value="">All statuses</option>{(['Completed', 'Pending', 'Failed', 'Cancelled'] as const).map(s => <option key={s}>{s}</option>)}</select>
      <input className="aup-input" type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="From date" data-testid="input-admin-ledger-from" />
      <input className="aup-input" type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="To date" data-testid="input-admin-ledger-to" />
    </div>
    {rows.length ? <>
      <div className="aup-table-wrap"><table className="aup-table">
        <thead><tr><th>Date &amp; time</th><th>Transaction ID</th><th>Type</th><th className="num">Amount</th><th>Channel / method</th><th>Status</th></tr></thead>
        <tbody>{rows.slice(0, limit).map(t => <tr key={t.id} data-testid={`row-admin-profile-tx-${t.id}`}>
          <td className="aup-muted nowrap">{when(t.createdAt)}</td>
          <td className="mono">{t.id}</td>
          <td><strong>{TYPE_TEXT[t.type] ?? t.type}</strong><small className="aup-sub">{t.description}{t.note ? ` · "${t.note}"` : ''}{t.processedBy ? ` · ${t.processedBy}` : ''}</small></td>
          <td className={`num ${t.amount < 0 ? 'neg' : 'pos'}`}>{t.amount > 0 ? '+' : ''}{usd(t.amount)}{t.fee ? <small className="aup-sub">fee {usd(t.fee)}</small> : null}</td>
          <td className="aup-muted">{channelOf(t, state.treasury.channels)}</td>
          <td><span className={`aup-pill ${STATUS_TONE[t.status]}`}>{t.status}</span>{t.failureReason && <small className="aup-sub">{t.failureReason}</small>}</td>
        </tr>)}</tbody>
      </table></div>
      <div className="aup-table-foot"><span className="aup-count">Showing {Math.min(limit, rows.length)} of {rows.length}</span>{rows.length > limit && <button type="button" className="aup-btn sm" onClick={() => setLimit(l => l + 20)} data-testid="button-admin-ledger-more">Show 20 more</button>}</div>
    </> : <div className="aup-empty"><p>{ledger.length ? 'No transactions match these filters.' : 'No money activity yet.'}</p>{ledger.length > 0 && <button type="button" className="aup-btn sm" onClick={clear}>Clear filters</button>}</div>}
  </section>;
}

// ---------- 7. Audit trail ----------

function AuditTrail({ applicantId, name }: { applicantId: string; name: string }) {
  const { state } = useDemoStore();
  const { connected, auditChain } = useServerData();
  const can = useCan();
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(15);
  const rows: AuditEvent[] = [...state.audit].filter(e => e.applicantId === applicantId).reverse();
  const exportCsv = () => downloadText(`audit-${applicantId}-${format(new Date(), 'yyyyMMdd-HHmm')}.csv`, auditToCsv(rows), 'text/csv');

  return <section className="aup-card" id="aup-audit" aria-labelledby="aup-audit-title">
    <SectionTitle id="aup-audit-title" icon={<ShieldCheck size={17} />} title="Security audit trail" text={`Every staff action on ${name}'s account, newest first. ${connected ? 'Stored on the server and hash-chained; refreshed every 30 seconds.' : 'Preview: kept in this browser.'}`}
      action={can('audit.view') ? <button type="button" className="aup-btn" disabled={!rows.length} onClick={exportCsv} data-testid="button-admin-profile-audit-csv"><Download size={14} /> Export CSV</button> : undefined} />
    {!can('audit.view') ? <RoleNotice permission="audit.view" />
      : <>
        {auditChain && !auditChain.intact && <div className="aup-flash error" role="alert">The audit log failed its integrity check at {auditChain.brokenAt}. Treat these entries as unreliable.</div>}
        {rows.length ? <><div className="aup-table-wrap"><table className="aup-table">
          <thead><tr><th>Timestamp</th><th>Admin &amp; role</th><th>Action taken</th><th>Previous → new value</th><th>IP address</th></tr></thead>
          <tbody>{rows.slice(0, limit).map(e => <Fragment key={e.id}><tr data-testid={`row-admin-profile-audit-${e.id}`}>
            <td className="aup-muted nowrap">{format(new Date(e.at), 'dd MMM yyyy, HH:mm:ss')}</td>
            <td><strong>{e.staffName}</strong><small className="aup-sub">{ROLE_LABELS[e.role]}</small></td>
            <td><strong>{e.action}</strong><small className="aup-sub">{e.summary}</small></td>
            <td>{e.changes.length ? <ul className="aup-changes">{e.changes.slice(0, open === e.id ? undefined : 2).map(c => <li key={c.field}><code>{c.field}</code> {c.before} → <b>{c.after}</b></li>)}
              {e.changes.length > 2 && <li><button type="button" className="aup-link" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>{open === e.id ? 'Show fewer' : `+${e.changes.length - 2} more`}</button></li>}</ul>
              : <span className="aup-muted">No field changes</span>}</td>
            <td className="mono aup-muted">{e.ip ?? 'Not captured'}</td>
          </tr></Fragment>)}</tbody>
        </table></div>
        {rows.length > limit && <div className="aup-table-foot"><span className="aup-count">Showing {limit} of {rows.length}</span><button type="button" className="aup-btn sm" onClick={() => setLimit(l => l + 15)}>Show 15 more</button></div>}</>
          : <div className="aup-empty"><p>No staff actions on this account yet.</p></div>}
      </>}
  </section>;
}
