import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation, useRoute } from 'wouter';
import { format } from 'date-fns';
import {
  ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, BadgeCheck, Banknote,
  BriefcaseBusiness, Building2, Check, ChevronDown, CircleHelp, CreditCard,
  Download, FileCheck2, FileText, Home, Info, Landmark, LayoutGrid, LockKeyhole,
  LoaderCircle, LogOut, MoreHorizontal, Plus, Receipt, RotateCcw, Search, Settings, ShieldAlert, ShieldCheck, SlidersHorizontal,
  PiggyBank, Sparkles, Store, Trash2, WalletCards, X, Zap,
} from 'lucide-react';
import { ForgotPasswordPage, LoginPage, NotFoundPage, ResetPasswordPage, SignUpPage } from './pages/AuthPages';
import { AdminPage } from './pages/AdminPage';
import { AdminLoginPage, AdminResetPasswordPage } from './pages/AdminLogin';
import { SessionProvider, useSession } from './lib/session';
import type { Application, ApplicationInput, ChannelId, DemoState, DepositMethodId, Grant, KycDocumentType, PayoutChannel, Transaction } from './domain/model';
import { CURRENT_APPLICANT_ID } from './domain/seed';
import { accountLockReason, accountOf } from './domain/applicants';
import { completeCredentialReset, KYC_DOCUMENT_TYPES, submitKyc, type KycInput } from './domain/accounts';
import { lockdownMessage } from './domain/security';
import { downloadText } from './lib/download';
import {
  adoptSessionApplicant, checkEligibility, computeBalances, deleteDraft, findGrant, isEditable, isGrantOpen, maxEligibleAward, ownApplications, ownTransactions, visibleGrants,
  saveDraft, setTwoFactor, submitApplication, updateProfile, validateApplication, type ApplicationStep, type ProfileInput,
} from './domain/rules';
import { DemoStoreProvider, useDemoStore } from './domain/store';
import {
  cancelWithdrawal, channelFee, DESTINATION_FIELDS, enabledChannels, MIN_CARD_LIMIT, payoutBlocker, physicalCardTotal, removePayoutDestination, requestPhysicalCard,
  requestWithdrawal, savePayoutDestination, setCardLimit, TIER_CARD_LIMITS, toggleCardFreeze, validateWithdrawal, type DestinationInput,
} from './domain/money';
import { cancelDeposit, DEPOSIT_METHODS, requestDeposit } from './domain/deposits';
import { NotificationsMenu } from './components/NotificationsMenu';

type Toast = (message: string) => void;

const grantIcons: Record<string, typeof BriefcaseBusiness> = { momentum: Store, green: Zap, creative: Sparkles, community: Building2 };
const money = (amount: number) => `${amount < 0 ? '−' : ''}$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso: string) => format(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso), 'MMM dd, yyyy');
const statusClass = (status: string) => `status status-${status.toLowerCase().replace(' ', '-')}`;
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]!.toUpperCase()).join('') || '?';
const byNewest = <T,>(key: (item: T) => string) => (a: T, b: T) => key(b).localeCompare(key(a));
const grantName = (state: DemoState, grantId: string) => findGrant(state, grantId)?.name ?? 'Unknown grant';
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
  { href: '/deposits', label: 'Add funds', icon: PiggyBank },
  { href: '/settings', label: 'Settings', icon: Settings },
];
/**
 * With sign-in configured, applicant pages need a session; the account's name and
 * email replace the demo profile's. Without it, the demo workspace stays open.
 */
function ApplicantGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const [location] = useLocation();
  const { run } = useDemoStore();
  const { accountName, accountEmail } = session;
  useEffect(() => {
    if (session.status === 'signedIn' && accountEmail) run(s => adoptSessionApplicant(s, { name: accountName ?? '', email: accountEmail }));
  }, [session.status, accountEmail, accountName, run]);
  if (session.status === 'unconfigured') return <>{children}</>;
  if (session.status === 'signedOut') return <Redirect to={`/login?next=${encodeURIComponent(location)}`} replace />;
  if (session.status === 'loading') return <div className="gate-loading" role="status" data-testid="status-applicant-gate-loading"><LoaderCircle size={20} className="auth-spin" aria-hidden="true" /> Opening your workspace…</div>;
  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  return <ApplicantGate><ShellLayout>{children}</ShellLayout></ApplicantGate>;
}
function ShellLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const session = useSession();
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
        <div className="top-actions"><button className="icon-btn" aria-label="Help" data-testid="button-help"><CircleHelp size={17} /></button><NotificationsMenu />{session.status === 'signedIn'
          ? <><span className="top-avatar" aria-hidden="true">{initials}</span><button className="icon-btn" onClick={() => void session.signOut()} aria-label="Sign out" title="Sign out" data-testid="button-signout"><LogOut size={16} /></button></>
          : <Link href="/login" className="top-avatar" aria-label="Preview sign-in screen" title="Preview sign-in screen" data-testid="link-preview-login">{initials}</Link>}</div>
      </header>
      <div className="mobile-demo-note" role="note">DEMO ONLY · Saved in this browser only. Nothing is sent, charged, or paid out.</div>
      <div className="page-wrap"><AccountBanner />{children}</div>
      <nav className="mobile-nav">{navItems.slice(0, 5).map(item => <Link key={item.href} href={item.href} className={active(item.href) ? 'active' : ''} data-testid={`mobile-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}><Icon item={item.icon} /><span>{item.label === 'Grant categories' ? 'Grants' : item.label === 'Transactions' ? 'Activity' : item.label}</span></Link>)}</nav>
    </main>
  </div>;
}
/** Staff-imposed restrictions the applicant needs to know about, on every page. */
function AccountBanner() {
  const { state } = useDemoStore();
  const locked = accountLockReason(state);
  const account = accountOf(state, CURRENT_APPLICANT_ID);
  const resets = [account.passwordResetRequired && 'choose a new password', account.twoFactorResetRequired && 'set up two-step sign-in again'].filter(Boolean);
  if (!locked && !state.lockdown && !resets.length) return null;
  return <div className="stack" style={{ gap: 8, marginBottom: 16 }}>
    {locked && <div className="notice notice-danger" role="alert" data-testid="notice-account-locked"><ShieldAlert size={16} /><div>{locked}</div></div>}
    {state.lockdown && <div className="notice" role="status" data-testid="notice-lockdown"><ShieldAlert size={16} /><div>{lockdownMessage(state)} Pending requests are safe.</div></div>}
    {resets.length > 0 && <div className="notice" role="status" data-testid="notice-credential-reset"><LockKeyhole size={16} /><div>The grant team asked you to {resets.join(' and ')}. <Link href="/settings" className="link-text">Go to Settings</Link></div></div>}
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
  if (location.startsWith('/deposits')) return 'Add funds';
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
      <Metric label="Eligible amount" value={money(maxEligibleAward(state.grants, state.profile, mine, now))} helper={`Largest open award at Tier ${state.profile.tier}`} className="lime" />
      <Metric label="Grant balance" value={money(balances.grant)} helper={balances.pendingWithdrawals > 0 ? `${money(balances.pendingWithdrawals)} held for pending payouts` : `${approved} approved award${approved === 1 ? '' : 's'}`} className="dark" />
      <Metric label="Deposit balance" value={money(balances.deposit)} helper={balances.pendingDeposits > 0 ? `${money(balances.pendingDeposits)} awaiting confirmation` : 'Covers card fees'} />
      <Metric label="Account tier" value={`Tier ${state.profile.tier}`} helper={state.profile.identityVerified ? 'Verified applicant' : 'Verification needed'} />
    </section>
    <section className="grid-2">
      <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Application pulse</h2><p className="section-subtitle">A quick view of your active grant work.</p></div><Link className="link-text" href="/applications" data-testid="link-view-applications">View all</Link></div>
        {recentApps.length ? <div className="timeline">{recentApps.map(app => <TimelineRow key={app.id} title={grantName(state, app.grantId)} text={app.status === 'Draft' ? 'Continue where you left off when ready.' : app.status === 'Changes requested' ? `Action needed: ${app.history[app.history.length - 1]!.note}` : app.history[app.history.length - 1]!.note} status={app.status} current={app.status === 'Submitted' || app.status === 'Under review' || app.status === 'Changes requested'} done={app.status === 'Approved'} href={`/applications/${app.id}`} />)}</div>
          : <div className="empty-state"><h3>No applications yet</h3><p>Browse grant categories to start your first application.</p></div>}
      </div>
      <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Your active card</h2><p className="section-subtitle">{virtual.frozen ? 'Frozen — unfreeze it from Cards.' : 'Ready for everyday spending.'}</p></div><Link className="link-text" href="/cards" data-testid="link-view-cards">Manage</Link></div><CardVisual name={state.profile.name} lastFour={virtual.lastFour} /><div className="quick-actions mt"><Link className="quick-action" href="/withdrawals" data-testid="link-quick-withdraw"><span className="action-icon"><ArrowUpRight size={15} /></span>Request payout</Link><Link className="quick-action" href="/deposits" data-testid="button-quick-deposit"><span className="action-icon"><ArrowDownLeft size={15} /></span>Add funds</Link></div></div>
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
  const badge = existing && existing.status !== 'Draft' ? <StatusBadge status={existing.status} tone={existing.status} />
    : !open ? <StatusBadge status="Closed" tone="Declined" />
    : existing ? <StatusBadge status="Draft saved" tone="Draft" />
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
  const catalog = visibleGrants(state);
  const filtered = filter === 'All' ? catalog : catalog.filter(g => `Tier ${g.minimumTier}` === filter);
  const maxAward = maxEligibleAward(state.grants, state.profile, ownApplications(state), new Date());
  return <div className="stack"><div className="page-intro"><h2>Find the right kind of support.</h2><p>Explore illustrative grant programs designed for individuals, makers, and small businesses. Check the requirements before starting an application.</p></div><section className="eligibility-box"><div className="eligibility-copy"><h3>Your eligibility snapshot</h3><p>Based on your {state.profile.identityVerified ? 'verified ' : ''}Tier {state.profile.tier} profile, open deadlines, and your existing applications.</p></div><div className="eligibility-result"><strong>{money(maxAward)}</strong><span>largest award you can apply for now</span></div></section><section className="card card-pad"><div className="toolbar"><div><h2 className="section-title">Categories</h2><p className="section-subtitle">Deadlines and amounts are examples for this demo.</p></div><div className="tabs">{['All', 'Tier 1', 'Tier 2', 'Tier 3'].map(t => <button key={t} className={`tab ${filter === t ? 'active' : ''}`} onClick={() => setFilter(t)} data-testid={`tab-grants-${t.toLowerCase().replace(' ', '-')}`}>{t}</button>)}</div></div><div className="grid-2" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>{filtered.map(g => <GrantCard key={g.id} grant={g} onToast={onToast} />)}</div></section></div>;
}

