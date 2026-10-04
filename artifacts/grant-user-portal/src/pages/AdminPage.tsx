import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppNameText, BrandLetter, Wordmark } from '@/lib/appName';
import { Link, useLocation } from 'wouter';
import {
  ArrowRight, Banknote, ClipboardList, FileText, FolderOpen,
  LayoutDashboard, Mail, Search, Settings2, ShieldAlert, ShieldCheck, Users,
} from 'lucide-react';
import { AdminInbox } from './AdminInbox';
import { AdminInboxLive } from './AdminInboxLive';
import { AdminSettings, findSettingsSection } from './AdminSettings';
import { AdminReviewPanel } from './AdminReviewPanel';
import { AdminPayouts } from './AdminPayouts';
import { AdminPrograms } from './AdminPrograms';
import { AdminDeposits } from './AdminDeposits';
import { AdminCards } from './AdminCards';
import { AdminApplicantProfile } from './AdminApplicantProfile';
import { AdminApplicants } from './AdminApplicants';
import { ActivityItem, AdminActivityMenu, useOpenActivity } from './AdminActivityMenu';
import { AdminApplicantPanel } from './AdminApplicantPanel';
import { AdminAudit } from './AdminAudit';
import { AdminSecurity } from './AdminSecurity';
import { StaffSwitcher } from './AdminStaff';
import { AdminGate, AdminSessionMenu } from './AdminLogin';
import { useSession } from '@/lib/session';
import { staffFeed } from '@workspace/domain/activity';
import { applicantRecords } from '@workspace/domain/applicants';
import { useServerData } from '@/lib/serverData';
import { assessRisk, type RiskAssessment } from '@workspace/domain/risk';
import { computeBalances } from '@workspace/domain/rules';
import { pendingDepositTotal } from '@workspace/domain/deposits';
import { pendingPayoutTotal } from '@workspace/domain/payouts';
import { findGrant } from '@workspace/domain/rules';
import { applicantName, awaitingAction, openEscalations, programBudget, reviewQueue } from '@workspace/domain/review';
import { useDemoStore } from '@/lib/store';
import type { Application as DomainApplication, DemoState } from '@workspace/domain/model';
import { format } from 'date-fns';
import './AdminPage.css';
import './AdminSecurity.css';

export type AdminSection = 'overview' | 'applicants' | 'applicant' | 'inbox' | 'applications' | 'payouts' | 'deposits' | 'cards' | 'grants' | 'security' | 'audit' | 'settings';
type Applicant = { id: string; name: string; email: string; sector: string; country: string; status: string; joined: string; applications: number; tier: number; kyc: string; locked: boolean; risk: RiskAssessment; wallet: number; activeGrants: number };
/** Queue row derived from the shared store. */
type Application = { id: string; title: string; applicant: string; amount: number; status: string; date: string; program: string; escalated: boolean };

const shortDate = (iso: string) => format(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso), 'dd MMM yyyy');

function toRow(state: DemoState, app: DomainApplication): Application {
  return { id: app.id, title: app.businessName, applicant: applicantName(state, app.applicantId), amount: app.requestedAmount, status: app.status, date: shortDate(app.submittedAt ?? app.updatedAt), program: findGrant(state, app.grantId)?.name ?? 'Unknown program', escalated: app.escalation?.status === 'Open' };
}
function useQueue(): Application[] {
  const { state } = useDemoStore();
  return reviewQueue(state).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(app => toRow(state, app));
}
function useApplicants(): Applicant[] {
  const { state } = useDemoStore();
  const now = new Date();
  return applicantRecords(state).map(p => {
    const apps = reviewQueue(state).filter(a => a.applicantId === p.id);
    const balances = computeBalances(state.transactions.filter(t => t.applicantId === p.id));
    return {
      id: p.id, name: p.name, email: p.email, sector: p.sector, country: p.country, status: p.identityVerified ? 'Verified' : 'Pending', joined: shortDate(p.joined),
      applications: apps.length, tier: p.tier, kyc: p.account.kyc.status, locked: p.account.status === 'Locked', risk: assessRisk(state, p.id, now),
      wallet: balances.grant + balances.deposit, activeGrants: apps.filter(a => a.status === 'Approved').length,
    };
  });
}

