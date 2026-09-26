import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation, useRoute } from 'wouter';
import { format } from 'date-fns';
import {
  ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, BadgeCheck, Banknote, Bell,
  BriefcaseBusiness, Building2, Check, ChevronDown, CircleHelp, CreditCard,
  Download, FileCheck2, FileText, Home, Info, Landmark, LayoutGrid, LockKeyhole,
  MoreHorizontal, Plus, RotateCcw, Search, Settings, ShieldCheck, SlidersHorizontal,
  Sparkles, Store, Trash2, WalletCards, X, Zap,
} from 'lucide-react';
import { ForgotPasswordPage, LoginPage, NotFoundPage, SignUpPage } from './pages/AuthPages';
import { AdminPage } from './pages/AdminPage';
import type { Application, ApplicationInput, Grant, Transaction } from './domain/model';
import { grants, payoutMethods } from './domain/seed';
import {
  checkEligibility, computeBalances, deleteDraft, findGrant, isEditable, isGrantOpen, maxEligibleAward, MIN_WITHDRAWAL, ownApplications, ownTransactions,
  PHYSICAL_CARD_FEE, requestPhysicalCard, requestWithdrawal, saveDraft, setTwoFactor, submitApplication,
  toggleCardFreeze, updateProfile, validateApplication, validateWithdrawal, withdrawalFee, type ApplicationStep, type ProfileInput,
} from './domain/rules';
import { DemoStoreProvider, useDemoStore } from './domain/store';

type Toast = (message: string) => void;

const grantIcons: Record<string, typeof BriefcaseBusiness> = { momentum: Store, green: Zap, creative: Sparkles, community: Building2 };
const money = (amount: number) => `${amount < 0 ? '−' : ''}$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso: string) => format(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso), 'MMM dd, yyyy');
const statusClass = (status: string) => `status status-${status.toLowerCase().replace(' ', '-')}`;
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]!.toUpperCase()).join('') || '?';
const byNewest = <T,>(key: (item: T) => string) => (a: T, b: T) => key(b).localeCompare(key(a));
const grantName = (grantId: string) => findGrant(grantId)?.name ?? 'Unknown grant';
const daysUntil = (isoDate: string, now: Date) => Math.ceil((new Date(`${isoDate}T23:59:59`).getTime() - now.getTime()) / 86_400_000);

function Logo() {
  return <div className="brand"><div className="brand-mark">a</div><div className="brand-name">arc<span>.</span>fund</div></div>;
}
function Icon({ item }: { item: typeof Home }) { const I = item; return <I size={17} strokeWidth={1.8} />; }
const navItems = [
  { href: '/', label: 'Dashboard', icon: Home },
  { href: '/grants', label: 'Grant categories', icon: LayoutGrid },
  { href: '/applications', label: 'Applications', icon: FileText },
  { href: '/cards', label: 'Cards', icon: CreditCard },
  { href: '/transactions', label: 'Transactions', icon: ArrowDownLeft },
  { href: '/withdrawals', label: 'Withdrawals', icon: ArrowUpRight },
  { href: '/settings', label: 'Settings', icon: Settings },
];
function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { state: { profile } } = useDemoStore();
  const initials = initialsOf(profile.name);
  const active = (href: string) => href === '/' ? location === '/' || location === '/dashboard' : location.startsWith(href);
  return <div className="app-shell">
    <aside className="sidebar">
      <Logo />
      <div className="nav-label">Your workspace</div>
      <nav className="nav-list">{navItems.map(item => <Link key={item.href} href={item.href} className={`nav-link ${active(item.href) ? 'active' : ''}`} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}><span className="nav-icon"><Icon item={item.icon} /></span>{item.label}</Link>)}</nav>
      <div className="sidebar-bottom">
        <div className="demo-note"><strong>Illustrative workspace</strong><span>Your changes are saved in this browser only. Nothing is sent for review, charged, or paid out.</span></div>
        <div className="user-mini"><div className="avatar">{initials}</div><div className="user-mini-text"><div className="user-mini-name">{profile.name}</div><div className="user-mini-email">{profile.email}</div></div><MoreHorizontal size={16} color="#858990" /></div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div className="topbar-left"><div className="mobile-brand"><div className="brand-mark">a</div><div className="brand-name">arc<span>.</span>fund</div></div><div><p className="eyebrow">Applicant workspace</p><h1 className="page-title">{pageTitle(location, profile.name)}</h1></div></div>
        <div className="top-actions"><button className="icon-btn" aria-label="Help" data-testid="button-help"><CircleHelp size={17} /></button><button className="icon-btn" aria-label="Notifications" data-testid="button-notifications"><Bell size={17} /><span className="notif-dot" /></button><Link href="/login" className="top-avatar" aria-label="Preview sign-in screen" title="Preview sign-in screen" data-testid="link-preview-login">{initials}</Link></div>
      </header>
      <div className="mobile-demo-note" role="note">DEMO ONLY · Saved in this browser only. Nothing is sent, charged, or paid out.</div>
      <div className="page-wrap">{children}</div>
      <nav className="mobile-nav">{navItems.slice(0, 5).map(item => <Link key={item.href} href={item.href} className={active(item.href) ? 'active' : ''} data-testid={`mobile-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}><Icon item={item.icon} /><span>{item.label === 'Grant categories' ? 'Grants' : item.label === 'Transactions' ? 'Activity' : item.label}</span></Link>)}</nav>
    </main>
  </div>;
}
function pageTitle(location: string, name: string) {
  if (location === '/' || location === '/dashboard') {
    const hour = new Date().getHours();
    return `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${name.split(' ')[0]}`;
  }
  if (location.startsWith('/grants')) return 'Grant categories';
  if (location.startsWith('/applications/new')) return 'New application';
  if (location.startsWith('/applications/')) return 'Application';
  if (location.startsWith('/applications')) return 'Applications';
  if (location.startsWith('/cards')) return 'Cards';
  if (location.startsWith('/transactions')) return 'Transactions';
  if (location.startsWith('/withdrawals')) return 'Withdrawals';
  return 'Settings';
}
function DemoToast({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="toast" role="status" data-testid="status-demo-toast"><Info size={17} color="hsl(74 88% 58%)" /><div><strong>Demo workspace</strong><span>{message}</span></div><button onClick={onClose} aria-label="Close message" data-testid="button-close-toast"><X size={15} /></button></div>;
}
function Metric({ label, value, helper, className = '' }: { label: string; value: string; helper: string; className?: string }) {
  return <div className={`card metric-card ${className}`} data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}><div className="metric-label"><span>{label}</span><Info size={14} /></div><div className="metric-value">{value}</div><div className="metric-helper">{helper}</div>{className && <span className="metric-orb" />}</div>;
}
function StatusBadge({ status, tone }: { status: string; tone?: string }) { return <span className={statusClass(tone ?? status)} data-testid={`status-${status.toLowerCase().replaceAll(' ', '-')}`}>{status}</span>; }
function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <span className="field-error" id={id} role="alert">{message}</span> : null;
}