const APPLICATION_TABS = ['All', 'Draft', 'Submitted', 'Under review', 'Changes requested', 'Approved', 'Declined'];
function ApplicationsPage() {
  const { state } = useDemoStore();
  const [filter, setFilter] = useState('All');
  const sorted = ownApplications(state).sort(byNewest(a => a.updatedAt));
  const filtered = filter === 'All' ? sorted : sorted.filter(a => a.status === filter);
  return <div className="stack"><div className="page-intro"><h2>Your applications, in plain view.</h2><p>See what needs your attention, what is being reviewed, and where a decision has been made.</p></div><div className="card card-pad"><div className="toolbar"><div className="tabs">{APPLICATION_TABS.map(t => <button key={t} className={`tab ${filter === t ? 'active' : ''}`} onClick={() => setFilter(t)} data-testid={`tab-applications-${t.toLowerCase().replace(' ', '-')}`}>{t}</button>)}</div><Link className="btn btn-primary" href="/grants" data-testid="link-start-application"><Plus size={15} /> Start an application</Link></div>{filtered.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Application</th><th>Status</th><th>Requested</th><th>Last updated</th><th /></tr></thead><tbody>{filtered.map(app => <tr key={app.id} data-testid={`row-application-${app.id}`}><td><div className="primary-cell">{grantName(state, app.grantId)}</div><div className="secondary-cell mono">{app.id} · {app.submittedAt ? `submitted ${fmtDate(app.submittedAt)}` : 'not submitted'}</div></td><td><StatusBadge status={app.status} /></td><td className="amount">{money(app.requestedAmount)}</td><td className="muted">{fmtDate(app.updatedAt)}</td><td><Link className="icon-btn" href={`/applications/${app.id}`} aria-label={`${isEditable(app) ? 'Continue' : 'Open'} ${grantName(state, app.grantId)}`} data-testid={`button-open-application-${app.id}`}><ArrowRight size={15} /></Link></td></tr>)}</tbody></table></div> : <div className="empty-state"><div className="empty-icon"><FileText size={20} /></div><h3>No applications in this view</h3><p>Try another status filter or browse the grant categories to begin.</p><Link className="btn btn-primary" href="/grants" data-testid="link-empty-browse-grants">Browse grants</Link></div>}</div></div>;
}

/** /applications/new/:grantId — redirects to an existing draft or record instead of creating duplicates. */
function NewApplicationRoute({ onToast }: { onToast: Toast }) {
  const [, params] = useRoute('/applications/new/:grantId');
  const { state } = useDemoStore();
  const grant = findGrant(state, params?.grantId ?? '');
  // Evaluate once on entry; saving a draft mid-flow must not bounce the user to another route.
  const [entry] = useState(() => grant && checkEligibility(grant, state.profile, ownApplications(state), new Date()));
  if (!grant || !entry || grant.status === 'Draft') return <MissingRecord title="Grant not found" text="This grant program doesn't exist or is no longer offered." />;
  if (entry.existing) return <Redirect to={`/applications/${entry.existing.id}`} replace />;
  if (!entry.eligible) return <div className="card card-pad empty-state"><div className="empty-icon"><LockKeyhole size={20} /></div><h3>You can't apply to {grant.name} yet</h3>{entry.reasons.map(r => <p key={r}>{r}</p>)}<Link className="btn btn-primary" href="/grants" data-testid="link-ineligible-back">Back to grant categories</Link></div>;
  return <ApplicationEditor grant={grant} onToast={onToast} />;
}
/** /applications/:id — drafts and change requests open in the editor, everything else is read-only. */
function ApplicationRoute({ onToast }: { onToast: Toast }) {
  const [, params] = useRoute('/applications/:id');
  const { state } = useDemoStore();
  const app = ownApplications(state).find(a => a.id === params?.id);
  const grant = app && findGrant(state, app.grantId);
  if (!app || !grant) return <MissingRecord title="Application not found" text="It may have been deleted, or it was created in another browser." />;
  return isEditable(app) ? <ApplicationEditor key={app.id} grant={grant} draft={app} onToast={onToast} /> : <ApplicationDetail app={app} grant={grant} />;
}
function MissingRecord({ title, text }: { title: string; text: string }) {
  return <div className="card card-pad empty-state"><div className="empty-icon"><FileText size={20} /></div><h3>{title}</h3><p>{text}</p><Link className="btn btn-primary" href="/applications" data-testid="link-missing-back">Go to applications</Link></div>;
}

