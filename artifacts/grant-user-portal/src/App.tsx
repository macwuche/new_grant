import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Route, Router as WouterRouter, Switch, useLocation, useRoute } from 'wouter';
import {
  ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, BadgeCheck, Banknote, Bell,
  BriefcaseBusiness, Building2, Check, ChevronDown, CircleHelp, CreditCard,
  Download, FileCheck2, FileText, Home, Info, Landmark, LayoutGrid, LockKeyhole,
  MoreHorizontal, Plus, Search, Settings, ShieldCheck, SlidersHorizontal,
  Sparkles, Store, Upload, WalletCards, X, Zap,
} from 'lucide-react';
import { ForgotPasswordPage, LoginPage, NotFoundPage, SignUpPage } from './pages/AuthPages';
import { AdminPage } from './pages/AdminPage';

type Status = 'Submitted' | 'Under review' | 'Approved' | 'Draft' | 'Declined' | 'Pending' | 'Completed' | 'Failed';
type GrantCategory = { id: string; name: string; summary: string; maxFunding: number; deadline: string; minimumTier: string; requirements: string[]; icon: typeof BriefcaseBusiness };
type Application = { id: string; grantId: string; grantName: string; status: Status; requestedAmount: number; submittedAt: string; updatedAt: string };
type Transaction = { id: string; type: string; description: string; amount: number; status: Status; createdAt: string };
type CardData = { id: string; kind: string; status: string; lastFour: string; dailyLimit: number };
type PayoutMethod = { id: string; type: string; label: string };