/** Deposits and cards live under Payments; the audit log under Security. */
const isActive = (current: AdminSection, item: AdminSection) => current === item || (item === 'applicants' && current === 'applicant') || (item === 'payouts' && (current === 'deposits' || current === 'cards')) || (item === 'security' && current === 'audit');
function PaymentsTabs({ tab }: { tab: 'payouts' | 'deposits' | 'cards' }) {
  return <nav className="admin-tabs" aria-label="Payments">
    <Link href="/admin/payouts" className={tab === 'payouts' ? 'active' : ''} aria-current={tab === 'payouts' ? 'page' : undefined} data-testid="tab-admin-payments-payouts">Payouts</Link>
    <Link href="/admin/deposits" className={tab === 'deposits' ? 'active' : ''} aria-current={tab === 'deposits' ? 'page' : undefined} data-testid="tab-admin-payments-deposits">Deposits</Link>
    <Link href="/admin/cards" className={tab === 'cards' ? 'active' : ''} aria-current={tab === 'cards' ? 'page' : undefined} data-testid="tab-admin-payments-cards">Cards</Link>
  </nav>;
}
function SecurityTabs({ tab }: { tab: 'security' | 'audit' }) {
  return <nav className="admin-tabs" aria-label="Security">
    <Link href="/admin/security" className={tab === 'security' ? 'active' : ''} aria-current={tab === 'security' ? 'page' : undefined} data-testid="tab-admin-security-risk">Risk & identity</Link>
    <Link href="/admin/audit" className={tab === 'audit' ? 'active' : ''} aria-current={tab === 'audit' ? 'page' : undefined} data-testid="tab-admin-security-audit">Audit log</Link>
  </nav>;
}
function RecentActivity() {
  const { state } = useDemoStore();
  const open = useOpenActivity();
  const items = staffFeed(state).slice(0, 5);
  return <section className="admin-panel" style={{ marginTop: 17 }} data-testid="panel-admin-recent-activity"><SectionHead title="Team activity" subtitle="Applicant actions that may need staff attention, newest first." />{items.length ? items.map(e => <ActivityItem key={e.id} event={e} onOpen={open} compact />) : <p className="admin-review-hint">No activity yet.</p>}</section>;
}

const money = (value: number) => `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const navItems = [
  { section: 'overview' as const, label: 'Overview', icon: LayoutDashboard, href: '/admin' },
  { section: 'applicants' as const, label: 'Users', icon: Users, href: '/admin/applicants' },
  { section: 'inbox' as const, label: 'Email inbox', icon: Mail, href: '/admin/inbox' },
  { section: 'applications' as const, label: 'Applications', icon: ClipboardList, href: '/admin/applications' },
  { section: 'payouts' as const, label: 'Payments', icon: Banknote, href: '/admin/payouts' },
  { section: 'grants' as const, label: 'Grant programs', icon: FolderOpen, href: '/admin/grants' },
  { section: 'security' as const, label: 'Security', icon: ShieldCheck, href: '/admin/security' },
  { section: 'settings' as const, label: 'Settings', icon: Settings2, href: '/admin/settings' },
];

function Badge({ status }: { status: string }) {
  return <span className={`admin-badge ${slug(status) === 'under-review' ? 'review' : slug(status)}`} data-testid={`status-admin-${slug(status)}`}>{status}</span>;
}

function SectionHead({ title, subtitle, href, link }: { title: string; subtitle: string; href?: string; link?: string }) {
  return <div className="admin-panel-head"><div><h2>{title}</h2><p>{subtitle}</p></div>{href && link && <Link href={href} className="admin-textlink" data-testid={`link-admin-${slug(link)}`} aria-label={`${link} ${title}`}>{link}<ArrowRight size={14} /></Link>}</div>;
}

function EmptyResults({ onReset }: { onReset: () => void }) {
  return <div className="admin-empty" data-testid="empty-admin-results"><Search size={25} /><h3>Nothing matches this view</h3><p>Try another search or remove the selected filter.</p><button type="button" onClick={onReset} data-testid="button-reset-admin-filters">Clear search and filter</button></div>;
}

const compact = (value: number) => value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${value.toFixed(2).replace(/\.00$/, '')}`;
const pad = (value: number) => String(value).padStart(2, '0');