type FormState = { businessName: string; amount: string; registrationNumber: string; purpose: string; checklist: string[]; answers: Record<string, string> };
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
    answers: { ...(draft?.answers ?? {}) },
  }));
  const input: ApplicationInput = { businessName: form.businessName, requestedAmount: form.amount.trim() === '' ? NaN : Number(form.amount), registrationNumber: form.registrationNumber, purpose: form.purpose, checklist: form.checklist, answers: form.answers };
  const setAnswer = (id: string, value: string) => { setForm(v => ({ ...v, answers: { ...v.answers, [id]: value } })); setErrors(({ [`answers.${id}`]: _, ...rest }) => rest); };
  const setField = (key: Exclude<keyof FormState, 'checklist' | 'answers'>, value: string) => { setForm(v => ({ ...v, [key]: value })); setErrors(e => { const { [key === 'amount' ? 'requestedAmount' : key]: _, ...rest } = e; return rest; }); };
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
      const relevant = Object.fromEntries(Object.entries(stepErrors).filter(([k]) => step === 1 ? STEP_ONE_FIELDS.includes(k) : k === 'checklist' || k.startsWith('answers.')));
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
    {!changeRequest && !isGrantOpen(grant, now) && <div className="notice mb" role="note" data-testid="notice-program-closed"><Info size={16} /><div>This program is no longer accepting applications, so this draft can't be submitted. You can still view it or delete it.</div></div>}
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
      {grant.questions.length > 0 && <div className="stack" style={{ gap: 12, marginTop: 8 }} data-testid="section-program-questions"><h3 className="section-title" style={{ fontSize: 14 }}>A few questions from the program team</h3>{grant.questions.map(q => { const id = `question-${q.id}`; const err = errors[`answers.${q.id}`]; const value = form.answers[q.id] ?? ''; return <div className="field" key={q.id}>
        <label className="field-label" htmlFor={id}>{q.label}{q.required ? '' : ' (optional)'}</label>
        {q.type === 'yesno'
          ? <select id={id} className="select" value={value} onChange={e => setAnswer(q.id, e.target.value)} data-testid={`select-answer-${q.id}`} aria-invalid={!!err} aria-describedby={err ? `${id}-error` : undefined}><option value="">Choose…</option><option>Yes</option><option>No</option></select>
          : <input id={id} className="input" inputMode={q.type === 'number' ? 'decimal' : undefined} value={value} onChange={e => setAnswer(q.id, e.target.value)} data-testid={`input-answer-${q.id}`} aria-invalid={!!err} aria-describedby={err ? `${id}-error` : undefined} />}
        <FieldError id={`${id}-error`} message={err} />
      </div>; })}</div>}
    </div>}
    {step === 3 && <div className="stack">
      <div className="notice"><ShieldCheck size={16} />Review your details. Submitting records the application in this browser only — it is not sent to a reviewer yet.</div>
      <div className="card" style={{ padding: 16, background: 'hsl(var(--background))' }}>
        <div className="fee-row"><span>Grant category</span><strong>{grant.name}</strong></div>
        <div className="fee-row"><span>Requested amount</span><strong>{money(input.requestedAmount || 0)}</strong></div>
        <div className="fee-row"><span>Project or business</span><strong>{form.businessName.trim()}</strong></div>
        <div className="fee-row"><span>Registration number</span><strong>{form.registrationNumber.trim() || 'Not provided'}</strong></div>
        <div className="fee-row"><span>Requirements ready</span><strong>{form.checklist.length} of {grant.requirements.length}</strong></div>
        {grant.questions.map(q => <div className="fee-row" key={q.id}><span>{q.label}</span><strong>{form.answers[q.id]?.trim() || '—'}</strong></div>)}
        {!changeRequest && state.treasury.applicationFee > 0 && <div className="fee-row"><span>Application fee (from deposit balance)</span><strong>{money(state.treasury.applicationFee)}</strong></div>}
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
      {grant.questions.map(q => <div className="fee-row" key={q.id}><span>{q.label}</span><strong>{app.answers[q.id] || '—'}</strong></div>)}
    </div>
    <div className="mt"><span className="field-label">Funding plan</span><p className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{app.purpose}</p></div>
    <div className="notice mt"><Info size={16} />{app.status === 'Approved' ? 'This decision is final. The award is in your grant balance and can be requested as a payout.' : app.status === 'Declined' ? `This decision is final. ${app.history[app.history.length - 1]!.note}` : 'Submitted applications are read-only while the grant team reviews them. If they need anything, the application will reopen for your changes.'}</div>
  </div>
  <aside className="stack"><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">History</h2><p className="section-subtitle">Every status change, newest first.</p></div></div><div className="timeline">{history.map((h, i) => <TimelineRow key={`${h.status}-${h.at}`} title={h.status} text={`${fmtDate(h.at)} · ${h.actor === 'Reviewer' ? 'Grant team' : 'You'} · ${h.note}`} current={i === 0 && h.status !== 'Approved' && h.status !== 'Declined'} done={i > 0 || h.status === 'Approved'} />)}</div></div><Link className="btn btn-ghost" href="/applications" data-testid="link-back-to-applications"><ArrowLeft size={15} /> All applications</Link></aside></div>;
}