function Dashboard({ onToast }: { onToast: Toast }) {
  const { state } = useDemoStore();
  const now = new Date();
  const mine = ownApplications(state);
  const balances = computeBalances(ownTransactions(state));
  const approved = mine.filter(a => a.status === 'Approved').length;
  const recentApps = [...mine].sort(byNewest(a => a.updatedAt)).slice(0, 3);
  const recentTx = ownTransactions(state).sort(byNewest(t => t.createdAt)).slice(0, 3);
  const virtual = state.cards.virtual;
  return <div className="stack">
    <section className="hero-card card"><div className="hero-copy"><div className="kicker">A clearer way forward</div><h2>Keep your next move well funded.</h2><p>Track grant decisions, understand your available funds, and keep every account detail in one calm workspace.</p><Link className="btn btn-primary" href="/grants" style={{ marginTop: 22 }} data-testid="link-explore-grants">Explore grants <ArrowRight size={15} /></Link></div><div className="hero-visual"><div className="hero-stamp">YOUR<br />MOMENTUM<br />MATTERS</div></div></section>
    <section className="grid-4">
      <Metric label="Eligible amount" value={money(maxEligibleAward(state.profile, mine, now))} helper={`Largest open award at Tier ${state.profile.tier}`} className="lime" />
      <Metric label="Grant balance" value={money(balances.grant)} helper={balances.pendingWithdrawals > 0 ? `${money(balances.pendingWithdrawals)} held for pending payouts` : `${approved} approved award${approved === 1 ? '' : 's'}`} className="dark" />
      <Metric label="Deposit balance" value={money(balances.deposit)} helper="Covers card fees" />
      <Metric label="Account tier" value={`Tier ${state.profile.tier}`} helper={state.profile.identityVerified ? 'Verified applicant' : 'Verification needed'} />
    </section>
    <section className="grid-2">
      <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Application pulse</h2><p className="section-subtitle">A quick view of your active grant work.</p></div><Link className="link-text" href="/applications" data-testid="link-view-applications">View all</Link></div>
        {recentApps.length ? <div className="timeline">{recentApps.map(app => <TimelineRow key={app.id} title={grantName(app.grantId)} text={app.status === 'Draft' ? 'Continue where you left off when ready.' : app.status === 'Changes requested' ? `Action needed: ${app.history[app.history.length - 1]!.note}` : app.history[app.history.length - 1]!.note} status={app.status} current={app.status === 'Submitted' || app.status === 'Under review' || app.status === 'Changes requested'} done={app.status === 'Approved'} href={`/applications/${app.id}`} />)}</div>
          : <div className="empty-state"><h3>No applications yet</h3><p>Browse grant categories to start your first application.</p></div>}
      </div>
      <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Your active card</h2><p className="section-subtitle">{virtual.frozen ? 'Frozen — unfreeze it from Cards.' : 'Ready for everyday spending.'}</p></div><Link className="link-text" href="/cards" data-testid="link-view-cards">Manage</Link></div><CardVisual name={state.profile.name} lastFour={virtual.lastFour} /><div className="quick-actions mt"><Link className="quick-action" href="/withdrawals" data-testid="link-quick-withdraw"><span className="action-icon"><ArrowUpRight size={15} /></span>Request payout</Link><button className="quick-action" onClick={() => onToast('Adding funds needs a payment provider, which is not connected yet.')} data-testid="button-quick-deposit"><span className="action-icon"><ArrowDownLeft size={15} /></span>Add funds</button></div></div>
    </section>
    <section className="card card-pad"><div className="section-head"><div><h2 className="section-title">Recent activity</h2><p className="section-subtitle">Latest entries in your demo ledger.</p></div><Link className="link-text" href="/transactions" data-testid="link-view-transactions">See activity</Link></div><TransactionTable rows={recentTx} /></section>
  </div>;
}
function TimelineRow({ title, text, status, current, done, href }: { title: string; text: string; status?: string; current?: boolean; done?: boolean; href?: string }) {
  const heading = href ? <Link href={href} className="link-text">{title}</Link> : title;
  return <div className="timeline-item"><div className={`timeline-dot ${current ? 'current' : done ? 'done' : ''}`} /><div style={{ flex: 1 }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}><h4>{heading}</h4>{status && <StatusBadge status={status} />}</div><p>{text}</p></div></div>;
}
function CardVisual({ name, lastFour, revealed = false, physical = false, label }: { name: string; lastFour?: string; revealed?: boolean; physical?: boolean; label?: string }) {
  return <div className={`card-visual ${physical ? 'lime-card' : ''}`} data-testid={`card-visual-${physical ? 'physical' : 'virtual'}`}><div className="card-visual-top"><span style={{ font: '700 11px var(--app-font-display)' }}>arc.fund</span><div className="card-chip" /></div><div className="card-number">{label ?? `••••  ••••  ••••  ${revealed ? lastFour : '••••'}`}</div><div className="card-footer"><div><div className="card-holder">Cardholder</div><div className="card-name">{name.toUpperCase()}</div></div><div className="card-network">arc</div></div></div>;
}