function Overview({ openReview }: { openReview: (id: string) => void }) {
  const { state } = useDemoStore();
  const queue = reviewQueue(state);
  const waiting = awaitingAction(state);
  const applicants = useApplicants();
  const count = (status: string) => queue.filter(a => a.status === status).length;
  const awarded = state.transactions.filter(t => t.type === 'Grant' && t.status === 'Completed').reduce((sum, t) => sum + t.amount, 0);
  const paidOut = state.transactions.filter(t => t.type === 'Withdrawal' && t.status === 'Completed').reduce((sum, t) => sum + Math.abs(t.amount) - (t.fee ?? 0), 0);
  const reserve = applicants.reduce((sum, p) => sum + computeBalances(state.transactions.filter(t => t.applicantId === p.id)).deposit, 0);
  const highRisk = applicants.filter(p => p.risk.level === 'High').length;
  const alerts = highRisk + openEscalations(state).length;
  const tiers = [1, 2, 3].map(t => applicants.filter(p => p.tier === t).length);
  const connectedNote = useServerData().connected ? 'Decisions are saved on the server.' : 'Everything is saved in this browser only.';
  return <>
    <div className="admin-overview-metrics admin-overview-metrics-5">
      <div className="admin-metric featured" data-testid="metric-admin-review-queue"><span className="admin-metric-label">Pending applications</span><strong className="admin-metric-value">{pad(waiting.length)}</strong><span className="admin-metric-foot">{compact(waiting.reduce((sum, a) => sum + a.requestedAmount, 0))} requested · awaiting a decision</span></div>
      <div className="admin-metric" data-testid="metric-admin-active-grants"><span className="admin-metric-label">Active grants</span><strong className="admin-metric-value">{pad(count('Approved'))}</strong><span className="admin-metric-foot">{compact(awarded)} awarded</span></div>
      <div className="admin-metric" data-testid="metric-admin-disbursed"><span className="admin-metric-label">Total disbursed</span><strong className="admin-metric-value">{compact(paidOut)}</strong><span className="admin-metric-foot">Payouts marked paid, net of fees</span></div>
      <Link href="/admin/security" className={`admin-metric ${alerts ? 'alert' : ''}`} data-testid="metric-admin-security-alerts"><span className="admin-metric-label">Security alerts</span><strong className="admin-metric-value">{pad(alerts)}</strong><span className="admin-metric-foot">{highRisk} high-risk applicant{highRisk === 1 ? '' : 's'} · {openEscalations(state).length} escalated{state.lockdown ? ' · LOCKDOWN' : ''}</span></Link>
      <div className="admin-metric" data-testid="metric-admin-reserve"><span className="admin-metric-label">Platform wallet reserve</span><strong className="admin-metric-value">{compact(reserve)}</strong><span className="admin-metric-foot">Confirmed deposit balances held</span></div>
    </div>
    <div className="admin-overview-main">
      <section className="admin-panel"><SectionHead title="Review queue" subtitle="Oldest submissions first. Open one to review it." href="/admin/applications" link="Open queue" />{waiting.length ? <div className="admin-list">{waiting.slice(0, 4).map(a => toRow(state, a)).map(item => <div className="admin-list-item" key={item.id} data-testid={`item-admin-queue-${item.id}`}><span className="admin-list-icon"><FileText size={17} /></span><span className="admin-list-copy"><strong>{item.title}</strong><small>{item.applicant} · {money(item.amount)} · {item.date}</small></span><Badge status={item.status} /><button type="button" className="admin-icon-button" onClick={() => openReview(item.id)} aria-label={`Review application ${item.title}`} data-testid={`button-preview-admin-application-${item.id}`}><ArrowRight size={15} /></button></div>)}</div> : <p className="admin-review-hint">Nothing is waiting for review.</p>}</section>
      <div className="admin-grid">
        <div className="admin-priority"><span className="admin-eyebrow">Workspace focus</span><strong>A clearer view of every request.</strong><p>Start reviews, request changes, and record decisions. {connectedNote}</p><Link href="/admin/applications" data-testid="link-admin-explore-review-queue">Explore review queue <ArrowRight size={14} /></Link></div>
        <section className="admin-panel"><SectionHead title="At a glance" subtitle="Live counts across the workspace." /><div className="admin-mini-stat"><span>Awaiting first look</span><strong>{pad(count('Submitted'))}</strong></div><div className="admin-mini-stat"><span>Under review</span><strong>{pad(count('Under review'))}</strong></div><div className="admin-mini-stat"><span>With applicant for changes</span><strong>{pad(count('Changes requested'))}</strong></div><div className="admin-mini-stat"><span>Deposits to confirm</span><strong>{pad(state.transactions.filter(t => t.type === 'Deposit' && t.status === 'Pending').length)} · {money(pendingDepositTotal(state))}</strong></div><div className="admin-mini-stat"><span>Payouts waiting</span><strong>{pad(state.transactions.filter(t => t.type === 'Withdrawal' && t.status === 'Pending').length)} · {money(pendingPayoutTotal(state))}</strong></div><div className="admin-mini-stat"><span>Approved / declined</span><strong>{pad(count('Approved'))} / {pad(count('Declined'))}</strong></div><div className="admin-mini-stat" data-testid="stat-admin-tiers"><span>Users by tier (1 / 2 / 3)</span><strong>{tiers.join(' / ')}</strong></div><div className="admin-mini-stat"><span>Active programs</span><strong>{pad(state.grants.filter(g => g.status === 'Open').length)}</strong></div></section>
      </div>
    </div>
    <RecentActivity />
    <div className="admin-overview-bottom">
      <section className="admin-panel"><SectionHead title="Recently joined" subtitle="The newest user accounts." href="/admin/applicants" link="View users" />{applicants.slice(0, 3).map(person => <div className="admin-simple-row" key={person.id}><strong>{person.name}</strong><span>{person.sector}</span></div>)}</section>
      <section className="admin-panel"><SectionHead title="Program landscape" subtitle="Budget remaining in active programs." href="/admin/grants" link="View programs" />{state.grants.filter(g => g.status === 'Open').slice(0, 4).map(grant => <div className="admin-simple-row" key={grant.id}><strong>{grant.name}</strong><span>{money(programBudget(state, grant.id).remaining)} left</span></div>)}</section>
    </div>
  </>;
}