function CardLimitEditor({ card, onToast }: { card: 'virtual' | 'physical'; onToast: Toast }) {
  const { state, run } = useDemoStore();
  const current = state.cards[card].dailyLimit;
  const [value, setValue] = useState(String(current));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setValue(String(current)); }, [current]);
  const max = TIER_CARD_LIMITS[state.profile.tier];
  const save = () => {
    const result = run(s => setCardLimit(s, card, value.trim() === '' ? NaN : Number(value)));
    if (!result.ok) { setError(result.error); return; }
    setError(null); onToast(result.message);
  };
  const id = `limit-${card}`;
  return <div className="field"><label className="field-label" htmlFor={id}>{card === 'virtual' ? 'Virtual card' : 'Physical card'} daily limit (USD)</label>
    <div style={{ display: 'flex', gap: 8 }}><input id={id} className="input" type="number" inputMode="numeric" min={MIN_CARD_LIMIT} max={max} step="1" value={value} onChange={e => { setValue(e.target.value); setError(null); }} data-testid={`input-card-limit-${card}`} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} /><button className="btn btn-ghost" disabled={value === String(current)} onClick={save} data-testid={`button-save-card-limit-${card}`}>Save</button></div>
    {error ? <FieldError id={`${id}-error`} message={error} /> : <span className="field-hint">{money(MIN_CARD_LIMIT)} – {money(max)} for Tier {state.profile.tier} accounts</span>}
  </div>;
}
function CardsPage({ onToast }: { onToast: Toast }) {
  const { state, run } = useDemoStore();
  const [revealed, setRevealed] = useState(false);
  const [pinShown, setPinShown] = useState(false);
  useEffect(() => { if (!pinShown) return; const timer = window.setTimeout(() => setPinShown(false), 10_000); return () => window.clearTimeout(timer); }, [pinShown]);
  const { virtual, physical } = state.cards;
  const { treasury } = state;
  const balances = computeBalances(ownTransactions(state));
  const requested = physical.status === 'Requested';
  const locked = !!accountLockReason(state);
  const total = physicalCardTotal(treasury);
  const act = (result: ReturnType<typeof run>) => onToast(result.ok ? result.message : result.error);
  return <div className="stack"><div className="page-intro"><h2>Spend with context.</h2><p>Manage your cards here. Card changes are saved in this browser only; no card network is connected yet.</p></div><section className="grid-2">
    <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Virtual card</h2><p className="section-subtitle">{locked ? 'Blocked while your account is locked.' : virtual.frozen ? 'Frozen — new spending is blocked.' : 'Available for spending.'}</p></div><StatusBadge status={locked ? 'Locked' : virtual.frozen ? 'Frozen' : 'Active'} tone={locked ? 'Failed' : virtual.frozen ? 'Pending' : 'Completed'} /></div><CardVisual name={state.profile.name} lastFour={virtual.lastFour} revealed={revealed} /><div className="quick-actions mt"><button className="quick-action" onClick={() => setRevealed(v => !v)} data-testid="button-reveal-card"><span className="action-icon"><LockKeyhole size={15} /></span>{revealed ? 'Hide number' : 'Reveal number'}</button><button className="quick-action" onClick={() => act(run(toggleCardFreeze))} data-testid="button-freeze-card"><span className="action-icon"><ShieldCheck size={15} /></span>{virtual.frozen ? 'Unfreeze card' : 'Freeze card'}</button><button className="quick-action" onClick={() => setPinShown(v => !v)} data-testid="button-reveal-pin"><span className="action-icon"><LockKeyhole size={15} /></span>{pinShown ? <>PIN <strong className="mono" data-testid="text-card-pin">{virtual.pin}</strong></> : 'Reveal PIN'}</button></div>{pinShown && <p className="field-hint" style={{ marginTop: 8 }}>Demo PIN, hidden again after 10 seconds. A real PIN would come from the card provider and need a fresh sign-in.</p>}</div>
    <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Physical card</h2><p className="section-subtitle">{requested ? 'Requested — delivery tracking arrives with the card provider.' : 'Request a card for in-person spending.'}</p></div>{requested ? <StatusBadge status="Requested" tone="Pending" /> : <CreditCard size={19} color="hsl(var(--muted))" />}</div><CardVisual name={state.profile.name} physical label={requested ? 'REQUESTED' : 'NOT REQUESTED'} /><div style={{ marginTop: 16 }}>
      <div className="fee-row"><span>Issuance fee</span><strong>{money(treasury.physicalCardFee)}</strong></div>
      {treasury.cardDeliveryFee > 0 && <div className="fee-row"><span>Delivery fee</span><strong>{money(treasury.cardDeliveryFee)}</strong></div>}
      <div className="fee-row"><span>Deposit balance</span><strong>{money(balances.deposit)}</strong></div>
      {treasury.depositThreshold > 0 && <div className="fee-row"><span>Required reserve after fees</span><strong>{money(treasury.depositThreshold)}</strong></div>}
      <button className="btn btn-dark" style={{ width: '100%', marginTop: 12 }} disabled={requested || locked} onClick={() => act(run(s => requestPhysicalCard(s, new Date())))} data-testid="button-request-physical-card">{requested ? 'Card requested' : `Request physical card · ${money(total)}`}</button>
      {!requested && balances.deposit - total < treasury.depositThreshold && <p className="field-hint" style={{ marginTop: 8 }}>Your deposit balance is too low. <Link href="/deposits" className="link-text">Add funds</Link></p>}
    </div></div>
  </section><section className="card card-pad"><div className="section-head"><div><h2 className="section-title">Daily spending limits</h2><p className="section-subtitle">Set your own limit up to your tier's maximum. Illustrative — no card network enforces it yet.</p></div></div><div className="field-grid"><CardLimitEditor card="virtual" onToast={onToast} />{requested ? <CardLimitEditor card="physical" onToast={onToast} /> : <div className="field"><span className="field-label">Physical card daily limit</span><span className="field-hint">Available once you request a physical card.</span></div>}</div></section></div>;
}
function TransactionNote({ tx }: { tx: Transaction }) {
  if (tx.status === 'Failed' && tx.failureReason) return <div className="secondary-cell danger-text">{tx.type === 'Deposit' ? 'Not credited' : 'Failed'}: {tx.failureReason}{tx.type === 'Withdrawal' ? ' The amount was returned to your grant balance.' : ''}</div>;
  if (tx.status === 'Cancelled') return <div className="secondary-cell">Cancelled {tx.processedAt ? fmtDate(tx.processedAt) : ''}</div>;
  if (tx.type === 'Withdrawal' && tx.status === 'Completed' && tx.processedAt) return <div className="secondary-cell">Paid {fmtDate(tx.processedAt)}{tx.fee ? ` · you received ${money(Math.abs(tx.amount) - tx.fee)}` : ''}</div>;
  if (tx.type === 'Deposit' && tx.status === 'Pending') return <div className="secondary-cell">Waiting for funds · reference {tx.reference}</div>;
  return null;
}
function TransactionTable({ rows, action }: { rows: Transaction[]; action?: (tx: Transaction) => ReactNode }) {
  if (!rows.length) return <div className="empty-state"><h3>No activity yet</h3><p>Awards, deposits, payouts, and fees will appear here.</p></div>;
  return <div className="table-wrap"><table className="data-table"><thead><tr><th>Activity</th><th>Type</th><th>Amount</th><th>Status</th><th>Date</th>{action && <th />}</tr></thead><tbody>{rows.map(tx => <tr key={tx.id} data-testid={`row-transaction-${tx.id}`}><td><div className="primary-cell">{tx.description}</div><div className="secondary-cell mono">{tx.reference ?? tx.id}</div><TransactionNote tx={tx} /></td><td className="muted">{tx.type}</td><td className={`amount ${tx.amount < 0 ? 'muted' : ''}`}>{money(tx.amount)}</td><td><StatusBadge status={tx.status} /></td><td className="muted">{fmtDate(tx.createdAt)}</td>{action && <td>{action(tx)}</td>}</tr>)}</tbody></table></div>;
}
function exportCsv(rows: Transaction[]) {
  const escape = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const lines = [
    '# arc.fund demo export — browser-only sample records, not a financial statement',
    ['id', 'date', 'type', 'description', 'amount', 'status'].join(','),
    ...rows.map(t => [t.id, t.createdAt, t.type, t.description, t.amount.toFixed(2), t.status].map(escape).join(',')),
  ];
  downloadText('arc-fund-demo-activity.csv', lines.join('\n'), 'text/csv');
}
/** Receipt lines for one ledger entry (shared by the modal and the downloaded text). */
function receiptLines(tx: Transaction, name: string): [string, string][] {
  const lines: [string, string][] = [['Reference', tx.reference ?? tx.id], ['Account holder', name], ['Date', format(new Date(tx.createdAt), 'MMM dd, yyyy HH:mm')], ['Type', tx.type], ['Description', tx.description], ['Amount', money(tx.amount)], ['Status', tx.status]];
  if (tx.fee) lines.push(['Processing fee', money(tx.fee)], ['Net received', money(Math.abs(tx.amount) - tx.fee)]);
  if (tx.destination) lines.push(['Destination', tx.destination]);
  if (tx.processedAt) lines.push([tx.status === 'Cancelled' ? 'Cancelled' : 'Processed', format(new Date(tx.processedAt), 'MMM dd, yyyy HH:mm')]);
  if (tx.failureReason) lines.push(['Reason', tx.failureReason]);
  return lines;
}
function ReceiptModal({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const { state } = useDemoStore();
  const lines = receiptLines(tx, state.profile.name);
  const download = () => downloadText(`arc-fund-receipt-${tx.id}.txt`, ['arc.fund demo receipt — browser-only sample record, not proof of payment', '', ...lines.map(([k, v]) => `${k}: ${v}`)].join('\n'));
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey); }, [onClose]);
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="receipt-title" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className="modal" data-testid="modal-receipt"><div className="modal-head"><div><h2 id="receipt-title">Receipt</h2><p>Demo record from this browser. Not proof of payment.</p></div><button className="icon-btn" onClick={onClose} aria-label="Close receipt" data-testid="button-close-receipt" autoFocus><X size={16} /></button></div>
    {lines.map(([k, v]) => <div className="fee-row" key={k}><span>{k}</span><strong>{v}</strong></div>)}
    <div style={{ display: 'flex', gap: 8, marginTop: 18 }}><button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Close</button><button className="btn btn-dark" style={{ flex: 1 }} onClick={download} data-testid="button-download-receipt"><Download size={14} /> Download</button></div>
  </div></div>;
}
const TRANSACTION_TABS: { label: string; types: Transaction['type'][] | null }[] = [
  { label: 'All', types: null }, { label: 'Grants', types: ['Grant'] }, { label: 'Deposits', types: ['Deposit'] },
  { label: 'Withdrawals', types: ['Withdrawal'] }, { label: 'Fees', types: ['Card fee', 'Application fee'] },
];
function TransactionsPage() {
  const { state } = useDemoStore();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('All');
  const [status, setStatus] = useState('All statuses');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [receipt, setReceipt] = useState<Transaction | null>(null);
  const types = TRANSACTION_TABS.find(t => t.label === tab)?.types ?? null;
  const filtered = useMemo(() => {
    const start = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
    const end = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
    return ownTransactions(state).sort(byNewest(t => t.createdAt)).filter(t => {
      const at = new Date(t.createdAt).getTime();
      return (!types || types.includes(t.type)) && (status === 'All statuses' || t.status === status) && at >= start && at <= end && `${t.description} ${t.id} ${t.reference ?? ''}`.toLowerCase().includes(query.toLowerCase());
    });
  }, [state, query, types, status, from, to]);
  const clear = () => { setQuery(''); setTab('All'); setStatus('All statuses'); setFrom(''); setTo(''); };
  return <div className="stack"><div className="page-intro"><h2>Every movement, easy to follow.</h2><p>Grants, deposits, fees, and payout requests in one activity ledger. Balances are calculated from these entries.</p></div><div className="card card-pad">
    <div className="tabs mb" role="tablist" aria-label="Transaction type">{TRANSACTION_TABS.map(t => <button key={t.label} role="tab" aria-selected={tab === t.label} className={`tab ${tab === t.label ? 'active' : ''}`} onClick={() => setTab(t.label)} data-testid={`tab-transactions-${t.label.toLowerCase()}`}>{t.label}</button>)}</div>
    <div className="toolbar"><div className="search-wrap"><Search size={16} /><input className="input" type="search" placeholder="Search activity or reference" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search activity" data-testid="input-search-transactions" /></div><div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><SlidersHorizontal size={15} color="hsl(var(--muted))" /><select className="select" style={{ width: 140 }} value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status" data-testid="select-transaction-status"><option>All statuses</option><option>Completed</option><option>Pending</option><option>Failed</option><option>Cancelled</option></select><input className="input" style={{ width: 150 }} type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="From date" data-testid="input-transactions-from" /><input className="input" style={{ width: 150 }} type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="To date" data-testid="input-transactions-to" /><button className="btn btn-ghost" disabled={!filtered.length} onClick={() => exportCsv(filtered)} data-testid="button-export-transactions"><Download size={14} /> Export</button></div></div>
    {filtered.length ? <TransactionTable rows={filtered} action={tx => <button className="icon-btn" onClick={() => setReceipt(tx)} aria-label={`Receipt for ${tx.reference ?? tx.id}`} data-testid={`button-receipt-${tx.id}`}><Receipt size={15} /></button>} /> : <div className="empty-state"><div className="empty-icon"><Search size={19} /></div><h3>No activity found</h3><p>Try a different search, date range, or filter.</p><button className="btn btn-ghost" onClick={clear} data-testid="button-clear-transaction-filters">Clear filters</button></div>}
  </div>{receipt && <ReceiptModal tx={receipt} onClose={() => setReceipt(null)} />}</div>;
}