function GrantCard({ grant, onToast }: { grant: Grant; onToast: Toast }) {
  const { state } = useDemoStore();
  const now = new Date();
  const GrantIcon = grantIcons[grant.id] ?? BriefcaseBusiness;
  const { eligible, reasons, existing } = checkEligibility(grant, state.profile, ownApplications(state), now);
  const open = isGrantOpen(grant, now);
  const badge = !open && !existing ? <StatusBadge status="Closed" tone="Declined" />
    : existing ? <StatusBadge status={existing.status === 'Draft' ? 'Draft saved' : existing.status} tone={existing.status} />
    : eligible ? <StatusBadge status="Open" tone="Complete" /> : <StatusBadge status="Not eligible" tone="Pending" />;
  const action = existing?.status === 'Draft'
    ? <Link className="btn btn-dark" style={{ flex: 1 }} href={`/applications/${existing.id}`} data-testid={`link-apply-${grant.id}`}>Resume draft <ArrowRight size={14} /></Link>
    : existing?.status === 'Changes requested' ? <Link className="btn btn-dark" style={{ flex: 1 }} href={`/applications/${existing.id}`} data-testid={`link-apply-${grant.id}`}>Update application <ArrowRight size={14} /></Link>
    : existing ? <Link className="btn btn-ghost" style={{ flex: 1 }} href={`/applications/${existing.id}`} data-testid={`link-apply-${grant.id}`}>View application <ArrowRight size={14} /></Link>
    : eligible ? <Link className="btn btn-dark" style={{ flex: 1 }} href={`/applications/new/${grant.id}`} data-testid={`link-apply-${grant.id}`}>Start application <ArrowRight size={14} /></Link>
    : <button className="btn btn-dark" style={{ flex: 1 }} disabled data-testid={`link-apply-${grant.id}`}>Not eligible</button>;
  const details = reasons.length ? reasons.join(' ') : `You meet the requirements. You'll need: ${grant.requirements.join(', ')}.`;
  return <div className="card grant-card" data-testid={`grant-card-${grant.id}`}><div className="grant-top"><div className="grant-symbol"><GrantIcon size={19} /></div>{badge}</div><h3>{grant.name}</h3><p>{grant.summary}</p><div className="grant-meta"><div className="grant-meta-item"><span className="grant-meta-label">Up to</span><span className="grant-meta-value">{money(grant.maxFunding)}</span></div><div className="grant-meta-item"><span className="grant-meta-label">Deadline</span><span className="grant-meta-value">{fmtDate(grant.deadline)}</span></div></div><div style={{ display: 'flex', gap: 8 }}>{action}<button className="icon-btn" onClick={() => onToast(details)} aria-label={`View ${grant.name} details`} data-testid={`button-details-${grant.id}`}><Info size={15} /></button></div></div>;
}
function GrantsPage({ onToast }: { onToast: Toast }) {
  const { state } = useDemoStore();
  const [filter, setFilter] = useState('All');
  const filtered = filter === 'All' ? grants : grants.filter(g => `Tier ${g.minimumTier}` === filter);
  const maxAward = maxEligibleAward(state.profile, ownApplications(state), new Date());
  return <div className="stack"><div className="page-intro"><h2>Find the right kind of support.</h2><p>Explore illustrative grant programs designed for individuals, makers, and small businesses. Check the requirements before starting an application.</p></div><section className="eligibility-box"><div className="eligibility-copy"><h3>Your eligibility snapshot</h3><p>Based on your {state.profile.identityVerified ? 'verified ' : ''}Tier {state.profile.tier} profile, open deadlines, and your existing applications.</p></div><div className="eligibility-result"><strong>{money(maxAward)}</strong><span>largest award you can apply for now</span></div></section><section className="card card-pad"><div className="toolbar"><div><h2 className="section-title">Categories</h2><p className="section-subtitle">Deadlines and amounts are examples for this demo.</p></div><div className="tabs">{['All', 'Tier 1', 'Tier 2', 'Tier 3'].map(t => <button key={t} className={`tab ${filter === t ? 'active' : ''}`} onClick={() => setFilter(t)} data-testid={`tab-grants-${t.toLowerCase().replace(' ', '-')}`}>{t}</button>)}</div></div><div className="grid-2" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>{filtered.map(g => <GrantCard key={g.id} grant={g} onToast={onToast} />)}</div></section></div>;
}

const APPLICATION_TABS = ['All', 'Draft', 'Submitted', 'Under review', 'Changes requested', 'Approved', 'Declined'];
function ApplicationsPage() {
  const { state } = useDemoStore();
  const [filter, setFilter] = useState('All');
  const sorted = ownApplications(state).sort(byNewest(a => a.updatedAt));
  const filtered = filter === 'All' ? sorted : sorted.filter(a => a.status === filter);
  return <div className="stack"><div className="page-intro"><h2>Your applications, in plain view.</h2><p>See what needs your attention, what is being reviewed, and where a decision has been made.</p></div><div className="card card-pad"><div className="toolbar"><div className="tabs">{APPLICATION_TABS.map(t => <button key={t} className={`tab ${filter === t ? 'active' : ''}`} onClick={() => setFilter(t)} data-testid={`tab-applications-${t.toLowerCase().replace(' ', '-')}`}>{t}</button>)}</div><Link className="btn btn-primary" href="/grants" data-testid="link-start-application"><Plus size={15} /> Start an application</Link></div>{filtered.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Application</th><th>Status</th><th>Requested</th><th>Last updated</th><th /></tr></thead><tbody>{filtered.map(app => <tr key={app.id} data-testid={`row-application-${app.id}`}><td><div className="primary-cell">{grantName(app.grantId)}</div><div className="secondary-cell mono">{app.id} · {app.submittedAt ? `submitted ${fmtDate(app.submittedAt)}` : 'not submitted'}</div></td><td><StatusBadge status={app.status} /></td><td className="amount">{money(app.requestedAmount)}</td><td className="muted">{fmtDate(app.updatedAt)}</td><td><Link className="icon-btn" href={`/applications/${app.id}`} aria-label={`${isEditable(app) ? 'Continue' : 'Open'} ${grantName(app.grantId)}`} data-testid={`button-open-application-${app.id}`}><ArrowRight size={15} /></Link></td></tr>)}</tbody></table></div> : <div className="empty-state"><div className="empty-icon"><FileText size={20} /></div><h3>No applications in this view</h3><p>Try another status filter or browse the grant categories to begin.</p><Link className="btn btn-primary" href="/grants" data-testid="link-empty-browse-grants">Browse grants</Link></div>}</div></div>;
}

/** /applications/new/:grantId — redirects to an existing draft or record instead of creating duplicates. */
function NewApplicationRoute({ onToast }: { onToast: Toast }) {
  const [, params] = useRoute('/applications/new/:grantId');
  const { state } = useDemoStore();
  const grant = findGrant(params?.grantId ?? '');
  // Evaluate once on entry; saving a draft mid-flow must not bounce the user to another route.
  const [entry] = useState(() => grant && checkEligibility(grant, state.profile, ownApplications(state), new Date()));
  if (!grant || !entry) return <MissingRecord title="Grant not found" text="This grant program doesn't exist or is no longer offered." />;
  if (entry.existing) return <Redirect to={`/applications/${entry.existing.id}`} replace />;
  if (!entry.eligible) return <div className="card card-pad empty-state"><div className="empty-icon"><LockKeyhole size={20} /></div><h3>You can't apply to {grant.name} yet</h3>{entry.reasons.map(r => <p key={r}>{r}</p>)}<Link className="btn btn-primary" href="/grants" data-testid="link-ineligible-back">Back to grant categories</Link></div>;
  return <ApplicationEditor grant={grant} onToast={onToast} />;
}
/** /applications/:id — drafts and change requests open in the editor, everything else is read-only. */
function ApplicationRoute({ onToast }: { onToast: Toast }) {
  const [, params] = useRoute('/applications/:id');
  const { state } = useDemoStore();
  const app = ownApplications(state).find(a => a.id === params?.id);
  const grant = app && findGrant(app.grantId);
  if (!app || !grant) return <MissingRecord title="Application not found" text="It may have been deleted, or it was created in another browser." />;
  return isEditable(app) ? <ApplicationEditor key={app.id} grant={grant} draft={app} onToast={onToast} /> : <ApplicationDetail app={app} grant={grant} />;
}
function MissingRecord({ title, text }: { title: string; text: string }) {
  return <div className="card card-pad empty-state"><div className="empty-icon"><FileText size={20} /></div><h3>{title}</h3><p>{text}</p><Link className="btn btn-primary" href="/applications" data-testid="link-missing-back">Go to applications</Link></div>;
}