const grants: GrantCategory[] = [
  { id: 'momentum', name: 'Business Momentum', summary: 'Working capital for small businesses ready for their next chapter.', maxFunding: 12500, deadline: 'Jun 28, 2025', minimumTier: 'Tier 2', requirements: ['Business registration number', '90-day bank statement', 'A short use-of-funds plan'], icon: Store },
  { id: 'green', name: 'Green Transition', summary: 'Support for practical energy upgrades that reduce operating costs.', maxFunding: 18000, deadline: 'Jul 12, 2025', minimumTier: 'Tier 2', requirements: ['Project quote or estimate', 'Business registration number', 'Impact statement'], icon: Zap },
  { id: 'creative', name: 'Creative Practice', summary: 'Flexible funding for independent makers and creative studios.', maxFunding: 8500, deadline: 'Aug 04, 2025', minimumTier: 'Tier 1', requirements: ['Portfolio link', 'Project budget', 'Professional reference'], icon: Sparkles },
  { id: 'community', name: 'Community Roots', summary: 'Help local organizations build more resilient neighborhoods.', maxFunding: 22000, deadline: 'Aug 22, 2025', minimumTier: 'Tier 3', requirements: ['Organization registration', 'Community plan', 'Annual operating budget'], icon: Building2 },
];
const initialApplications: Application[] = [
  { id: 'APP-2048', grantId: 'momentum', grantName: 'Business Momentum', status: 'Under review', requestedAmount: 7800, submittedAt: 'May 14, 2025', updatedAt: 'May 21, 2025' },
  { id: 'APP-1932', grantId: 'creative', grantName: 'Creative Practice', status: 'Approved', requestedAmount: 4200, submittedAt: 'Apr 26, 2025', updatedAt: 'May 09, 2025' },
  { id: 'DRAFT-771', grantId: 'green', grantName: 'Green Transition', status: 'Draft', requestedAmount: 12000, submittedAt: 'Not submitted', updatedAt: 'May 19, 2025' },
];
const transactions: Transaction[] = [
  { id: 'TX-84019', type: 'Grant', description: 'Creative Practice award', amount: 4200, status: 'Completed', createdAt: 'May 09, 2025' },
  { id: 'TX-84002', type: 'Deposit', description: 'Demo account funding', amount: 450, status: 'Completed', createdAt: 'May 06, 2025' },
  { id: 'TX-83984', type: 'Card fee', description: 'Virtual card issuance', amount: -8.5, status: 'Completed', createdAt: 'Apr 30, 2025' },
  { id: 'TX-83971', type: 'Withdrawal', description: 'Demo payout request', amount: -125, status: 'Pending', createdAt: 'Apr 27, 2025' },
  { id: 'TX-83954', type: 'Grant', description: 'Business Momentum application', amount: 7800, status: 'Under review', createdAt: 'Apr 26, 2025' },
];
const cards: CardData[] = [
  { id: 'card-01', kind: 'Virtual card', status: 'Active', lastFour: '4826', dailyLimit: 1500 },
  { id: 'card-02', kind: 'Physical card', status: 'Not requested', lastFour: '—', dailyLimit: 2500 },
];
const payoutMethods: PayoutMethod[] = [
  { id: 'bank', type: 'Bank transfer', label: '•••• 0842 · Meridian checking' },
  { id: 'mobile', type: 'Mobile money', label: '+1 (415) 555-0148' },
];
const money = (amount: number) => `${amount < 0 ? '−' : ''}$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const statusClass = (status: string) => `status status-${status.toLowerCase().replace(' ', '-')}`;
const initials = 'AM';

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
  const active = (href: string) => href === '/' ? location === '/' : location.startsWith(href);
  return <div className="app-shell">
    <aside className="sidebar">
      <Logo />
      <div className="nav-label">Your workspace</div>
      <nav className="nav-list">{navItems.map(item => <Link key={item.href} href={item.href} className={`nav-link ${active(item.href) ? 'active' : ''}`} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}><span className="nav-icon"><Icon item={item.icon} /></span>{item.label}</Link>)}</nav>
      <div className="sidebar-bottom">
        <div className="demo-note"><strong>Illustrative workspace</strong><span>Records and balances are demo-only. Nothing here moves real money or submits an application.</span></div>
        <div className="user-mini"><div className="avatar">{initials}</div><div className="user-mini-text"><div className="user-mini-name">Alex Morgan</div><div className="user-mini-email">alex.morgan@example.com</div></div><MoreHorizontal size={16} color="#858990" /></div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div className="topbar-left"><div className="mobile-brand"><div className="brand-mark">a</div><div className="brand-name">arc<span>.</span>fund</div></div><div><p className="eyebrow">Applicant workspace</p><h1 className="page-title">{pageTitle(location)}</h1></div></div>
        <div className="top-actions"><button className="icon-btn" aria-label="Help" data-testid="button-help"><CircleHelp size={17} /></button><button className="icon-btn" aria-label="Notifications" data-testid="button-notifications"><Bell size={17} /><span className="notif-dot" /></button><Link href="/login" className="top-avatar" aria-label="Preview sign-in screen" title="Preview sign-in screen" data-testid="link-preview-login">{initials}</Link></div>
      </header>
      <div className="mobile-demo-note" role="note">DEMO ONLY · Records, balances, and actions are illustrative. Nothing is sent or charged.</div>
      <div className="page-wrap">{children}</div>
      <nav className="mobile-nav">{navItems.slice(0, 5).map(item => <Link key={item.href} href={item.href} className={active(item.href) ? 'active' : ''} data-testid={`mobile-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}><Icon item={item.icon} /><span>{item.label === 'Grant categories' ? 'Grants' : item.label === 'Transactions' ? 'Activity' : item.label}</span></Link>)}</nav>
    </main>
  </div>;
}
function pageTitle(location: string) {
  if (location === '/' || location === '/dashboard') return 'Good morning, Alex';
  if (location.startsWith('/grants')) return 'Grant categories';
  if (location.startsWith('/applications/new')) return 'New application';
  if (location.startsWith('/applications')) return 'Applications';
  if (location.startsWith('/cards')) return 'Cards';
  if (location.startsWith('/transactions')) return 'Transactions';
  if (location.startsWith('/withdrawals')) return 'Withdrawals';
  return 'Settings';
}
function DemoToast({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="toast" role="status" data-testid="status-demo-toast"><Info size={17} color="hsl(74 88% 58%)" /><div><strong>Demo response</strong><span>{message}</span></div><button onClick={onClose} aria-label="Close message" data-testid="button-close-toast"><X size={15} /></button></div>;
}
function Metric({ label, value, helper, className = '' }: { label: string; value: string; helper: string; className?: string }) {
  return <div className={`card metric-card ${className}`} data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}><div className="metric-label"><span>{label}</span><Info size={14} /></div><div className="metric-value">{value}</div><div className="metric-helper">{helper}</div>{className && <span className="metric-orb" />}</div>;
}
function StatusBadge({ status }: { status: string }) { return <span className={statusClass(status)} data-testid={`status-${status.toLowerCase().replaceAll(' ', '-')}`}>{status}</span>; }
function Dashboard({ onToast }: { onToast: (message: string) => void }) {
  return <div className="stack">
    <section className="hero-card card"><div className="hero-copy"><div className="kicker">A clearer way forward</div><h2>Keep your next move well funded.</h2><p>Track grant decisions, understand your available funds, and keep every account detail in one calm workspace.</p><Link className="btn btn-primary" href="/grants" style={{ marginTop: 22 }} data-testid="link-explore-grants">Explore grants <ArrowRight size={15} /></Link></div><div className="hero-visual"><div className="hero-stamp">YOUR<br />MOMENTUM<br />MATTERS</div></div></section>
    <section className="grid-4"><Metric label="Eligible amount" value="$18,500" helper="Based on Tier 2 profile" className="lime" /><Metric label="Grant balance" value="$4,200" helper="One approved award" className="dark" /><Metric label="Deposit balance" value="$450.00" helper="Illustrative demo balance" /><Metric label="Account tier" value="Tier 2" helper="Verified applicant" /></section>
    <section className="grid-2">
      <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Application pulse</h2><p className="section-subtitle">A quick view of your active grant work.</p></div><Link className="link-text" href="/applications" data-testid="link-view-applications">View all</Link></div><div className="timeline"><TimelineRow title="Business Momentum" text="Your documents are being reviewed by the grant team." status="Under review" current /><TimelineRow title="Creative Practice" text="Award approved. Balance added May 09, 2025." status="Approved" done /><TimelineRow title="Green Transition" text="Continue where you left off when ready." status="Draft" /></div></div>
      <div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Your active card</h2><p className="section-subtitle">Ready for everyday spending.</p></div><Link className="link-text" href="/cards" data-testid="link-view-cards">Manage</Link></div><CardVisual card={cards[0]} /><div className="quick-actions mt"><Link className="quick-action" href="/withdrawals" data-testid="link-quick-withdraw"><span className="action-icon"><ArrowUpRight size={15} /></span>Request payout</Link><button className="quick-action" onClick={() => onToast('This is a demo action. No funds were deposited.')} data-testid="button-quick-deposit"><span className="action-icon"><ArrowDownLeft size={15} /></span>Add funds</button></div></div>
    </section>
    <section className="card card-pad"><div className="section-head"><div><h2 className="section-title">Recent activity</h2><p className="section-subtitle">Illustrative records from your demo account.</p></div><Link className="link-text" href="/transactions" data-testid="link-view-transactions">See activity</Link></div><TransactionTable rows={transactions.slice(0, 3)} /></section>
  </div>;
}
function TimelineRow({ title, text, status, current, done }: { title: string; text: string; status?: string; current?: boolean; done?: boolean }) {
  return <div className="timeline-item"><div className={`timeline-dot ${current ? 'current' : done ? 'done' : ''}`} /><div style={{ flex: 1 }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}><h4>{title}</h4>{status && <StatusBadge status={status} />}</div><p>{text}</p></div></div>;
}
function CardVisual({ card, revealed = false }: { card: CardData; revealed?: boolean }) {
  return <div className={`card-visual ${card.kind === 'Physical card' ? 'lime-card' : ''}`} data-testid={`card-visual-${card.id}`}><div className="card-visual-top"><span style={{ font: '700 11px var(--app-font-display)' }}>arc.fund</span><div className="card-chip" /></div><div className="card-number">{card.lastFour === '—' ? 'NOT REQUESTED' : `••••  ••••  ••••  ${revealed ? card.lastFour : '••••'}`}</div><div className="card-footer"><div><div className="card-holder">Cardholder</div><div className="card-name">ALEX MORGAN</div></div><div className="card-network">arc</div></div></div>;
}
function GrantCard({ grant, onToast }: { grant: GrantCategory; onToast: (message: string) => void }) {
  const GrantIcon = grant.icon;
  return <div className="card grant-card" data-testid={`grant-card-${grant.id}`}><div className="grant-top"><div className="grant-symbol"><GrantIcon size={19} /></div><span className="status status-complete">Open</span></div><h3>{grant.name}</h3><p>{grant.summary}</p><div className="grant-meta"><div className="grant-meta-item"><span className="grant-meta-label">Up to</span><span className="grant-meta-value">{money(grant.maxFunding)}</span></div><div className="grant-meta-item"><span className="grant-meta-label">Deadline</span><span className="grant-meta-value">{grant.deadline}</span></div></div><div style={{ display: 'flex', gap: 8 }}><Link className="btn btn-dark" style={{ flex: 1 }} href={`/applications/new/${grant.id}`} data-testid={`link-apply-${grant.id}`}>Check eligibility <ArrowRight size={14} /></Link><button className="icon-btn" onClick={() => onToast(`${grant.name} requires ${grant.minimumTier}. Your demo account is ${grant.minimumTier === 'Tier 3' ? 'not yet' : 'currently'} eligible.`)} aria-label={`View ${grant.name} details`} data-testid={`button-details-${grant.id}`}><Info size={15} /></button></div></div>;
}
function GrantsPage({ onToast }: { onToast: (message: string) => void }) {
  const [filter, setFilter] = useState('All');
  const filtered = filter === 'All' ? grants : grants.filter(g => g.minimumTier === filter);
  return <div className="stack"><div className="page-intro"><h2>Find the right kind of support.</h2><p>Explore illustrative grant programs designed for individuals, makers, and small businesses. Check the requirements before starting an application.</p></div><section className="eligibility-box"><div className="eligibility-copy"><h3>Your eligibility snapshot</h3><p>Based on your verified Tier 2 profile and current account details.</p></div><div className="eligibility-result"><strong>$18,500</strong><span>maximum across open categories</span></div></section><section className="card card-pad"><div className="toolbar"><div><h2 className="section-title">Open categories</h2><p className="section-subtitle">Deadlines and amounts are examples for this demo.</p></div><div className="tabs">{['All', 'Tier 1', 'Tier 2', 'Tier 3'].map(t => <button key={t} className={`tab ${filter === t ? 'active' : ''}`} onClick={() => setFilter(t)} data-testid={`tab-grants-${t.toLowerCase().replace(' ', '-')}`}>{t}</button>)}</div></div><div className="grid-2" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>{filtered.map(g => <GrantCard key={g.id} grant={g} onToast={onToast} />)}</div></section></div>;
}
function ApplicationsPage({ applications, onToast }: { applications: Application[]; onToast: (message: string) => void }) {
  const [filter, setFilter] = useState('All');
  const filtered = filter === 'All' ? applications : applications.filter(a => a.status === filter);
  return <div className="stack"><div className="page-intro"><h2>Your applications, in plain view.</h2><p>See what needs your attention, what is being reviewed, and where a decision has been made.</p></div><div className="card card-pad"><div className="toolbar"><div className="tabs">{['All', 'Under review', 'Approved', 'Draft'].map(t => <button key={t} className={`tab ${filter === t ? 'active' : ''}`} onClick={() => setFilter(t)} data-testid={`tab-applications-${t.toLowerCase().replace(' ', '-')}`}>{t}</button>)}</div><Link className="btn btn-primary" href="/grants" data-testid="link-start-application"><Plus size={15} /> Start an application</Link></div>{filtered.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Application</th><th>Status</th><th>Requested</th><th>Last updated</th><th /></tr></thead><tbody>{filtered.map(app => <tr key={app.id} data-testid={`row-application-${app.id}`}><td><div className="primary-cell">{app.grantName}</div><div className="secondary-cell mono">{app.id} · submitted {app.submittedAt}</div></td><td><StatusBadge status={app.status} /></td><td className="amount">{money(app.requestedAmount)}</td><td className="muted">{app.updatedAt}</td><td><button className="icon-btn" onClick={() => onToast(app.status === 'Draft' ? 'Demo draft opened. Nothing was saved.' : 'This is a demo record. Application details are read-only for now.')} aria-label={`Open ${app.grantName}`} data-testid={`button-open-application-${app.id}`}><ArrowRight size={15} /></button></td></tr>)}</tbody></table></div> : <div className="empty-state"><div className="empty-icon"><FileText size={20} /></div><h3>No applications in this view</h3><p>Try another status filter or browse the grant categories to begin.</p><Link className="btn btn-primary" href="/grants" data-testid="link-empty-browse-grants">Browse grants</Link></div>}</div></div>;
}
function ApplicationForm({ onToast }: { onToast: (message: string) => void }) {
  const [, params] = useRoute('/applications/new/:grantId');
  const grant = grants.find(g => g.id === params?.grantId) ?? grants[0];
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({ business: '', amount: '7800', purpose: '', registration: '' });
  const setField = (key: keyof typeof form, value: string) => setForm(v => ({ ...v, [key]: value }));
  const next = () => { if (step < 3) setStep(step + 1); else onToast('Demo submission preview complete. Nothing was submitted or persisted.'); };
  return <div className="detail-layout"><div className="card card-pad"><div className="page-intro" style={{ marginBottom: 18 }}><p className="eyebrow">Illustrative application</p><h2>{grant.name}</h2><p>Complete the steps below to preview what an application could look like. This flow does not upload or submit real information.</p></div><div className="stepper">{['Basics', 'Requirements', 'Review'].map((label, i) => <div className={`step ${step === i + 1 ? 'active' : ''} ${step > i + 1 ? 'complete' : ''}`} key={label}><span className="step-num">{step > i + 1 ? <Check size={12} /> : i + 1}</span><span className="step-label">{label}</span></div>)}</div>{step === 1 && <div className="field-grid"><div className="field field-full"><label className="field-label" htmlFor="business">Business or project name</label><input id="business" className="input" value={form.business} onChange={e => setField('business', e.target.value)} placeholder="e.g. Morgan Studio" data-testid="input-business-name" /><span className="field-hint">Use a working name for this demo.</span></div><div className="field"><label className="field-label" htmlFor="amount">Requested amount</label><input id="amount" className="input" type="number" value={form.amount} onChange={e => setField('amount', e.target.value)} data-testid="input-requested-amount" /></div><div className="field"><label className="field-label" htmlFor="registration">Registration number</label><input id="registration" className="input" value={form.registration} onChange={e => setField('registration', e.target.value)} placeholder="Optional demo value" data-testid="input-registration-number" /></div><div className="field field-full"><label className="field-label" htmlFor="purpose">What would this funding unlock?</label><textarea id="purpose" className="textarea" value={form.purpose} onChange={e => setField('purpose', e.target.value)} placeholder="Share a few sentences about your plan..." data-testid="textarea-funding-purpose" /></div></div>}{step === 2 && <div className="stack" style={{ gap: 13 }}><div className="notice"><Info size={16} />The following documents are illustrative requirements for {grant.name}. You can continue without uploading anything in this demo.</div>{grant.requirements.map((req, i) => <div className="upload" key={req}><div className="upload-icon"><Upload size={15} /></div><div className="upload-copy"><strong>{req}</strong><span>PDF, PNG or JPG · optional in demo</span></div><button className="btn btn-ghost" onClick={() => onToast('Demo upload area opened. No file was uploaded.')} data-testid={`button-upload-${i}`}>Choose file</button></div>)}</div>}{step === 3 && <div className="stack"><div className="notice"><ShieldCheck size={16} />Review your details before continuing. Your demo information stays in this browser session only.</div><div className="card" style={{ padding: 16, background: 'hsl(var(--background))' }}><div className="fee-row"><span>Grant category</span><strong>{grant.name}</strong></div><div className="fee-row"><span>Requested amount</span><strong>{money(Number(form.amount) || 0)}</strong></div><div className="fee-row"><span>Project or business</span><strong>{form.business || 'Not provided'}</strong></div><div className="fee-row"><span>Submission state</span><StatusBadge status="Draft" /></div></div><p className="muted" style={{ fontSize: 11 }}>Selecting “Preview submission” will only show a demo confirmation. It will not send, approve, or save an application.</p></div>}<div className="form-actions"><button className="btn btn-ghost" onClick={() => step > 1 ? setStep(step - 1) : onToast('Demo form closed. No draft was saved.')} data-testid="button-application-back">{step > 1 ? <><ArrowLeft size={15} /> Back</> : 'Cancel'}</button><button className="btn btn-primary" onClick={next} data-testid="button-application-next">{step === 3 ? 'Preview submission' : 'Continue'} <ArrowRight size={15} /></button></div></div><aside className="stack"><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Before you begin</h2><p className="section-subtitle">A few helpful details for this category.</p></div><FileCheck2 size={20} color="hsl(var(--lime-deep))" /></div><div className="timeline"><TimelineRow title={`Up to ${money(grant.maxFunding)}`} text="Maximum illustrative award amount." done /><TimelineRow title={`Minimum ${grant.minimumTier}`} text="Your demo account meets this tier." done /><TimelineRow title={grant.deadline} text="Example submission deadline." /></div></div><Link className="btn btn-ghost" href="/grants" data-testid="link-back-to-grants"><ArrowLeft size={15} /> Back to grant categories</Link></aside></div>;
}
function CardsPage({ onToast }: { onToast: (message: string) => void }) {
  const [revealed, setRevealed] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [requested, setRequested] = useState(false);
  return <div className="stack"><div className="page-intro"><h2>Spend with context.</h2><p>Your cards are visualized here for the demo. Card issuance, freezing, and PIN actions do not affect a real account.</p></div><section className="grid-2"><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Virtual card</h2><p className="section-subtitle">Available for illustrative spending.</p></div><StatusBadge status={frozen ? 'Pending' : 'Completed'} /></div><CardVisual card={cards[0]} revealed={revealed} /><div className="quick-actions mt"><button className="quick-action" onClick={() => setRevealed(v => !v)} data-testid="button-reveal-card"><span className="action-icon"><LockKeyhole size={15} /></span>{revealed ? 'Hide number' : 'Reveal number'}</button><button className="quick-action" onClick={() => { setFrozen(v => !v); onToast(`Demo card ${frozen ? 'unfrozen' : 'frozen'}. No real card changed.`); }} data-testid="button-freeze-card"><span className="action-icon"><ShieldCheck size={15} /></span>{frozen ? 'Unfreeze card' : 'Freeze card'}</button></div></div><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Physical card</h2><p className="section-subtitle">A physical card can be requested in a later phase.</p></div><CreditCard size={19} color="hsl(var(--muted))" /></div><div className="card-visual lime-card"><div className="card-visual-top"><span style={{ font: '700 11px var(--app-font-display)' }}>arc.fund</span><div className="card-chip" /></div><div className="card-number">NOT REQUESTED</div><div className="card-footer"><div><div className="card-holder">Cardholder</div><div className="card-name">ALEX MORGAN</div></div><div className="card-network">arc</div></div></div><div style={{ marginTop: 16 }}><div className="fee-row"><span>Illustrative issuance fee</span><strong>$8.50</strong></div><button className="btn btn-dark" style={{ width: '100%', marginTop: 12 }} onClick={() => { setRequested(true); onToast('Demo request received. No card was ordered and no fee was charged.'); }} data-testid="button-request-physical-card">{requested ? 'Demo request noted' : 'Request physical card'}</button></div></div></section><section className="card card-pad"><div className="section-head"><div><h2 className="section-title">Card limits</h2><p className="section-subtitle">Illustrative controls for your account tier.</p></div></div><div className="grid-3"><Metric label="Daily card limit" value="$1,500" helper="Virtual card" /><Metric label="Deposit balance" value="$450.00" helper="Illustrative balance" /><Metric label="Card status" value={frozen ? 'Frozen' : 'Active'} helper="Demo state only" /></div></section></div>;
}
function TransactionTable({ rows }: { rows: Transaction[] }) {
  return <div className="table-wrap"><table className="data-table"><thead><tr><th>Activity</th><th>Type</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>{rows.map(tx => <tr key={tx.id} data-testid={`row-transaction-${tx.id}`}><td><div className="primary-cell">{tx.description}</div><div className="secondary-cell mono">{tx.id}</div></td><td className="muted">{tx.type}</td><td className={`amount ${tx.amount < 0 ? 'muted' : ''}`}>{money(tx.amount)}</td><td><StatusBadge status={tx.status} /></td><td className="muted">{tx.createdAt}</td></tr>)}</tbody></table></div>;
}
function TransactionsPage() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All');
  const filtered = useMemo(() => transactions.filter(t => (filter === 'All' || t.type === filter) && `${t.description} ${t.id}`.toLowerCase().includes(query.toLowerCase())), [query, filter]);
  return <div className="stack"><div className="page-intro"><h2>Every movement, easy to follow.</h2><p>Review illustrative grants, deposits, card fees, and payout requests in one activity ledger.</p></div><div className="card card-pad"><div className="toolbar"><div className="search-wrap"><Search size={16} /><input className="input" type="search" placeholder="Search activity" value={query} onChange={e => setQuery(e.target.value)} data-testid="input-search-transactions" /></div><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><SlidersHorizontal size={15} color="hsl(var(--muted))" /><select className="select" style={{ width: 145 }} value={filter} onChange={e => setFilter(e.target.value)} data-testid="select-transaction-filter"><option>All</option><option>Grant</option><option>Deposit</option><option>Withdrawal</option><option>Card fee</option></select><button className="btn btn-ghost" onClick={() => { const blob = new Blob(['Demo export only — no live records.'], { type: 'text/plain' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'arc-fund-demo-activity.txt'; a.click(); URL.revokeObjectURL(url); }} data-testid="button-export-transactions"><Download size={14} /> Export</button></div></div>{filtered.length ? <TransactionTable rows={filtered} /> : <div className="empty-state"><div className="empty-icon"><Search size={19} /></div><h3>No activity found</h3><p>Try a different search term or reset the activity filter.</p></div>}</div></div>;
}
function WithdrawalsPage({ onToast }: { onToast: (message: string) => void }) {
  const [method, setMethod] = useState('bank');
  const [amount, setAmount] = useState('125');
  const [showModal, setShowModal] = useState(false);
  const fee = Math.min(Number(amount) * .0125, 14);
  return <div className="detail-layout"><div className="stack"><div className="withdraw-summary"><div className="metric-label"><span>Available to request</span><WalletCards size={15} /></div><div className="metric-value">$4,200.00</div><div className="metric-helper">Grant balance · illustrative demo balance</div></div><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Request a payout</h2><p className="section-subtitle">Choose a destination and preview the fee breakdown.</p></div></div><div className="notice mb"><Info size={16} />This is a demo-only payout flow. It will not send money, contact a bank, or save a request.</div><div className="field mb"><label className="field-label" htmlFor="withdrawal-amount">Amount</label><input id="withdrawal-amount" type="number" className="input" value={amount} onChange={e => setAmount(e.target.value)} data-testid="input-withdrawal-amount" /><span className="field-hint">Available demo balance: $4,200.00</span></div><div className="field"><span className="field-label">Payout destination</span><div className="stack" style={{ gap: 8 }}>{payoutMethods.map(p => <label key={p.id} className={`payout-method ${method === p.id ? 'active' : ''}`}><input type="radio" name="payout" checked={method === p.id} onChange={() => setMethod(p.id)} data-testid={`radio-payout-${p.id}`} /><div className="payout-icon">{p.id === 'bank' ? <Landmark size={15} /> : <Banknote size={15} />}</div><div className="payout-copy"><strong>{p.type}</strong><span>{p.label}</span></div><ChevronDown size={14} color="hsl(var(--muted))" /></label>)}</div></div><div className="form-actions"><span className="muted" style={{ fontSize: 11, alignSelf: 'center' }}>No real payout will be created.</span><button className="btn btn-primary" onClick={() => setShowModal(true)} data-testid="button-preview-withdrawal">Preview request <ArrowRight size={15} /></button></div></div></div><aside className="card card-pad"><div className="section-head"><div><h2 className="section-title">Fee preview</h2><p className="section-subtitle">Transparent, illustrative breakdown.</p></div></div><div className="fee-row"><span>Requested amount</span><strong>{money(Number(amount) || 0)}</strong></div><div className="fee-row"><span>Demo processing fee</span><strong>{money(fee)}</strong></div><div className="fee-row"><span>Estimated total</span><strong>{money(Math.max(0, Number(amount) - fee))}</strong></div><p className="field-hint" style={{ marginTop: 15 }}>Actual payout methods and fees will be configured in a future phase.</p></aside>{showModal && <div className="modal-backdrop" role="dialog" aria-modal="true"><div className="modal"><div className="modal-head"><div><h2>Demo payout preview</h2><p>Review only. This action does not send or save funds.</p></div><button className="icon-btn" onClick={() => setShowModal(false)} aria-label="Close preview" data-testid="button-close-withdrawal-modal"><X size={16} /></button></div><div className="notice"><Check size={16} />Your demo request is formatted and ready for a future backend connection.</div><div className="fee-row"><span>Destination</span><strong>{payoutMethods.find(p => p.id === method)?.type}</strong></div><div className="fee-row"><span>Amount</span><strong>{money(Number(amount) || 0)}</strong></div><button className="btn btn-dark" style={{ width: '100%', marginTop: 18 }} onClick={() => { setShowModal(false); onToast('Demo payout preview closed. No request was sent or saved.'); }} data-testid="button-confirm-withdrawal-demo">Close demo preview</button></div></div>}</div>;
}
function SettingsPage({ onToast }: { onToast: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [profile, setProfile] = useState({ name: 'Alex Morgan', email: 'alex.morgan@example.com', phone: '+1 (415) 555-0148', address: '54 Valencia Street, San Francisco' });
  const [twoFactor, setTwoFactor] = useState(true);
  return <div className="detail-layout"><aside className="card card-pad"><div className="section-head"><div><h2 className="section-title">Account settings</h2><p className="section-subtitle">Your profile and security controls.</p></div></div><div className="settings-nav"><button className="active" data-testid="tab-settings-profile">Profile details</button><button onClick={() => onToast('Verification settings are shown on this page for the demo.')} data-testid="tab-settings-verification">Verification</button><button onClick={() => onToast('Notification preferences will be available in a later phase.')} data-testid="tab-settings-notifications">Notifications</button></div></aside><div className="stack"><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Profile details</h2><p className="section-subtitle">Keep your contact details current.</p></div><button className="btn btn-ghost" onClick={() => editing ? (setEditing(false), onToast('Demo profile changes are not saved.')) : setEditing(true)} data-testid="button-edit-profile">{editing ? 'Cancel' : 'Edit profile'}</button></div><div className="field-grid"><div className="field"><label className="field-label" htmlFor="profile-name">Full name</label><input id="profile-name" className="input" disabled={!editing} value={profile.name} onChange={e => setProfile({ ...profile, name: e.target.value })} data-testid="input-profile-name" /></div><div className="field"><label className="field-label" htmlFor="profile-email">Email</label><input id="profile-email" className="input" disabled={!editing} value={profile.email} onChange={e => setProfile({ ...profile, email: e.target.value })} data-testid="input-profile-email" /></div><div className="field"><label className="field-label" htmlFor="profile-phone">Phone</label><input id="profile-phone" className="input" disabled={!editing} value={profile.phone} onChange={e => setProfile({ ...profile, phone: e.target.value })} data-testid="input-profile-phone" /></div><div className="field"><label className="field-label" htmlFor="profile-address">Address</label><input id="profile-address" className="input" disabled={!editing} value={profile.address} onChange={e => setProfile({ ...profile, address: e.target.value })} data-testid="input-profile-address" /></div></div>{editing && <div className="form-actions"><span className="muted" style={{ fontSize: 11 }}>Demo mode: edits are not persisted.</span><button className="btn btn-primary" onClick={() => { setEditing(false); onToast('Demo profile preview updated. Nothing was saved.'); }} data-testid="button-save-profile">Preview changes</button></div>}</div><div className="card card-pad"><div className="section-head"><div><h2 className="section-title">Verification & security</h2><p className="section-subtitle">Understand the signals behind your Tier 2 account.</p></div><BadgeCheck size={21} color="hsl(var(--success))" /></div><div className="verification-item"><div className="verification-icon"><Check size={15} /></div><div className="verification-copy"><strong>Identity verification</strong><span>Verified · demo status</span></div><StatusBadge status="Completed" /></div><div className="verification-item"><div className="verification-icon"><ShieldCheck size={15} /></div><div className="verification-copy"><strong>Account tier</strong><span>Tier 2 · expanded grant eligibility</span></div><span style={{ font: '700 12px var(--app-font-display)' }}>Tier 2</span></div><div className="verification-item"><div className="verification-icon"><LockKeyhole size={15} /></div><div className="verification-copy"><strong>Two-step sign-in</strong><span>Extra protection for account access</span></div><button className={`switch ${twoFactor ? 'on' : ''}`} onClick={() => { setTwoFactor(v => !v); onToast(`Demo two-step sign-in ${twoFactor ? 'disabled' : 'enabled'}.`); }} aria-label="Toggle two-step sign-in" data-testid="button-toggle-two-factor" /></div></div><div className="notice"><Info size={16} />Profile verification is represented for demonstration only. Identity checks, authentication, and persistence arrive in a later phase.</div></div></div>;
}
function RouterView({ onToast, applications }: { onToast: (message: string) => void; applications: Application[] }) {
  const [location] = useLocation();
  useEffect(() => {
    const titles: Record<string, string> = {
      '/': 'Dashboard', '/dashboard': 'Dashboard', '/grants': 'Grant categories',
      '/applications': 'Applications', '/cards': 'Cards', '/transactions': 'Transactions',
      '/withdrawals': 'Withdrawals', '/settings': 'Settings',
      '/login': 'Sign in', '/signup': 'Create an account', '/forgot-password': 'Reset password',
      '/admin': 'Admin overview', '/admin/applicants': 'Admin applicants',
      '/admin/applications': 'Admin applications', '/admin/grants': 'Admin grants',
      '/admin/settings': 'Admin settings',
    };
    const title = titles[location] ?? (location.startsWith('/applications/new/') ? 'New application' : 'Page not found');
    const description = location.startsWith('/admin')
      ? 'Explore the arc.fund admin UI preview. Sample records only; admin access and changes are not active.'
      : 'Explore the arc.fund grant applicant workspace UI. This is an illustrative preview; sign-in and applications are not active.';
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
    <Route path="/admin/applications"><AdminPage section="applications" /></Route>
    <Route path="/admin/grants"><AdminPage section="grants" /></Route>
    <Route path="/admin/settings"><AdminPage section="settings" /></Route>
    <Route path="/"><Shell><Dashboard onToast={onToast} /></Shell></Route>
    <Route path="/dashboard"><Shell><Dashboard onToast={onToast} /></Shell></Route>
    <Route path="/grants"><Shell><GrantsPage onToast={onToast} /></Shell></Route>
    <Route path="/applications/new/:grantId"><Shell><ApplicationForm onToast={onToast} /></Shell></Route>
    <Route path="/applications"><Shell><ApplicationsPage applications={applications} onToast={onToast} /></Shell></Route>
    <Route path="/cards"><Shell><CardsPage onToast={onToast} /></Shell></Route>
    <Route path="/transactions"><Shell><TransactionsPage /></Shell></Route>
    <Route path="/withdrawals"><Shell><WithdrawalsPage onToast={onToast} /></Shell></Route>
    <Route path="/settings"><Shell><SettingsPage onToast={onToast} /></Shell></Route>
    <Route><NotFoundPage /></Route>
  </Switch>;
}
function App() {
  const [toast, setToast] = useState<string | null>(null);
  const [applications] = useState(initialApplications);
  const onToast = (message: string) => { setToast(message); window.setTimeout(() => setToast(null), 4200); };
  return <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><RouterView onToast={onToast} applications={applications} />{toast && <DemoToast message={toast} onClose={() => setToast(null)} />}</WouterRouter>;
}

export default App;