function CancelButton({ tx, onCancel, label }: { tx: Transaction; onCancel: (id: string) => void; label: string }) {
  const [confirming, setConfirming] = useState(false);
  if (tx.status !== 'Pending') return null;
  return confirming
    ? <span style={{ display: 'inline-flex', gap: 6 }}><button className="btn btn-ghost" onClick={() => onCancel(tx.id)} data-testid={`button-confirm-cancel-${tx.id}`}>Confirm</button><button className="btn btn-ghost" onClick={() => setConfirming(false)} aria-label="Keep request" data-testid={`button-keep-${tx.id}`}><X size={14} /></button></span>
    : <button className="btn btn-ghost" onClick={() => setConfirming(true)} data-testid={`button-cancel-${tx.id}`}>{label}</button>;
}
function WithdrawalsPage({ onToast }: { onToast: Toast }) {
  const { state, run } = useDemoStore();
  const channels = enabledChannels(state);
  const [channelId, setChannelId] = useState<ChannelId | ''>(channels[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const balances = computeBalances(ownTransactions(state));
  const channel = channels.find(c => c.id === channelId) ?? channels[0];
  const value = amount.trim() === '' ? NaN : Number(amount);
  const fee = channel ? channelFee(channel, value) : 0;
  const blocker = payoutBlocker(state);
  const history = ownTransactions(state).filter(t => t.type === 'Withdrawal').sort(byNewest(t => t.createdAt));
  const preview = () => { if (!channel) return; const problem = validateWithdrawal(state, value, channel.id); setError(problem); if (!problem) setShowModal(true); };
  const confirm = () => {
    if (!channel) return;
    const result = run(s => requestWithdrawal(s, value, channel.id, new Date()));
    setShowModal(false);
    if (!result.ok) { setError(result.error); return; }
    setAmount('');
    onToast(`${result.message} No money was sent — no payout provider is connected.`);
  };
  const cancel = (id: string) => { const result = run(s => cancelWithdrawal(s, id, new Date())); onToast(result.ok ? result.message : result.error); };
  const feeText = (c: PayoutChannel) => [c.feeRate ? `${+(c.feeRate * 100).toFixed(2)}%` : '', c.feeFixed ? `${money(c.feeFixed)} fixed` : ''].filter(Boolean).join(' + ') + (c.feeCap && c.feeRate ? `, max ${money(c.feeCap)}` : '') || 'No fee';
  return <div className="stack"><div className="detail-layout"><div className="stack"><div className="withdraw-summary"><div className="metric-label"><span>Available to request</span><WalletCards size={15} /></div><div className="metric-value">{money(balances.grant)}</div><div className="metric-helper">Grant balance{balances.pendingWithdrawals > 0 ? ` · ${money(balances.pendingWithdrawals)} held for pending payouts` : ''}</div></div><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Request a payout</h2><p className="section-subtitle">Choose a channel and check the fee breakdown.</p></div></div><div className="notice mb"><Info size={16} />Payout requests are recorded in this browser only. No bank, mobile-money, or crypto provider is connected, so no money moves.</div>
    {blocker && <div className="notice mb" role="alert" data-testid="notice-payout-blocked"><Info size={16} /><div>{blocker}{blocker.includes('deposit balance') && <> <Link href="/deposits" className="link-text">Add funds</Link></>}</div></div>}
    {channel && <><div className="field mb"><label className="field-label" htmlFor="withdrawal-amount">Amount (USD)</label><input id="withdrawal-amount" type="number" inputMode="decimal" min={channel.min} max={channel.max} step="0.01" className="input" value={amount} onChange={e => { setAmount(e.target.value); setError(null); }} placeholder="0.00" data-testid="input-withdrawal-amount" aria-invalid={!!error} aria-describedby={error ? 'withdrawal-error' : undefined} />{error ? <FieldError id="withdrawal-error" message={error} /> : <span className="field-hint">{channel.name}: {money(channel.min)} – {money(Math.min(channel.max, Math.max(balances.grant, 0)))}</span>}</div>
    <div className="field"><span className="field-label">Payout channel</span><div className="stack" style={{ gap: 8 }}>{channels.map(c => <label key={c.id} className={`payout-method ${channel.id === c.id ? 'active' : ''}`}><input type="radio" name="payout" checked={channel.id === c.id} onChange={() => { setChannelId(c.id); setError(null); }} data-testid={`radio-payout-${c.id}`} /><div className="payout-icon">{c.id === 'bank' || c.id === 'wire' ? <Landmark size={15} /> : <Banknote size={15} />}</div><div className="payout-copy"><strong>{c.name}</strong><span>{state.payoutDestinations[c.id] ?? 'No destination saved'} · fee {feeText(c)}</span></div><ChevronDown size={14} color="hsl(var(--muted))" /></label>)}</div></div></>}
    {channel && !state.payoutDestinations[channel.id] && <div className="notice mt" role="note" data-testid="notice-missing-destination"><Info size={16} /><div>Add your {channel.name} details before requesting a payout. <Link href="/settings#payouts" className="link-text">Payout destinations</Link></div></div>}
    {channel && channel.max >= state.treasury.dualControlThreshold && <p className="field-hint mt">Requests of {money(state.treasury.dualControlThreshold)} or more need two members of the finance and compliance team to sign off, so they can take longer.</p>}
    <div className="form-actions"><span className="muted" style={{ fontSize: 11, alignSelf: 'center' }}>No real payout will be created.</span><button className="btn btn-primary" onClick={preview} disabled={!channel || !!blocker || balances.grant <= 0} data-testid="button-preview-withdrawal">Review request <ArrowRight size={15} /></button></div></div></div>
    <aside className="card card-pad"><div className="section-head"><div><h2 className="section-title">Fee breakdown</h2><p className="section-subtitle">{channel ? `${channel.name}: ${feeText(channel)}` : 'No channel available'}</p></div></div><div className="fee-row"><span>Requested amount</span><strong>{money(value || 0)}</strong></div><div className="fee-row"><span>Processing fee</span><strong>{money(fee)}</strong></div><div className="fee-row"><span>You receive</span><strong>{money(Math.max(0, (value || 0) - fee))}</strong></div><p className="field-hint" style={{ marginTop: 15 }}>The fee is deducted from the payout. Rates are set by the finance team and apply to new requests.</p></aside></div>
    <section className="card card-pad"><div className="section-head"><div><h2 className="section-title">Payout requests</h2><p className="section-subtitle">Pending requests are held from your grant balance until the finance team marks them paid or failed. You can cancel a request while it's pending.</p></div></div><TransactionTable rows={history} action={tx => <CancelButton tx={tx} onCancel={cancel} label="Cancel" />} /></section>
    {showModal && channel && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="withdrawal-modal-title"><div className="modal"><div className="modal-head"><div><h2 id="withdrawal-modal-title">Confirm payout request</h2><p>The request is recorded as pending in this browser. No money moves.</p></div><button className="icon-btn" onClick={() => setShowModal(false)} aria-label="Close" data-testid="button-close-withdrawal-modal"><X size={16} /></button></div><div className="fee-row"><span>Destination</span><strong>{channel.name} · {state.payoutDestinations[channel.id]}</strong></div><div className="fee-row"><span>Amount</span><strong>{money(value)}</strong></div><div className="fee-row"><span>Processing fee</span><strong>{money(fee)}</strong></div><div className="fee-row"><span>You receive</span><strong>{money(value - fee)}</strong></div><div style={{ display: 'flex', gap: 8, marginTop: 18 }}><button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShowModal(false)} data-testid="button-cancel-withdrawal">Cancel</button><button className="btn btn-dark" style={{ flex: 1 }} onClick={confirm} data-testid="button-confirm-withdrawal">Submit request</button></div></div></div>}
  </div>;
}
function DepositsPage({ onToast }: { onToast: Toast }) {
  const { state, run } = useDemoStore();
  const [methodId, setMethodId] = useState<DepositMethodId>('bank');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<string | null>(null);
  const balances = computeBalances(ownTransactions(state));
  const { treasury } = state;
  const method = DEPOSIT_METHODS.find(m => m.id === methodId)!;
  const deposits = ownTransactions(state).filter(t => t.type === 'Deposit').sort(byNewest(t => t.createdAt));
  const justCreated = latest ? deposits.find(t => t.id === latest && t.status === 'Pending') : undefined;
  const submit = () => {
    const value = amount.trim() === '' ? NaN : Number(amount);
    const result = run(s => requestDeposit(s, value, methodId, new Date()));
    if (!result.ok) { setError(result.error); return; }
    setError(null); setAmount(''); setLatest(result.id ?? null);
    onToast(result.message);
  };
  const cancel = (id: string) => { const result = run(s => cancelDeposit(s, id, new Date())); onToast(result.ok ? result.message : result.error); };
  return <div className="stack"><div className="page-intro"><h2>Add funds to your deposit balance.</h2><p>Your deposit balance pays card fees and must hold a small reserve before payouts. Announce a transfer here, send it with the reference, and it's credited once the finance team confirms it arrived.</p></div>
    <div className="detail-layout"><div className="card card-pad">
      <div className="section-head"><div><h2 className="section-title">New deposit</h2><p className="section-subtitle">{money(treasury.minDeposit)} – {money(treasury.maxDeposit)} per deposit.</p></div></div>
      <div className="notice mb"><Info size={16} />Demo only. The receiving details are fictional and no bank or mobile-money provider is connected. Don't send real money.</div>
      <div className="field mb"><label className="field-label" htmlFor="deposit-amount">Amount (USD)</label><input id="deposit-amount" className="input" type="number" inputMode="decimal" min={treasury.minDeposit} max={treasury.maxDeposit} step="0.01" value={amount} onChange={e => { setAmount(e.target.value); setError(null); }} placeholder="0.00" data-testid="input-deposit-amount" aria-invalid={!!error} aria-describedby={error ? 'deposit-error' : undefined} /><FieldError id="deposit-error" message={error ?? undefined} /></div>
      <div className="field"><span className="field-label">Method</span><div className="stack" style={{ gap: 8 }}>{DEPOSIT_METHODS.map(m => <label key={m.id} className={`payout-method ${methodId === m.id ? 'active' : ''}`}><input type="radio" name="deposit-method" checked={methodId === m.id} onChange={() => setMethodId(m.id)} data-testid={`radio-deposit-${m.id}`} /><div className="payout-icon">{m.id === 'bank' ? <Landmark size={15} /> : <Banknote size={15} />}</div><div className="payout-copy"><strong>{m.name}</strong><span>{m.timing}</span></div><ChevronDown size={14} color="hsl(var(--muted))" /></label>)}</div></div>
      <div className="form-actions"><span className="muted" style={{ fontSize: 11, alignSelf: 'center' }}>You'll get a reference to include with your transfer.</span><button className="btn btn-primary" onClick={submit} data-testid="button-submit-deposit">Get payment reference <ArrowRight size={15} /></button></div>
      {justCreated && <div className="card mt" style={{ padding: 16, background: 'hsl(var(--background))' }} data-testid="panel-deposit-instructions"><strong style={{ fontSize: 13 }}>Send {money(justCreated.amount)} to:</strong><div className="fee-row"><span>Pay to</span><strong>{method.payTo}</strong></div><div className="fee-row"><span>Reference</span><strong className="mono" data-testid="text-deposit-reference">{justCreated.reference}</strong></div><p className="field-hint">Include the reference exactly, or finance can't match your transfer. {method.timing}.</p></div>}
    </div>
    <aside className="card card-pad"><div className="section-head"><div><h2 className="section-title">Deposit balance</h2><p className="section-subtitle">Confirmed funds only.</p></div></div><div className="fee-row"><span>Available</span><strong data-testid="text-deposit-balance">{money(balances.deposit)}</strong></div><div className="fee-row"><span>Awaiting confirmation</span><strong>{money(balances.pendingDeposits)}</strong></div><div className="fee-row"><span>Required reserve</span><strong>{money(treasury.depositThreshold)}</strong></div><p className="field-hint" style={{ marginTop: 15 }}>The reserve must stay in your deposit balance to request payouts or a physical card.</p></aside></div>
    <section className="card card-pad"><div className="section-head"><div><h2 className="section-title">Your deposits</h2><p className="section-subtitle">Cancel a deposit if you decide not to send it.</p></div></div><TransactionTable rows={deposits} action={tx => <CancelButton tx={tx} onCancel={cancel} label="Cancel" />} /></section>
  </div>;
}
function IdentityCheck({ onToast }: { onToast: Toast }) {
  const { state, run } = useDemoStore();
  const kyc = accountOf(state, CURRENT_APPLICANT_ID).kyc;
  const [form, setForm] = useState<KycInput>({ documentType: 'Passport', documentNumber: '', nameOnDocument: state.profile.name });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const canSubmit = kyc.status === 'Not submitted' || kyc.status === 'Rejected';
  const submit = () => {
    const result = run(s => submitKyc(s, form, new Date()));
    if (!result.ok) { setErrors(result.fieldErrors ?? {}); if (!result.fieldErrors) onToast(result.error); return; }
    setErrors({}); setForm(f => ({ ...f, documentNumber: '' })); onToast(result.message);
  };
  const tone = kyc.status === 'Verified' ? 'Completed' : kyc.status === 'Pending' ? 'Pending' : kyc.status === 'Rejected' ? 'Failed' : 'Draft';
  return <div className="verification-item" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }} data-testid="section-identity-check"><div className="verification-icon"><Check size={15} /></div><div className="verification-copy" style={{ flex: '1 1 240px' }}><strong>Identity verification</strong>
    <span>{kyc.status === 'Verified' ? `Verified${kyc.documentType ? ` with ${kyc.documentType.toLowerCase()} ending ${kyc.documentLast4}` : ''}.` : kyc.status === 'Pending' ? `Submitted ${kyc.submittedAt ? fmtDate(kyc.submittedAt) : ''} · waiting for the compliance team.` : kyc.status === 'Rejected' ? `Not approved: ${kyc.rejectionReason}` : kyc.rejectionReason ? `Please verify again: ${kyc.rejectionReason}` : 'Required before you can apply for grants.'}</span>
    {canSubmit && <div className="field-grid" style={{ marginTop: 12 }}>
      <div className="field"><label className="field-label" htmlFor="kyc-type">Document</label><select id="kyc-type" className="select" value={form.documentType} onChange={e => setForm({ ...form, documentType: e.target.value as KycDocumentType })} data-testid="select-kyc-document">{KYC_DOCUMENT_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
      <div className="field"><label className="field-label" htmlFor="kyc-number">Document number</label><input id="kyc-number" className="input" value={form.documentNumber} onChange={e => { setForm({ ...form, documentNumber: e.target.value }); setErrors(({ documentNumber: _, ...rest }) => rest); }} autoComplete="off" data-testid="input-kyc-number" aria-invalid={!!errors.documentNumber} aria-describedby={errors.documentNumber ? 'kyc-number-error' : undefined} />{errors.documentNumber ? <FieldError id="kyc-number-error" message={errors.documentNumber} /> : <span className="field-hint">Only the last four characters are kept.</span>}</div>
      <div className="field field-full"><label className="field-label" htmlFor="kyc-name">Name exactly as on the document</label><input id="kyc-name" className="input" value={form.nameOnDocument} onChange={e => { setForm({ ...form, nameOnDocument: e.target.value }); setErrors(({ nameOnDocument: _, ...rest }) => rest); }} data-testid="input-kyc-name" aria-invalid={!!errors.nameOnDocument} aria-describedby={errors.nameOnDocument ? 'kyc-name-error' : undefined} /><FieldError id="kyc-name-error" message={errors.nameOnDocument} /></div>
      <div className="field-full" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><span className="field-hint">Demo: no document image is uploaded or checked.</span><button className="btn btn-primary" onClick={submit} data-testid="button-submit-kyc">Submit for review</button></div>
    </div>}
  </div><StatusBadge status={kyc.status} tone={tone} /></div>;
}
function PayoutDestinationsCard({ onToast }: { onToast: Toast }) {
  const { state, run } = useDemoStore();
  const [editing, setEditing] = useState<ChannelId | null>(null);
  const [input, setInput] = useState<DestinationInput>({ primary: '', secondary: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const open = (id: ChannelId) => { setEditing(id); setInput({ primary: '', secondary: '' }); setErrors({}); };
  const save = () => {
    if (!editing) return;
    const result = run(s => savePayoutDestination(s, editing, input, new Date()));
    if (!result.ok) { setErrors(result.fieldErrors ?? {}); if (!result.fieldErrors) onToast(result.error); return; }
    setEditing(null); onToast(result.message);
  };
  const remove = (id: ChannelId) => { const result = run(s => removePayoutDestination(s, id)); onToast(result.ok ? result.message : result.error); };
  return <div className="card card-pad" id="payouts" data-testid="section-payout-destinations"><div className="section-head"><div><h2 className="section-title">Payout destinations</h2><p className="section-subtitle">Where payouts go for each channel. Only a masked label is kept. Changing a destination is reviewed by the team for your security.</p></div><Landmark size={19} color="hsl(var(--muted))" /></div>
    {state.treasury.channels.map(c => { const saved = state.payoutDestinations[c.id]; return <div key={c.id} className="verification-item" style={{ flexWrap: 'wrap' }} data-testid={`row-destination-${c.id}`}>
      <div className="verification-icon">{c.id === 'bank' || c.id === 'wire' ? <Landmark size={15} /> : <Banknote size={15} />}</div>
      <div className="verification-copy" style={{ flex: '1 1 200px' }}><strong>{c.name}{!c.enabled && <span className="muted" style={{ fontWeight: 500 }}> · not offered right now</span>}</strong><span>{saved ?? 'Not set'}</span></div>
      <div style={{ display: 'flex', gap: 6 }}><button className="btn btn-ghost" onClick={() => editing === c.id ? setEditing(null) : open(c.id)} data-testid={`button-edit-destination-${c.id}`}>{editing === c.id ? 'Cancel' : saved ? 'Change' : 'Add'}</button>{saved && editing !== c.id && <button className="icon-btn" onClick={() => remove(c.id)} aria-label={`Remove ${c.name} destination`} data-testid={`button-remove-destination-${c.id}`}><Trash2 size={14} /></button>}</div>
      {editing === c.id && <div className="field-grid" style={{ flexBasis: '100%', marginTop: 10 }}>
        {DESTINATION_FIELDS[c.id].map(f => { const id = `dest-${c.id}-${f.key}`; return <div className="field" key={f.key}><label className="field-label" htmlFor={id}>{f.label}</label><input id={id} className="input" autoComplete="off" placeholder={f.placeholder} value={input[f.key] ?? ''} onChange={e => { setInput({ ...input, [f.key]: e.target.value }); setErrors(({ [f.key]: _, ...rest }) => rest); }} data-testid={`input-destination-${c.id}-${f.key}`} aria-invalid={!!errors[f.key]} aria-describedby={errors[f.key] ? `${id}-error` : undefined} /><FieldError id={`${id}-error`} message={errors[f.key]} /></div>; })}
        <div className="field-full" style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-primary" onClick={save} data-testid={`button-save-destination-${c.id}`}>Save destination</button></div>
      </div>}
    </div>; })}
  </div>;
}
function SettingsPage({ onToast }: { onToast: Toast }) {
  const { state, run, reset } = useDemoStore();
  const { profile } = state;
  const account = accountOf(state, CURRENT_APPLICANT_ID);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProfileInput>(profile);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => { if (window.location.hash === '#payouts') document.getElementById('payouts')?.scrollIntoView(); }, []);
  const startEdit = () => { setDraft({ name: profile.name, email: profile.email, phone: profile.phone, address: profile.address }); setErrors({}); setEditing(true); };
  const save = () => {
    const result = run(s => updateProfile(s, draft));
    if (!result.ok) { setErrors(result.fieldErrors ?? {}); return; }
    setEditing(false); onToast(result.message);
  };
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const complete = (kind: 'password' | 'twoFactor') => { const r = run(s => completeCredentialReset(s, kind)); onToast(r.ok ? r.message : r.error); };
  const shown = editing ? draft : profile;
  const field = (key: keyof ProfileInput, label: string) => <div className="field"><label className="field-label" htmlFor={`profile-${key}`}>{label}</label><input id={`profile-${key}`} className="input" disabled={!editing} value={shown[key]} onChange={e => { setDraft({ ...draft, [key]: e.target.value }); setErrors(({ [key]: _, ...rest }) => rest); }} data-testid={`input-profile-${key}`} aria-invalid={!!errors[key]} aria-describedby={errors[key] ? `profile-${key}-error` : undefined} /><FieldError id={`profile-${key}-error`} message={errors[key]} /></div>;
  return <div className="detail-layout settings-layout"><aside className="card card-pad"><div className="section-head"><div><h2 className="section-title">Account settings</h2><p className="section-subtitle">Your profile and security controls.</p></div></div><div className="settings-nav"><button onClick={() => jump('profile')} data-testid="tab-settings-profile">Profile details</button><button onClick={() => jump('verification')} data-testid="tab-settings-verification">Verification & security</button><button onClick={() => jump('payouts')} data-testid="tab-settings-payouts">Payout destinations</button><button onClick={() => jump('demo-data')} data-testid="tab-settings-demo">Demo data</button></div></aside><div className="stack">
    <div className="card card-pad" id="profile"><div className="section-head"><div><h2 className="section-title">Profile details</h2><p className="section-subtitle">Keep your contact details current.</p></div><button className="btn btn-ghost" onClick={() => editing ? setEditing(false) : startEdit()} data-testid="button-edit-profile">{editing ? 'Cancel' : 'Edit profile'}</button></div><div className="field-grid">{field('name', 'Full name')}{field('email', 'Email')}{field('phone', 'Phone')}{field('address', 'Address')}</div>{editing && <div className="form-actions"><span className="muted" style={{ fontSize: 11 }}>Saved in this browser only.</span><button className="btn btn-primary" onClick={save} data-testid="button-save-profile">Save changes</button></div>}</div>
    <div className="card card-pad" id="verification"><div className="section-head"><div><h2 className="section-title">Verification & security</h2><p className="section-subtitle">The signals behind your Tier {profile.tier} account.</p></div><BadgeCheck size={21} color="hsl(var(--success))" /></div>
      <IdentityCheck onToast={onToast} />
      <div className="verification-item"><div className="verification-icon"><ShieldCheck size={15} /></div><div className="verification-copy"><strong>Account tier</strong><span>Tier {profile.tier} · sets which grants you can apply for. The grant team changes tiers after review.</span></div><span style={{ font: '700 12px var(--app-font-display)' }}>Tier {profile.tier}</span></div>
      <div className="verification-item"><div className="verification-icon"><LockKeyhole size={15} /></div><div className="verification-copy"><strong>Two-step sign-in</strong><span>{account.twoFactorResetRequired ? 'The team reset this. Set it up again.' : 'Preference only until sign-in is connected'}</span></div>{account.twoFactorResetRequired ? <button className="btn btn-ghost" onClick={() => complete('twoFactor')} data-testid="button-complete-2fa-reset">Set up again</button> : <button className={`switch ${profile.twoFactor ? 'on' : ''}`} role="switch" aria-checked={profile.twoFactor} onClick={() => { const r = run(s => setTwoFactor(s, !profile.twoFactor)); if (r.ok) onToast(r.message); }} aria-label="Toggle two-step sign-in" data-testid="button-toggle-two-factor" />}</div>
      {account.passwordResetRequired && <div className="verification-item" data-testid="row-password-reset"><div className="verification-icon"><LockKeyhole size={15} /></div><div className="verification-copy"><strong>New password required</strong><span>Requested by the grant team. Sign-in isn't connected, so nothing is stored.</span></div><button className="btn btn-ghost" onClick={() => complete('password')} data-testid="button-complete-password-reset">I've reset it</button></div>}
    </div>
    <PayoutDestinationsCard onToast={onToast} />
    <div className="card card-pad" id="demo-data"><div className="section-head"><div><h2 className="section-title">Demo data</h2><p className="section-subtitle">Applications, payouts, card changes, and profile edits are stored in this browser. Resetting also clears the staff audit log and settings.</p></div><RotateCcw size={19} color="hsl(var(--muted))" /></div><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{confirmReset ? <><button className="btn btn-dark" onClick={() => { reset(); setConfirmReset(false); setEditing(false); onToast('Demo data reset to the original sample records.'); }} data-testid="button-confirm-reset-demo">Yes, reset everything</button><button className="btn btn-ghost" onClick={() => setConfirmReset(false)} data-testid="button-cancel-reset-demo">Keep my changes</button></> : <button className="btn btn-ghost" onClick={() => setConfirmReset(true)} data-testid="button-reset-demo">Reset demo data</button>}</div></div>
  </div></div>;
}

function RouterView({ onToast }: { onToast: Toast }) {
  const [location] = useLocation();
  useEffect(() => {
    const titles: Record<string, string> = {
      '/': 'Dashboard', '/dashboard': 'Dashboard', '/grants': 'Grant categories',
      '/applications': 'Applications', '/cards': 'Cards', '/transactions': 'Transactions',
      '/withdrawals': 'Withdrawals', '/deposits': 'Add funds', '/settings': 'Settings',
      '/login': 'Sign in', '/signup': 'Create an account', '/forgot-password': 'Reset password', '/reset-password': 'Choose a new password',
      '/admin': 'Admin overview', '/admin/login': 'Staff sign-in', '/admin/reset-password': 'Reset staff password', '/admin/applicants': 'Admin applicants',
      '/admin/inbox': 'Admin email inbox',
      '/admin/applications': 'Admin applications', '/admin/payouts': 'Admin payouts', '/admin/deposits': 'Admin deposits', '/admin/grants': 'Admin grants', '/admin/security': 'Admin security', '/admin/audit': 'Admin audit log',
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
    <Route path="/reset-password"><ResetPasswordPage /></Route>
    <Route path="/admin/login"><AdminLoginPage /></Route>
    <Route path="/admin/reset-password"><AdminResetPasswordPage /></Route>
    <Route path="/admin"><AdminPage section="overview" /></Route>
    <Route path="/admin/applicants"><AdminPage section="applicants" /></Route>
    <Route path="/admin/inbox"><AdminPage section="inbox" /></Route>
    <Route path="/admin/applications"><AdminPage section="applications" /></Route>
    <Route path="/admin/payouts"><AdminPage section="payouts" /></Route>
    <Route path="/admin/deposits"><AdminPage section="deposits" /></Route>
    <Route path="/admin/grants"><AdminPage section="grants" /></Route>
    <Route path="/admin/security"><AdminPage section="security" /></Route>
    <Route path="/admin/audit"><AdminPage section="audit" /></Route>
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
    <Route path="/deposits"><Shell><DepositsPage onToast={onToast} /></Shell></Route>
    <Route path="/settings"><Shell><SettingsPage onToast={onToast} /></Shell></Route>
    <Route><NotFoundPage /></Route>
  </Switch>;
}
function App() {
  const [toast, setToast] = useState<string | null>(null);
  const onToast = (message: string) => { setToast(message); window.setTimeout(() => setToast(current => current === message ? null : current), 4200); };
  return <DemoStoreProvider><SessionProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><RouterView onToast={onToast} />{toast && <DemoToast message={toast} onClose={() => setToast(null)} />}</WouterRouter></SessionProvider></DemoStoreProvider>;
}

export default App;