function Applications({ openReview }: { openReview: (id: string) => void }) {
  const applications = useQueue();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All statuses');
  const rows = applications.filter(item => (filter === 'All statuses' || item.status === filter || (filter === 'Escalated' && item.escalated)) && `${item.title} ${item.applicant} ${item.program} ${item.id}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="admin-panel">
    <SectionHead title="Review queue" subtitle="Submitted requests. Open one to review and decide." />
    <div className="admin-toolbar"><div className="admin-toolbar-left"><label className="admin-search"><Search size={15} /><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search requests or applicants" aria-label="Search applications" data-testid="input-admin-search-applications" /></label><select className="admin-filter" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter applications by status" data-testid="select-admin-filter-applications"><option>All statuses</option><option>Submitted</option><option>Under review</option><option>Changes requested</option><option>Approved</option><option>Declined</option><option>Escalated</option></select></div><span className="admin-count" data-testid="text-admin-applications-count">{rows.length} of {applications.length} requests</span></div>
    {rows.length ? <>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Request</th><th>Program</th><th>Requested</th><th>Status</th><th>Date</th><th><span className="admin-eyebrow" style={{ margin: 0 }}>Explore</span></th></tr></thead><tbody>{rows.map(item => <tr key={item.id} data-testid={`row-admin-application-${item.id}`}><td><span className="admin-table-primary">{item.title}</span><span className="admin-table-secondary">{item.applicant} · {item.id}</span></td><td className="admin-table-muted">{item.program}</td><td className="admin-table-number">{money(item.amount)}</td><td><Badge status={item.status} />{item.escalated && <span className="admin-flag" data-testid={`flag-admin-escalated-${item.id}`}>Escalated</span>}</td><td className="admin-table-muted">{item.date}</td><td><button type="button" className="admin-icon-button" onClick={() => openReview(item.id)} aria-label={`Review application ${item.title}`} data-testid={`button-preview-admin-application-${item.id}`}><ArrowRight size={15} /></button></td></tr>)}</tbody></table></div>
      <div className="admin-mobile-records" role="list" aria-label="Funding requests">{rows.map(item => <article className="admin-mobile-record" role="listitem" key={item.id} data-testid={`card-admin-application-${item.id}`}>
        <div className="admin-mobile-record-top"><div className="admin-mobile-record-identity"><strong>{item.title}</strong><span>{item.applicant} · {item.id}</span></div><Badge status={item.status} /></div>
        <dl className="admin-mobile-record-facts"><div><dt>Program</dt><dd>{item.program}</dd></div><div><dt>Requested</dt><dd>{money(item.amount)}</dd></div><div><dt>Date</dt><dd>{item.date}</dd></div></dl>
        <button type="button" className="admin-mobile-record-action" onClick={() => openReview(item.id)} aria-label={`Review application ${item.title}`} data-testid={`button-preview-admin-application-mobile-${item.id}`}>Review request <ArrowRight size={15} /></button>
      </article>)}</div>
    </> : <EmptyResults onReset={() => { setQuery(''); setFilter('All statuses'); }} />}
  </section>;
}


const sectionCopy: Record<AdminSection, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: 'The grant team workspace', title: 'A better view of what matters.', description: 'A thoughtful place to orient around people, programs, and the requests between them.' },
  applicant: { eyebrow: 'Users / Profile', title: 'One applicant, everything in one place.', description: 'Profile, identity documents, balances and adjustments, cards, feature toggles, the full ledger, and the audit trail. Every change is role-checked and audited.' },
  applicants: { eyebrow: 'Users / Directory', title: 'The people behind the work.', description: 'Everyone with a user account: status, tier, identity, location, balances, and fraud risk. Open a profile to manage the account.' },
  inbox: { eyebrow: 'Workspace / Correspondence', title: 'The team inbox.', description: 'Mail to and from the grant team\'s address.' },
  applications: { eyebrow: 'Funding / Review queue', title: 'Every request, in context.', description: 'Review submitted requests, ask applicants for changes, and record approvals or declines. Decisions are saved in this browser only.' },
  cards: { eyebrow: 'Funding / Cards', title: 'Cards, from application to doorstep.', description: 'Approve or decline physical card applications, issue cards, fund or deduct from card balances, and freeze cards. The cards are fictional: no card issuer is connected.' },
  deposits: { eyebrow: 'Funding / Deposits', title: 'Money in, matched by reference.', description: 'Confirm deposits applicants have announced once the transfer arrives, or reject them with a reason. No bank feed is connected.' },
  payouts: { eyebrow: 'Funding / Payouts', title: 'Money out, on the record.', description: 'Process applicant withdrawal requests: record each as paid or failed. No payment provider is connected, so nothing is actually sent.' },
  security: { eyebrow: 'Trust / Security', title: 'Risk, identity, and controls.', description: 'Review identity checks, watch automated fraud scores, handle escalated applications, and trigger an emergency lockdown.' },
  audit: { eyebrow: 'Trust / Audit', title: 'Who did what, and when.', description: 'An append-only record of every staff action in this browser, with the fields each one changed. Filter it or export it as CSV or JSON.' },
  grants: { eyebrow: 'Funding / Programs', title: 'Programs with a purpose.', description: 'Create, edit, publish, and close grant programs. Changes apply to the applicant portal in this browser.' },
  settings: { eyebrow: 'Workspace / Configuration', title: 'A place for the rules.', description: 'Settings are grouped by area. Open a section to see and change what it covers.' },
};

export function AdminPage({ section, settingsSection, applicantId }: { section: AdminSection; settingsSection?: string; applicantId?: string }) {
  return <AdminGate><AdminWorkspace section={section} settingsSection={settingsSection} applicantId={applicantId} /></AdminGate>;
}

function AdminWorkspace({ section, settingsSection, applicantId: profileId }: { section: AdminSection; settingsSection?: string; applicantId?: string }) {
  const { state } = useDemoStore();
  const [, navigate] = useLocation();
  const signedIn = useSession().status === 'signedIn';
  const [applicantId, setApplicantId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const closeApplicant = useCallback(() => setApplicantId(null), []);
  const closeReview = useCallback(() => setReviewId(null), []);
  useEffect(() => { setApplicantId(null); setReviewId(null); }, [section]);
  const copy = sectionCopy[section];
  const content: Record<AdminSection, ReactNode> = {
    overview: <Overview openReview={setReviewId} />,
    applicants: <AdminApplicants openApplicant={id => navigate(`/admin/applicants/${id}`)} />,
    applicant: <AdminApplicantProfile applicantId={profileId ?? ''} />,
    inbox: signedIn ? <AdminInboxLive /> : <AdminInbox />,
    applications: <Applications openReview={setReviewId} />,
    payouts: <><PaymentsTabs tab="payouts" /><AdminPayouts /></>,
    deposits: <><PaymentsTabs tab="deposits" /><AdminDeposits /></>,
    cards: <><PaymentsTabs tab="cards" /><AdminCards /></>,
    grants: <AdminPrograms />,
    security: <><SecurityTabs tab="security" /><AdminSecurity openApplicant={setApplicantId} openReview={setReviewId} /></>,
    audit: <><SecurityTabs tab="audit" /><AdminAudit /></>,
    settings: <AdminSettings sectionId={settingsSection} />,
  };
  return <div className="admin-shell">
    <aside className="admin-sidebar"><div className="admin-brand"><span className="admin-brand-mark"><BrandLetter /></span><span className="admin-brand-name"><Wordmark /></span><span className="admin-brand-divider" /><span className="admin-brand-role">Admin</span></div><div className="admin-sidebar-label">Workspace</div><nav className="admin-nav" aria-label="Admin navigation">{navItems.map(item => { const Icon = item.icon; return <Link key={item.section} href={item.href} className={`admin-nav-link ${isActive(section, item.section) ? 'active' : ''}`} aria-current={isActive(section, item.section) ? 'page' : undefined} data-testid={`link-admin-nav-${item.section}`}><Icon size={17} strokeWidth={1.8} />{item.label}</Link>; })}</nav><div className="admin-sidebar-bottom"><div className="admin-sidebar-rule" /><div className="admin-sidebar-note"><strong>{signedIn ? 'Team workspace' : 'Preview workspace'}</strong>{signedIn ? 'Signed in. Records are stored on the server, and every action is role-checked and audited.' : 'Sample records, saved in this browser only. Staff sign-in is not set up, so roles use a sample switcher.'}</div><div className="admin-sidebar-index">ARC / TEAM SPACE 001</div></div></aside>
    <main className="admin-main"><header className="admin-topbar"><div className="admin-topbar-left"><div className="admin-mobile-brand"><span className="admin-brand-mark"><BrandLetter /></span><span><AppNameText /> <span style={{ color: '#7b887b', fontWeight: 500 }}>/ admin</span></span></div><div className="admin-breadcrumb">Team workspace <span>/</span> <strong>{section === 'grants' ? 'Grant programs' : section === 'audit' ? 'Audit log' : section === 'applicants' ? 'Users' : section === 'applicant' ? 'User' : section[0].toUpperCase() + section.slice(1)}</strong>{section === 'settings' && settingsSection && <> <span>/</span> <strong>{findSettingsSection(settingsSection)?.title ?? 'Not found'}</strong></>}</div></div><div className="admin-topbar-right">{state.lockdown && <Link href="/admin/security" className="admin-lockdown-pill" data-testid="status-admin-lockdown"><ShieldAlert size={13} /> Lockdown</Link>}<AdminActivityMenu />{!signedIn && <span className="admin-preview-pill" data-testid="status-admin-preview">Preview mode</span>}{signedIn ? <AdminSessionMenu /> : <StaffSwitcher />}</div></header>
      <div className="admin-content"><div className="admin-pagehead"><div><p className="admin-eyebrow">{copy.eyebrow}</p><h1 data-testid={`heading-admin-${section}`}>{copy.title}</h1><p>{copy.description}</p></div><span className="admin-date">SAMPLE WORKSPACE / 2026</span></div>{content[section]}</div>
    </main>
    <nav className="admin-mobile-nav" aria-label="Admin mobile navigation">{navItems.map(item => { const Icon = item.icon; return <Link key={item.section} href={item.href} className={isActive(section, item.section) ? 'active' : ''} aria-current={isActive(section, item.section) ? 'page' : undefined} data-testid={`link-admin-mobile-${item.section}`}><Icon size={18} strokeWidth={1.8} /><span>{item.section === 'applications' ? 'Queue' : item.section === 'applicants' ? 'Users' : item.section === 'overview' ? 'Home' : item.section === 'inbox' ? 'Inbox' : item.section === 'payouts' ? 'Money' : item.section === 'settings' ? 'Settings' : item.section === 'security' ? 'Security' : 'Grants'}</span></Link>; })}</nav>
    {applicantId && <AdminApplicantPanel applicantId={applicantId} onClose={closeApplicant} />}
    {reviewId && <AdminReviewPanel appId={reviewId} onClose={closeReview} />}
  </div>;
}

export default AdminPage;