type FormState = { businessName: string; amount: string; registrationNumber: string; purpose: string; checklist: string[] };
const STEP_ONE_FIELDS = ['businessName', 'requestedAmount', 'registrationNumber', 'purpose'];

function ApplicationEditor({ grant, draft, onToast }: { grant: Grant; draft?: Application; onToast: Toast }) {
  const { state, run } = useDemoStore();
  const [, navigate] = useLocation();
  const now = new Date();
  const [draftId, setDraftId] = useState(draft?.id);
  const [step, setStep] = useState<ApplicationStep>(1);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState<FormState>(() => ({
    businessName: draft?.businessName ?? '',
    amount: draft ? String(draft.requestedAmount) : '',
    registrationNumber: draft?.registrationNumber ?? '',
    purpose: draft?.purpose ?? '',
    checklist: draft?.checklist ?? [],
  }));
  const input: ApplicationInput = { businessName: form.businessName, requestedAmount: form.amount.trim() === '' ? NaN : Number(form.amount), registrationNumber: form.registrationNumber, purpose: form.purpose, checklist: form.checklist };
  const setField = (key: keyof FormState, value: string) => { setForm(v => ({ ...v, [key]: value })); setErrors(e => { const { [key === 'amount' ? 'requestedAmount' : key]: _, ...rest } = e; return rest; }); };
  const toggleRequirement = (req: string) => { setForm(v => ({ ...v, checklist: v.checklist.includes(req) ? v.checklist.filter(r => r !== req) : [...v.checklist, req] })); setErrors(({ checklist: _, ...rest }) => rest); };

  const persistDraft = (quiet = false) => {
    // Drafts may hold partial data, but never an invalid number.
    const result = run(s => saveDraft(s, grant.id, { ...input, requestedAmount: Number.isFinite(input.requestedAmount) ? input.requestedAmount : 0 }, new Date(), draftId));
    if (result.ok) { setDraftId(result.id); if (!quiet) onToast(result.message); }
    else onToast(result.error);
    return result.ok;
  };
  const next = () => {
    const stepErrors = validateApplication(input, grant, step === 1 ? 1 : 2);
    if (step < 3) {
      const relevant = Object.fromEntries(Object.entries(stepErrors).filter(([k]) => step === 1 ? STEP_ONE_FIELDS.includes(k) : k === 'checklist'));
      if (Object.keys(relevant).length) { setErrors(relevant); return; }
      if (persistDraft(true)) setStep((step + 1) as ApplicationStep);
      return;
    }
    const result = run(s => submitApplication(s, grant.id, input, new Date(), draftId));
    if (!result.ok) {
      onToast(result.error);
      if (result.fieldErrors) { setErrors(result.fieldErrors); setStep(Object.keys(result.fieldErrors).some(k => STEP_ONE_FIELDS.includes(k)) ? 1 : 2); }
      return;
    }
    onToast(`${result.message} It is stored in this browser only — no reviewer receives it yet.`);
    navigate(`/applications/${result.id}`, { replace: true });
  };
  const removeDraft = () => {
    if (!draftId) return;
    const result = run(s => deleteDraft(s, draftId));
    onToast(result.ok ? result.message : result.error);
    if (result.ok) navigate('/applications');
  };
  const changeRequest = draft?.status === 'Changes requested' ? draft.history[draft.history.length - 1]!.note : null;
  const invalid = (key: string) => errors[key] ? { 'aria-invalid': true, 'aria-describedby': `${key}-error` } : {};
  const daysLeft = daysUntil(grant.deadline, now);
  const tierOk = state.profile.tier >= grant.minimumTier;

  return <div className="detail-layout"><div className="card card-pad"><div className="page-intro" style={{ marginBottom: 18 }}><p className="eyebrow">{changeRequest ? `${draftId} · changes requested` : draftId ? `Draft ${draftId}` : 'New application'}</p><h2>{grant.name}</h2><p>{changeRequest ? 'Update your application and resubmit it for review.' : "Complete each step and submit when you're ready. Your progress is saved as a draft in this browser whenever you continue."}</p></div>
    {changeRequest && <div className="notice mb" role="note" data-testid="notice-change-request"><Info size={16} /><div><strong>The reviewer asked for changes:</strong> {changeRequest}</div></div>}
    <div className="stepper">{['Basics', 'Requirements', 'Review'].map((label, i) => <div className={`step ${step === i + 1 ? 'active' : ''} ${step > i + 1 ? 'complete' : ''}`} key={label}><span className="step-num">{step > i + 1 ? <Check size={12} /> : i + 1}</span><span className="step-label">{label}</span></div>)}</div>
    {step === 1 && <div className="field-grid">
      <div className="field field-full"><label className="field-label" htmlFor="business">Business or project name</label><input id="business" className="input" value={form.businessName} onChange={e => setField('businessName', e.target.value)} placeholder="e.g. Morgan Studio" data-testid="input-business-name" {...invalid('businessName')} /><FieldError id="businessName-error" message={errors.businessName} /></div>
      <div className="field"><label className="field-label" htmlFor="amount">Requested amount (USD)</label><input id="amount" className="input" type="number" inputMode="decimal" min={grant.minimumRequest} max={grant.maxFunding} step="0.01" value={form.amount} onChange={e => setField('amount', e.target.value)} data-testid="input-requested-amount" {...invalid('requestedAmount')} />{errors.requestedAmount ? <FieldError id="requestedAmount-error" message={errors.requestedAmount} /> : <span className="field-hint">{money(grant.minimumRequest)} – {money(grant.maxFunding)}</span>}</div>
      <div className="field"><label className="field-label" htmlFor="registration">Registration number{grant.requiresRegistration ? '' : ' (optional)'}</label><input id="registration" className="input" value={form.registrationNumber} onChange={e => setField('registrationNumber', e.target.value)} placeholder="e.g. CA-5521904" data-testid="input-registration-number" {...invalid('registrationNumber')} /><FieldError id="registrationNumber-error" message={errors.registrationNumber} /></div>
      <div className="field field-full"><label className="field-label" htmlFor="purpose">What would this funding unlock?</label><textarea id="purpose" className="textarea" value={form.purpose} onChange={e => setField('purpose', e.target.value)} placeholder="Share a few sentences about your plan..." data-testid="textarea-funding-purpose" {...invalid('purpose')} />{errors.purpose ? <FieldError id="purpose-error" message={errors.purpose} /> : <span className="field-hint">{form.purpose.trim().length} characters · at least 30</span>}</div>
    </div>}
    {step === 2 && <div className="stack" style={{ gap: 13 }}>
      <div className="notice"><Info size={16} />Confirm you have each document ready. Secure document upload will be added with private storage; nothing is uploaded yet.</div>
      {grant.requirements.map((req, i) => <label className="upload" key={req} style={{ cursor: 'pointer' }}><div className="upload-icon">{form.checklist.includes(req) ? <Check size={15} /> : <FileText size={15} />}</div><div className="upload-copy"><strong>{req}</strong><span>{form.checklist.includes(req) ? 'Marked as ready' : 'Required'}</span></div><input type="checkbox" checked={form.checklist.includes(req)} onChange={() => toggleRequirement(req)} aria-label={`I have ${req} ready`} data-testid={`checkbox-requirement-${i}`} /></label>)}
      <FieldError id="checklist-error" message={errors.checklist} />
    </div>}
    {step === 3 && <div className="stack">
      <div className="notice"><ShieldCheck size={16} />Review your details. Submitting records the application in this browser only — it is not sent to a reviewer yet.</div>
      <div className="card" style={{ padding: 16, background: 'hsl(var(--background))' }}>
        <div className="fee-row"><span>Grant category</span><strong>{grant.name}</strong></div>
        <div className="fee-row"><span>Requested amount</span><strong>{money(input.requestedAmount || 0)}</strong></div>
        <div className="fee-row"><span>Project or business</span><strong>{form.businessName.trim()}</strong></div>
        <div className="fee-row"><span>Registration number</span><strong>{form.registrationNumber.trim() || 'Not provided'}</strong></div>
        <div className="fee-row"><span>Requirements ready</span><strong>{form.checklist.length} of {grant.requirements.length}</strong></div>
        <div className="fee-row"><span>Current state</span><StatusBadge status={draft?.status ?? 'Draft'} /></div>
      </div>
      <div><span className="field-label">Funding plan</span><p className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{form.purpose.trim()}</p></div>
    </div>}
    <div className="form-actions">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost" onClick={() => step > 1 ? setStep((step - 1) as ApplicationStep) : navigate('/grants')} data-testid="button-application-back">{step > 1 ? <><ArrowLeft size={15} /> Back</> : 'Cancel'}</button>
        <button className="btn btn-ghost" onClick={() => persistDraft()} data-testid="button-save-draft">{changeRequest ? 'Save changes' : 'Save draft'}</button>
        {draftId && !changeRequest && (confirmDelete
          ? <button className="btn btn-ghost danger-text" onClick={removeDraft} data-testid="button-confirm-delete-draft">Confirm delete</button>
          : <button className="btn btn-ghost" onClick={() => setConfirmDelete(true)} aria-label="Delete draft" data-testid="button-delete-draft"><Trash2 size={14} /></button>)}
      </div>
      <button className="btn btn-primary" onClick={next} data-testid="button-application-next">{step === 3 ? (changeRequest ? 'Resubmit application' : 'Submit application') : 'Continue'} <ArrowRight size={15} /></button>
    </div>
  </div>
  <aside className="stack"><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Before you begin</h2><p className="section-subtitle">Key details for this category.</p></div><FileCheck2 size={20} color="hsl(var(--lime-deep))" /></div><div className="timeline"><TimelineRow title={`${money(grant.minimumRequest)} – ${money(grant.maxFunding)}`} text="Allowed request range." done /><TimelineRow title={`Minimum Tier ${grant.minimumTier}`} text={tierOk ? `Your Tier ${state.profile.tier} account qualifies.` : `Your account is Tier ${state.profile.tier}, so it can't be submitted.`} done={tierOk} /><TimelineRow title={fmtDate(grant.deadline)} text={daysLeft >= 0 ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left to submit.` : 'Deadline has passed.'} current={daysLeft >= 0 && daysLeft <= 14} /></div></div><Link className="btn btn-ghost" href="/grants" data-testid="link-back-to-grants"><ArrowLeft size={15} /> Back to grant categories</Link></aside></div>;
}

function ApplicationDetail({ app, grant }: { app: Application; grant: Grant }) {
  const history = [...app.history].reverse();
  return <div className="detail-layout"><div className="card card-pad"><div className="section-head"><div><p className="eyebrow mono">{app.id}</p><h2 className="section-title" style={{ fontSize: 22 }}>{grant.name}</h2><p className="section-subtitle">{app.submittedAt ? `Submitted ${fmtDate(app.submittedAt)}` : 'Not submitted'} · updated {fmtDate(app.updatedAt)}</p></div><StatusBadge status={app.status} /></div>
    <div className="card" style={{ padding: 16, background: 'hsl(var(--background))' }}>
      <div className="fee-row"><span>Requested amount</span><strong>{money(app.requestedAmount)}</strong></div>
      {app.awardedAmount !== null && <div className="fee-row"><span>Awarded</span><strong>{money(app.awardedAmount)}</strong></div>}
      <div className="fee-row"><span>Project or business</span><strong>{app.businessName}</strong></div>
      <div className="fee-row"><span>Registration number</span><strong>{app.registrationNumber || 'Not provided'}</strong></div>
      <div className="fee-row"><span>Requirements ready</span><strong>{app.checklist.length} of {grant.requirements.length}</strong></div>
    </div>
    <div className="mt"><span className="field-label">Funding plan</span><p className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{app.purpose}</p></div>
    <div className="notice mt"><Info size={16} />{app.status === 'Approved' ? 'This decision is final. The award is in your grant balance and can be requested as a payout.' : app.status === 'Declined' ? `This decision is final. ${app.history[app.history.length - 1]!.note}` : 'Submitted applications are read-only while the grant team reviews them. If they need anything, the application will reopen for your changes.'}</div>
  </div>
  <aside className="stack"><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">History</h2><p className="section-subtitle">Every status change, newest first.</p></div></div><div className="timeline">{history.map((h, i) => <TimelineRow key={`${h.status}-${h.at}`} title={h.status} text={`${fmtDate(h.at)} · ${h.actor === 'Reviewer' ? 'Grant team' : 'You'} · ${h.note}`} current={i === 0 && h.status !== 'Approved' && h.status !== 'Declined'} done={i > 0 || h.status === 'Approved'} />)}</div></div><Link className="btn btn-ghost" href="/applications" data-testid="link-back-to-applications"><ArrowLeft size={15} /> All applications</Link></aside></div>;
}

function CardsPage({ onToast }: { onToast: Toast }) {
  const { state, run } = useDemoStore();
  const [revealed, setRevealed] = useState(false);
  const { virtual, physical } = state.cards;
  const balances = computeBalances(ownTransactions(state));
  const requested = physical.status === 'Requested';
  const act = (result: ReturnType<typeof run>) => onToast(result.ok ? result.message : result.error);
  return <div className="stack"><div className="page-intro"><h2>Spend with context.</h2><p>Manage your cards here. Card changes are saved in this browser only; no card network is connected yet.</p></div><section className="grid-2">
    <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Virtual card</h2><p className="section-subtitle">{virtual.frozen ? 'Frozen — new spending is blocked.' : 'Available for spending.'}</p></div><StatusBadge status={virtual.frozen ? 'Frozen' : 'Active'} tone={virtual.frozen ? 'Pending' : 'Completed'} /></div><CardVisual name={state.profile.name} lastFour={virtual.lastFour} revealed={revealed} /><div className="quick-actions mt"><button className="quick-action" onClick={() => setRevealed(v => !v)} data-testid="button-reveal-card"><span className="action-icon"><LockKeyhole size={15} /></span>{revealed ? 'Hide number' : 'Reveal number'}</button><button className="quick-action" onClick={() => act(run(toggleCardFreeze))} data-testid="button-freeze-card"><span className="action-icon"><ShieldCheck size={15} /></span>{virtual.frozen ? 'Unfreeze card' : 'Freeze card'}</button></div></div>
    <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Physical card</h2><p className="section-subtitle">{requested ? 'Requested — delivery tracking arrives with the card provider.' : 'Request a card for in-person spending.'}</p></div>{requested ? <StatusBadge status="Requested" tone="Pending" /> : <CreditCard size={19} color="hsl(var(--muted))" />}</div><CardVisual name={state.profile.name} physical label={requested ? 'REQUESTED' : 'NOT REQUESTED'} /><div style={{ marginTop: 16 }}><div className="fee-row"><span>Issuance fee (from deposit balance)</span><strong>{money(PHYSICAL_CARD_FEE)}</strong></div><div className="fee-row"><span>Deposit balance</span><strong>{money(balances.deposit)}</strong></div><button className="btn btn-dark" style={{ width: '100%', marginTop: 12 }} disabled={requested} onClick={() => act(run(s => requestPhysicalCard(s, new Date())))} data-testid="button-request-physical-card">{requested ? 'Card requested' : 'Request physical card'}</button></div></div>
  </section><section className="card card-pad"><div className="section-head"><div><h2 className="section-title">Card limits</h2><p className="section-subtitle">Illustrative controls for your account tier.</p></div></div><div className="grid-3"><Metric label="Daily card limit" value={money(virtual.dailyLimit)} helper="Virtual card" /><Metric label="Deposit balance" value={money(balances.deposit)} helper="Covers card fees" /><Metric label="Card status" value={virtual.frozen ? 'Frozen' : 'Active'} helper="Virtual card" /></div></section></div>;
}

function TransactionTable({ rows }: { rows: Transaction[] }) {
  if (!rows.length) return <div className="empty-state"><h3>No activity yet</h3><p>Awards, payouts, and fees will appear here.</p></div>;
  return <div className="table-wrap"><table className="data-table"><thead><tr><th>Activity</th><th>Type</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>{rows.map(tx => <tr key={tx.id} data-testid={`row-transaction-${tx.id}`}><td><div className="primary-cell">{tx.description}</div><div className="secondary-cell mono">{tx.id}</div>{tx.failureReason && <div className="secondary-cell danger-text">Failed: {tx.failureReason} The amount was returned to your grant balance.</div>}{tx.type === 'Withdrawal' && tx.status === 'Completed' && tx.processedAt && <div className="secondary-cell">Paid {fmtDate(tx.processedAt)}{tx.fee ? ` · you received ${money(Math.abs(tx.amount) - tx.fee)}` : ''}</div>}</td><td className="muted">{tx.type}</td><td className={`amount ${tx.amount < 0 ? 'muted' : ''}`}>{money(tx.amount)}</td><td><StatusBadge status={tx.status} /></td><td className="muted">{fmtDate(tx.createdAt)}</td></tr>)}</tbody></table></div>;
}
function exportCsv(rows: Transaction[]) {
  const escape = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const lines = [
    '# arc.fund demo export — browser-only sample records, not a financial statement',
    ['id', 'date', 'type', 'description', 'amount', 'status'].join(','),
    ...rows.map(t => [t.id, t.createdAt, t.type, t.description, t.amount.toFixed(2), t.status].map(escape).join(',')),
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'arc-fund-demo-activity.csv'; a.click();
  URL.revokeObjectURL(url);
}
function TransactionsPage() {
  const { state } = useDemoStore();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All');
  const filtered = useMemo(() => ownTransactions(state).sort(byNewest(t => t.createdAt)).filter(t => (filter === 'All' || t.type === filter) && `${t.description} ${t.id}`.toLowerCase().includes(query.toLowerCase())), [state, query, filter]);
  return <div className="stack"><div className="page-intro"><h2>Every movement, easy to follow.</h2><p>Grants, deposits, card fees, and payout requests in one activity ledger. Balances are calculated from these entries.</p></div><div className="card card-pad"><div className="toolbar"><div className="search-wrap"><Search size={16} /><input className="input" type="search" placeholder="Search activity" value={query} onChange={e => setQuery(e.target.value)} data-testid="input-search-transactions" /></div><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><SlidersHorizontal size={15} color="hsl(var(--muted))" /><select className="select" style={{ width: 145 }} value={filter} onChange={e => setFilter(e.target.value)} data-testid="select-transaction-filter"><option>All</option><option>Grant</option><option>Deposit</option><option>Withdrawal</option><option>Card fee</option></select><button className="btn btn-ghost" disabled={!filtered.length} onClick={() => exportCsv(filtered)} data-testid="button-export-transactions"><Download size={14} /> Export</button></div></div>{filtered.length ? <TransactionTable rows={filtered} /> : <div className="empty-state"><div className="empty-icon"><Search size={19} /></div><h3>No activity found</h3><p>Try a different search term or reset the activity filter.</p></div>}</div></div>;
}

function WithdrawalsPage({ onToast }: { onToast: Toast }) {
  const { state, run } = useDemoStore();
  const [method, setMethod] = useState('bank');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const balances = computeBalances(ownTransactions(state));
  const value = amount.trim() === '' ? NaN : Number(amount);
  const fee = withdrawalFee(value);
  const payout = payoutMethods.find(p => p.id === method)!;
  const history = ownTransactions(state).filter(t => t.type === 'Withdrawal').sort(byNewest(t => t.createdAt));
  const preview = () => { const problem = validateWithdrawal(value, balances.grant); setError(problem); if (!problem) setShowModal(true); };
  const confirm = () => {
    const result = run(s => requestWithdrawal(s, value, payout, new Date()));
    setShowModal(false);
    if (!result.ok) { setError(result.error); return; }
    setAmount('');
    onToast(`${result.message} No money was sent — no payout provider is connected.`);
  };
  return <div className="stack"><div className="detail-layout"><div className="stack"><div className="withdraw-summary"><div className="metric-label"><span>Available to request</span><WalletCards size={15} /></div><div className="metric-value">{money(balances.grant)}</div><div className="metric-helper">Grant balance{balances.pendingWithdrawals > 0 ? ` · ${money(balances.pendingWithdrawals)} held for pending payouts` : ''}</div></div><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Request a payout</h2><p className="section-subtitle">Choose a destination and check the fee breakdown.</p></div></div><div className="notice mb"><Info size={16} />Payout requests are recorded in this browser only. No bank or mobile-money provider is connected, so no money moves.</div><div className="field mb"><label className="field-label" htmlFor="withdrawal-amount">Amount (USD)</label><input id="withdrawal-amount" type="number" inputMode="decimal" min={MIN_WITHDRAWAL} step="0.01" className="input" value={amount} onChange={e => { setAmount(e.target.value); setError(null); }} placeholder="0.00" data-testid="input-withdrawal-amount" aria-invalid={!!error} aria-describedby={error ? 'withdrawal-error' : undefined} />{error ? <FieldError id="withdrawal-error" message={error} /> : <span className="field-hint">Minimum {money(MIN_WITHDRAWAL)} · up to {money(balances.grant)}</span>}</div><div className="field"><span className="field-label">Payout destination</span><div className="stack" style={{ gap: 8 }}>{payoutMethods.map(p => <label key={p.id} className={`payout-method ${method === p.id ? 'active' : ''}`}><input type="radio" name="payout" checked={method === p.id} onChange={() => setMethod(p.id)} data-testid={`radio-payout-${p.id}`} /><div className="payout-icon">{p.id === 'bank' ? <Landmark size={15} /> : <Banknote size={15} />}</div><div className="payout-copy"><strong>{p.type}</strong><span>{p.label}</span></div><ChevronDown size={14} color="hsl(var(--muted))" /></label>)}</div></div><div className="form-actions"><span className="muted" style={{ fontSize: 11, alignSelf: 'center' }}>No real payout will be created.</span><button className="btn btn-primary" onClick={preview} disabled={balances.grant <= 0} data-testid="button-preview-withdrawal">Review request <ArrowRight size={15} /></button></div></div></div><aside className="card card-pad"><div className="section-head"><div><h2 className="section-title">Fee breakdown</h2><p className="section-subtitle">1.25% processing, capped at $14 (demo rate).</p></div></div><div className="fee-row"><span>Requested amount</span><strong>{money(value || 0)}</strong></div><div className="fee-row"><span>Processing fee</span><strong>{money(fee)}</strong></div><div className="fee-row"><span>You receive</span><strong>{money(Math.max(0, (value || 0) - fee))}</strong></div><p className="field-hint" style={{ marginTop: 15 }}>The fee is deducted from the payout. Actual methods and fees will be set when a provider is chosen.</p></aside></div>
    <section className="card card-pad"><div className="section-head"><div><h2 className="section-title">Payout requests</h2><p className="section-subtitle">Pending requests are held from your grant balance until the finance team marks them paid or failed.</p></div></div><TransactionTable rows={history} /></section>
    {showModal && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="withdrawal-modal-title"><div className="modal"><div className="modal-head"><div><h2 id="withdrawal-modal-title">Confirm payout request</h2><p>The request is recorded as pending in this browser. No money moves.</p></div><button className="icon-btn" onClick={() => setShowModal(false)} aria-label="Close" data-testid="button-close-withdrawal-modal"><X size={16} /></button></div><div className="fee-row"><span>Destination</span><strong>{payout.type} · {payout.label}</strong></div><div className="fee-row"><span>Amount</span><strong>{money(value)}</strong></div><div className="fee-row"><span>Processing fee</span><strong>{money(fee)}</strong></div><div className="fee-row"><span>You receive</span><strong>{money(value - fee)}</strong></div><div style={{ display: 'flex', gap: 8, marginTop: 18 }}><button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShowModal(false)} data-testid="button-cancel-withdrawal">Cancel</button><button className="btn btn-dark" style={{ flex: 1 }} onClick={confirm} data-testid="button-confirm-withdrawal">Submit request</button></div></div></div>}
  </div>;
}

function SettingsPage({ onToast }: { onToast: Toast }) {
  const { state, run, reset } = useDemoStore();
  const { profile } = state;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProfileInput>(profile);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmReset, setConfirmReset] = useState(false);
  const startEdit = () => { setDraft({ name: profile.name, email: profile.email, phone: profile.phone, address: profile.address }); setErrors({}); setEditing(true); };
  const save = () => {
    const result = run(s => updateProfile(s, draft));
    if (!result.ok) { setErrors(result.fieldErrors ?? {}); return; }
    setEditing(false); onToast(result.message);
  };
  const shown = editing ? draft : profile;
  const field = (key: keyof ProfileInput, label: string) => <div className="field"><label className="field-label" htmlFor={`profile-${key}`}>{label}</label><input id={`profile-${key}`} className="input" disabled={!editing} value={shown[key]} onChange={e => { setDraft({ ...draft, [key]: e.target.value }); setErrors(({ [key]: _, ...rest }) => rest); }} data-testid={`input-profile-${key}`} aria-invalid={!!errors[key]} aria-describedby={errors[key] ? `profile-${key}-error` : undefined} /><FieldError id={`profile-${key}-error`} message={errors[key]} /></div>;
  return <div className="detail-layout"><aside className="card card-pad"><div className="section-head"><div><h2 className="section-title">Account settings</h2><p className="section-subtitle">Your profile and security controls.</p></div></div><div className="settings-nav"><button className="active" data-testid="tab-settings-profile">Profile details</button><button onClick={() => onToast('Verification status is shown on this page.')} data-testid="tab-settings-verification">Verification</button><button onClick={() => onToast('Notification preferences will be available in a later phase.')} data-testid="tab-settings-notifications">Notifications</button></div></aside><div className="stack">
    <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Profile details</h2><p className="section-subtitle">Keep your contact details current.</p></div><button className="btn btn-ghost" onClick={() => editing ? setEditing(false) : startEdit()} data-testid="button-edit-profile">{editing ? 'Cancel' : 'Edit profile'}</button></div><div className="field-grid">{field('name', 'Full name')}{field('email', 'Email')}{field('phone', 'Phone')}{field('address', 'Address')}</div>{editing && <div className="form-actions"><span className="muted" style={{ fontSize: 11 }}>Saved in this browser only.</span><button className="btn btn-primary" onClick={save} data-testid="button-save-profile">Save changes</button></div>}</div>
    <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Verification & security</h2><p className="section-subtitle">The signals behind your Tier {profile.tier} account.</p></div><BadgeCheck size={21} color="hsl(var(--success))" /></div><div className="verification-item"><div className="verification-icon"><Check size={15} /></div><div className="verification-copy"><strong>Identity verification</strong><span>{profile.identityVerified ? 'Verified' : 'Not verified'} · demo status</span></div><StatusBadge status={profile.identityVerified ? 'Completed' : 'Pending'} /></div><div className="verification-item"><div className="verification-icon"><ShieldCheck size={15} /></div><div className="verification-copy"><strong>Account tier</strong><span>Tier {profile.tier} · sets which grants you can apply for</span></div><span style={{ font: '700 12px var(--app-font-display)' }}>Tier {profile.tier}</span></div><div className="verification-item"><div className="verification-icon"><LockKeyhole size={15} /></div><div className="verification-copy"><strong>Two-step sign-in</strong><span>Preference only until sign-in is connected</span></div><button className={`switch ${profile.twoFactor ? 'on' : ''}`} role="switch" aria-checked={profile.twoFactor} onClick={() => { const r = run(s => setTwoFactor(s, !profile.twoFactor)); if (r.ok) onToast(r.message); }} aria-label="Toggle two-step sign-in" data-testid="button-toggle-two-factor" /></div></div>
    <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Demo data</h2><p className="section-subtitle">Applications, payouts, card changes, and profile edits are stored in this browser.</p></div><RotateCcw size={19} color="hsl(var(--muted))" /></div><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{confirmReset ? <><button className="btn btn-dark" onClick={() => { reset(); setConfirmReset(false); setEditing(false); onToast('Demo data reset to the original sample records.'); }} data-testid="button-confirm-reset-demo">Yes, reset everything</button><button className="btn btn-ghost" onClick={() => setConfirmReset(false)} data-testid="button-cancel-reset-demo">Keep my changes</button></> : <button className="btn btn-ghost" onClick={() => setConfirmReset(true)} data-testid="button-reset-demo">Reset demo data</button>}</div></div>
  </div></div>;
}

function RouterView({ onToast }: { onToast: Toast }) {
  const [location] = useLocation();
  useEffect(() => {
    const titles: Record<string, string> = {
      '/': 'Dashboard', '/dashboard': 'Dashboard', '/grants': 'Grant categories',
      '/applications': 'Applications', '/cards': 'Cards', '/transactions': 'Transactions',
      '/withdrawals': 'Withdrawals', '/settings': 'Settings',
      '/login': 'Sign in', '/signup': 'Create an account', '/forgot-password': 'Reset password',
      '/admin': 'Admin overview', '/admin/applicants': 'Admin applicants',
      '/admin/inbox': 'Admin email inbox',
      '/admin/applications': 'Admin applications', '/admin/payouts': 'Admin payouts', '/admin/grants': 'Admin grants',
      '/admin/settings': 'Admin settings',
    };
    const title = titles[location] ?? (location.startsWith('/applications/new/') ? 'New application' : location.startsWith('/applications/') ? 'Application' : 'Page not found');
    const description = location.startsWith('/admin')
      ? 'Explore the arc.fund admin UI preview. Sample records only; admin access and changes are not active.'
      : 'Explore the arc.fund grant applicant workspace. Preview data is saved in this browser only; sign-in, review, and payouts are not active.';
    document.title = `${title} | arc.fund demo`;
    for (const [selector, value] of [
      ['meta[name="description"]', description],
      ['meta[property="og:title"]', document.title],
      ['meta[property="og:description"]', description],
      ['meta[name="twitter:title"]', document.title],
      ['meta[name="twitter:description"]', description],
    ]) document.querySelector(selector)?.setAttribute('content', value);
  }, [location]);
  return <Switch>
    <Route path="/login"><LoginPage /></Route>
    <Route path="/signup"><SignUpPage /></Route>
    <Route path="/forgot-password"><ForgotPasswordPage /></Route>
    <Route path="/admin"><AdminPage section="overview" /></Route>
    <Route path="/admin/applicants"><AdminPage section="applicants" /></Route>
    <Route path="/admin/inbox"><AdminPage section="inbox" /></Route>
    <Route path="/admin/applications"><AdminPage section="applications" /></Route>
    <Route path="/admin/payouts"><AdminPage section="payouts" /></Route>
    <Route path="/admin/grants"><AdminPage section="grants" /></Route>
    <Route path="/admin/settings"><AdminPage section="settings" /></Route>
    <Route path="/"><Shell><Dashboard onToast={onToast} /></Shell></Route>
    <Route path="/dashboard"><Shell><Dashboard onToast={onToast} /></Shell></Route>
    <Route path="/grants"><Shell><GrantsPage onToast={onToast} /></Shell></Route>
    <Route path="/applications/new/:grantId"><Shell><NewApplicationRoute onToast={onToast} /></Shell></Route>
    <Route path="/applications/:id"><Shell><ApplicationRoute onToast={onToast} /></Shell></Route>
    <Route path="/applications"><Shell><ApplicationsPage /></Shell></Route>
    <Route path="/cards"><Shell><CardsPage onToast={onToast} /></Shell></Route>
    <Route path="/transactions"><Shell><TransactionsPage /></Shell></Route>
    <Route path="/withdrawals"><Shell><WithdrawalsPage onToast={onToast} /></Shell></Route>
    <Route path="/settings"><Shell><SettingsPage onToast={onToast} /></Shell></Route>
    <Route><NotFoundPage /></Route>
  </Switch>;
}
function App() {
  const [toast, setToast] = useState<string | null>(null);
  const onToast = (message: string) => { setToast(message); window.setTimeout(() => setToast(current => current === message ? null : current), 4200); };
  return <DemoStoreProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><RouterView onToast={onToast} />{toast && <DemoToast message={toast} onClose={() => setToast(null)} />}</WouterRouter></DemoStoreProvider>;
}

export default App;
