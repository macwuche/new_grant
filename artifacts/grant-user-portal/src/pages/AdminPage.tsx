import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import {
  ArrowRight, Banknote, Building2, ClipboardList, FileText, FolderOpen, Info,
  LayoutDashboard, Leaf, Mail, Palette, Search, Settings2, ShieldCheck,
  Store, Users, X,
} from 'lucide-react';
import { AdminInbox } from './AdminInbox';
import { AdminEmailSettings } from './AdminEmailSettings';
import { BrandColorSettings } from './BrandColorSettings';
import { AdminReviewPanel } from './AdminReviewPanel';
import { AdminPayouts } from './AdminPayouts';
import { pendingPayoutTotal } from '@/domain/payouts';
import { findGrant } from '@/domain/rules';
import { applicantName, awaitingAction, programBudget, reviewQueue } from '@/domain/review';
import { CURRENT_APPLICANT_ID } from '@/domain/seed';
import { useDemoStore } from '@/domain/store';
import type { Application as DomainApplication, DemoState } from '@/domain/model';
import { format } from 'date-fns';
import './AdminPage.css';

export type AdminSection = 'overview' | 'applicants' | 'inbox' | 'applications' | 'payouts' | 'grants' | 'settings';
type Applicant = { id: string; name: string; email: string; sector: string; country: string; status: string; joined: string; applications: number };
/** Queue row derived from the shared store. */
type Application = { id: string; title: string; applicant: string; amount: number; status: string; date: string; program: string };
type Grant = { id: string; title: string; ceiling: number; status: string; focus: string; cycle: string; description: string; icon: typeof Store };
type Detail = { title: string; eyebrow: string; description: string; fields: { label: string; value: string }[] };

const shortDate = (iso: string) => format(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso), 'dd MMM yyyy');

function toRow(state: DemoState, app: DomainApplication): Application {
  return { id: app.id, title: app.businessName, applicant: applicantName(state, app.applicantId), amount: app.requestedAmount, status: app.status, date: shortDate(app.submittedAt ?? app.updatedAt), program: findGrant(app.grantId)?.name ?? 'Unknown program' };
}
function useQueue(): Application[] {
  const { state } = useDemoStore();
  return reviewQueue(state).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(app => toRow(state, app));
}
function useApplicants(): Applicant[] {
  const { state } = useDemoStore();
  const count = (id: string) => reviewQueue(state).filter(a => a.applicantId === id).length;
  const me = { id: CURRENT_APPLICANT_ID, name: state.profile.name, email: state.profile.email, sector: 'Creative industries', country: 'United States', status: state.profile.identityVerified ? 'Verified' : 'Pending', joined: shortDate('2026-06-20'), applications: count(CURRENT_APPLICANT_ID) };
  return [me, ...state.otherApplicants.map(p => ({ id: p.id, name: p.name, email: p.email, sector: p.sector, country: p.country, status: p.verified ? 'Verified' : 'Pending', joined: shortDate(p.joined), applications: count(p.id) }))];
}

const grants: Grant[] = [
  { id: 'momentum', title: 'Business Momentum', ceiling: 12500, status: 'Active', focus: 'Small businesses', cycle: '2026–27', description: 'Working capital for small businesses ready for their next chapter.', icon: Store },
  { id: 'green', title: 'Green Transition', ceiling: 18000, status: 'Active', focus: 'Climate action', cycle: '2026–27', description: 'Support for practical energy upgrades that reduce operating costs.', icon: Leaf },
  { id: 'creative', title: 'Creative Practice', ceiling: 8500, status: 'Active', focus: 'Independent makers', cycle: '2026–27', description: 'Flexible funding for independent makers and creative studios.', icon: Palette },
  { id: 'community', title: 'Community Roots', ceiling: 22000, status: 'Active', focus: 'Local organizations', cycle: '2026–27', description: 'Help local organizations build more resilient neighborhoods.', icon: Building2 },
  { id: 'space', title: 'Shared Spaces', ceiling: 14500, status: 'Draft', focus: 'Civic spaces', cycle: 'Future cycle', description: 'An illustrative concept for welcoming, adaptable community spaces.', icon: FolderOpen },
];

const money = (value: number) => `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const navItems = [
  { section: 'overview' as const, label: 'Overview', icon: LayoutDashboard, href: '/admin' },
  { section: 'applicants' as const, label: 'Applicants', icon: Users, href: '/admin/applicants' },
  { section: 'inbox' as const, label: 'Email inbox', icon: Mail, href: '/admin/inbox' },
  { section: 'applications' as const, label: 'Applications', icon: ClipboardList, href: '/admin/applications' },
  { section: 'payouts' as const, label: 'Payouts', icon: Banknote, href: '/admin/payouts' },
  { section: 'grants' as const, label: 'Grant programs', icon: FolderOpen, href: '/admin/grants' },
  { section: 'settings' as const, label: 'Settings', icon: Settings2, href: '/admin/settings' },
];

function Badge({ status }: { status: string }) {
  return <span className={`admin-badge ${slug(status) === 'under-review' ? 'review' : slug(status)}`} data-testid={`status-admin-${slug(status)}`}>{status}</span>;
}

function SectionHead({ title, subtitle, href, link }: { title: string; subtitle: string; href?: string; link?: string }) {
  return <div className="admin-panel-head"><div><h2>{title}</h2><p>{subtitle}</p></div>{href && link && <Link href={href} className="admin-textlink" data-testid={`link-admin-${slug(link)}`} aria-label={`${link} ${title}`}>{link}<ArrowRight size={14} /></Link>}</div>;
}

function DetailPanel({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="admin-detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }} data-testid="overlay-admin-detail">
    <aside className="admin-detail" role="dialog" aria-modal="true" aria-labelledby="admin-detail-title">
      <div className="admin-detail-header"><span className="admin-eyebrow" style={{ margin: 0 }}>{detail.eyebrow} / Preview record</span><button ref={closeRef} type="button" className="admin-icon-button" onClick={onClose} aria-label="Close preview details" data-testid="button-close-admin-detail"><X size={17} /></button></div>
      <h2 id="admin-detail-title" data-testid="text-admin-detail-title">{detail.title}</h2>
      <p className="admin-detail-lead">{detail.description}</p>
      <dl className="admin-detail-fields">{detail.fields.map(field => <div className="admin-detail-field" key={field.label}><dt>{field.label}</dt><dd data-testid={`text-admin-detail-${slug(field.label)}`}>{field.value}</dd></div>)}</dl>
      <div className="admin-detail-note"><Info size={17} /><span>Read-only illustrative record. There is no connected admin system or real applicant information here. Nothing you view or change is saved.</span></div>
    </aside>
  </div>;
}

function EmptyResults({ onReset }: { onReset: () => void }) {
  return <div className="admin-empty" data-testid="empty-admin-results"><Search size={25} /><h3>Nothing matches this view</h3><p>Try another search or remove the selected filter.</p><button type="button" onClick={onReset} data-testid="button-reset-admin-filters">Clear search and filter</button></div>;
}

const compact = (value: number) => value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : money(value);
const pad = (value: number) => String(value).padStart(2, '0');

function Overview({ openReview }: { openReview: (id: string) => void }) {
  const { state } = useDemoStore();
  const queue = reviewQueue(state);
  const waiting = awaitingAction(state);
  const applicants = useApplicants();
  const count = (status: string) => queue.filter(a => a.status === status).length;
  const sectors = new Set(applicants.map(p => p.sector)).size;
  return <>
    <div className="admin-overview-metrics">
      <div className="admin-metric featured" data-testid="metric-admin-review-queue"><span className="admin-metric-label">In the review queue</span><strong className="admin-metric-value">{pad(waiting.length)}</strong><span className="admin-metric-foot">Submitted or under review · demo records</span></div>
      <div className="admin-metric" data-testid="metric-admin-applicants"><span className="admin-metric-label">Demo applicants</span><strong className="admin-metric-value">{pad(applicants.length)}</strong><span className="admin-metric-foot">Across {sectors} sectors</span></div>
      <div className="admin-metric" data-testid="metric-admin-programs"><span className="admin-metric-label">Active programs</span><strong className="admin-metric-value">04</strong><span className="admin-metric-foot">Plus one draft concept</span></div>
      <div className="admin-metric" data-testid="metric-admin-requested"><span className="admin-metric-label">Requested in queue</span><strong className="admin-metric-value">{compact(waiting.reduce((sum, a) => sum + a.requestedAmount, 0))}</strong><span className="admin-metric-foot">Awaiting a decision, not committed funds</span></div>
    </div>
    <div className="admin-overview-main">
      <section className="admin-panel"><SectionHead title="Review queue" subtitle="Oldest submissions first. Open one to review it." href="/admin/applications" link="Open queue" />{waiting.length ? <div className="admin-list">{waiting.slice(0, 4).map(a => toRow(state, a)).map(item => <div className="admin-list-item" key={item.id} data-testid={`item-admin-queue-${item.id}`}><span className="admin-list-icon"><FileText size={17} /></span><span className="admin-list-copy"><strong>{item.title}</strong><small>{item.applicant} · {money(item.amount)} · {item.date}</small></span><Badge status={item.status} /><button type="button" className="admin-icon-button" onClick={() => openReview(item.id)} aria-label={`Review application ${item.title}`} data-testid={`button-preview-admin-application-${item.id}`}><ArrowRight size={15} /></button></div>)}</div> : <p className="admin-review-hint">Nothing is waiting for review.</p>}</section>
      <div className="admin-grid">
        <div className="admin-priority"><span className="admin-eyebrow">Workspace focus</span><strong>A clearer view of every request.</strong><p>Start reviews, request changes, and record decisions. Everything is saved in this browser only.</p><Link href="/admin/applications" data-testid="link-admin-explore-review-queue">Explore review queue <ArrowRight size={14} /></Link></div>
        <section className="admin-panel"><SectionHead title="At a glance" subtitle="Live counts from this browser's demo data." /><div className="admin-mini-stat"><span>Awaiting first look</span><strong>{pad(count('Submitted'))}</strong></div><div className="admin-mini-stat"><span>Under review</span><strong>{pad(count('Under review'))}</strong></div><div className="admin-mini-stat"><span>With applicant for changes</span><strong>{pad(count('Changes requested'))}</strong></div><div className="admin-mini-stat"><span>Payouts waiting</span><strong>{pad(state.transactions.filter(t => t.type === 'Withdrawal' && t.status === 'Pending').length)} · {money(pendingPayoutTotal(state))}</strong></div><div className="admin-mini-stat"><span>Approved / declined</span><strong>{pad(count('Approved'))} / {pad(count('Declined'))}</strong></div></section>
      </div>
    </div>
    <div className="admin-overview-bottom">
      <section className="admin-panel"><SectionHead title="Recently joined" subtitle="Illustrative applicant profiles." href="/admin/applicants" link="View applicants" />{applicants.slice(0, 3).map(person => <div className="admin-simple-row" key={person.id}><strong>{person.name}</strong><span>{person.sector}</span></div>)}</section>
      <section className="admin-panel"><SectionHead title="Program landscape" subtitle="Budget remaining per program." href="/admin/grants" link="View programs" />{grants.filter(g => findGrant(g.id)).slice(0, 4).map(grant => <div className="admin-simple-row" key={grant.id}><strong>{grant.title}</strong><span>{money(programBudget(state, grant.id).remaining)} left</span></div>)}</section>
    </div>
  </>;
}

function applicantDetail(person: Applicant): Detail {
  return { eyebrow: person.id, title: person.name, description: 'A fictional applicant profile for layout and navigation preview only.', fields: [
    { label: 'Email', value: person.email }, { label: 'Sector', value: person.sector }, { label: 'Country', value: person.country }, { label: 'Profile status', value: person.status }, { label: 'Submitted applications', value: String(person.applications) }, { label: 'Joined', value: person.joined }, { label: 'Reference', value: person.id },
  ] };
}
function grantDetail(state: DemoState, grant: Grant): Detail {
  const budget = findGrant(grant.id) ? programBudget(state, grant.id) : null;
  return { eyebrow: 'Grant program', title: grant.title, description: grant.description, fields: [
    { label: 'Funding ceiling', value: money(grant.ceiling) }, { label: 'Focus', value: grant.focus }, { label: 'Cycle', value: grant.cycle }, { label: 'Program status', value: grant.status },
    ...(budget ? [{ label: 'Budget', value: money(budget.budget) }, { label: 'Awarded', value: money(budget.awarded) }, { label: 'Remaining', value: money(budget.remaining) }] : []),
  ] };
}

function Applicants({ openDetail }: { openDetail: (detail: Detail) => void }) {
  const applicants = useApplicants();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All statuses');
  const rows = applicants.filter(person => (filter === 'All statuses' || person.status === filter) && `${person.name} ${person.email} ${person.sector} ${person.country}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="admin-panel">
    <SectionHead title="Applicant directory" subtitle="Browse demo profiles. These are invented names and contact details; the first is the applicant-portal demo user." />
    <div className="admin-toolbar"><div className="admin-toolbar-left"><label className="admin-search"><Search size={15} /><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search people, sector, country" aria-label="Search applicants" data-testid="input-admin-search-applicants" /></label><select className="admin-filter" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter applicants by status" data-testid="select-admin-filter-applicants"><option>All statuses</option><option>Verified</option><option>Pending</option></select></div><span className="admin-count" data-testid="text-admin-applicants-count">{rows.length} of {applicants.length} profiles</span></div>
    {rows.length ? <>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Applicant</th><th>Sector</th><th>Country</th><th>Status</th><th>Joined</th><th><span className="admin-eyebrow" style={{ margin: 0 }}>Explore</span></th></tr></thead><tbody>{rows.map(person => <tr key={person.id} data-testid={`row-admin-applicant-${person.id}`}><td><div className="admin-person-cell"><span className="admin-initials" aria-hidden="true">{person.name.split(' ').map(part => part[0]).join('')}</span><span><span className="admin-table-primary">{person.name}</span><span className="admin-table-secondary">{person.email}</span></span></div></td><td className="admin-table-muted">{person.sector}</td><td className="admin-table-muted">{person.country}</td><td><Badge status={person.status} /></td><td className="admin-table-muted">{person.joined}</td><td><button type="button" className="admin-icon-button" onClick={() => openDetail(applicantDetail(person))} aria-label={`Preview ${person.name} profile`} data-testid={`button-preview-admin-applicant-${person.id}`}><ArrowRight size={15} /></button></td></tr>)}</tbody></table></div>
      <div className="admin-mobile-records" role="list" aria-label="Applicant profiles">{rows.map(person => <article className="admin-mobile-record" role="listitem" key={person.id} data-testid={`card-admin-applicant-${person.id}`}>
        <div className="admin-mobile-record-top"><div className="admin-person-cell"><span className="admin-initials" aria-hidden="true">{person.name.split(' ').map(part => part[0]).join('')}</span><div className="admin-mobile-record-identity"><strong>{person.name}</strong><span>{person.email}</span></div></div><Badge status={person.status} /></div>
        <dl className="admin-mobile-record-facts"><div><dt>Sector</dt><dd>{person.sector}</dd></div><div><dt>Country</dt><dd>{person.country}</dd></div><div><dt>Joined</dt><dd>{person.joined}</dd></div></dl>
        <button type="button" className="admin-mobile-record-action" onClick={() => openDetail(applicantDetail(person))} aria-label={`Preview ${person.name} profile`} data-testid={`button-preview-admin-applicant-mobile-${person.id}`}>Preview profile <ArrowRight size={15} /></button>
      </article>)}</div>
    </> : <EmptyResults onReset={() => { setQuery(''); setFilter('All statuses'); }} />}
  </section>;
}

function Applications({ openReview }: { openReview: (id: string) => void }) {
  const applications = useQueue();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All statuses');
  const rows = applications.filter(item => (filter === 'All statuses' || item.status === filter) && `${item.title} ${item.applicant} ${item.program} ${item.id}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="admin-panel">
    <SectionHead title="Review queue" subtitle="Submitted requests from this browser's demo data. Open one to review and decide." />
    <div className="admin-toolbar"><div className="admin-toolbar-left"><label className="admin-search"><Search size={15} /><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search requests or applicants" aria-label="Search applications" data-testid="input-admin-search-applications" /></label><select className="admin-filter" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter applications by status" data-testid="select-admin-filter-applications"><option>All statuses</option><option>Submitted</option><option>Under review</option><option>Changes requested</option><option>Approved</option><option>Declined</option></select></div><span className="admin-count" data-testid="text-admin-applications-count">{rows.length} of {applications.length} requests</span></div>
    {rows.length ? <>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Request</th><th>Program</th><th>Requested</th><th>Status</th><th>Date</th><th><span className="admin-eyebrow" style={{ margin: 0 }}>Explore</span></th></tr></thead><tbody>{rows.map(item => <tr key={item.id} data-testid={`row-admin-application-${item.id}`}><td><span className="admin-table-primary">{item.title}</span><span className="admin-table-secondary">{item.applicant} · {item.id}</span></td><td className="admin-table-muted">{item.program}</td><td className="admin-table-number">{money(item.amount)}</td><td><Badge status={item.status} /></td><td className="admin-table-muted">{item.date}</td><td><button type="button" className="admin-icon-button" onClick={() => openReview(item.id)} aria-label={`Review application ${item.title}`} data-testid={`button-preview-admin-application-${item.id}`}><ArrowRight size={15} /></button></td></tr>)}</tbody></table></div>
      <div className="admin-mobile-records" role="list" aria-label="Funding requests">{rows.map(item => <article className="admin-mobile-record" role="listitem" key={item.id} data-testid={`card-admin-application-${item.id}`}>
        <div className="admin-mobile-record-top"><div className="admin-mobile-record-identity"><strong>{item.title}</strong><span>{item.applicant} · {item.id}</span></div><Badge status={item.status} /></div>
        <dl className="admin-mobile-record-facts"><div><dt>Program</dt><dd>{item.program}</dd></div><div><dt>Requested</dt><dd>{money(item.amount)}</dd></div><div><dt>Date</dt><dd>{item.date}</dd></div></dl>
        <button type="button" className="admin-mobile-record-action" onClick={() => openReview(item.id)} aria-label={`Review application ${item.title}`} data-testid={`button-preview-admin-application-mobile-${item.id}`}>Review request <ArrowRight size={15} /></button>
      </article>)}</div>
    </> : <EmptyResults onReset={() => { setQuery(''); setFilter('All statuses'); }} />}
  </section>;
}

function Grants({ openDetail }: { openDetail: (detail: Detail) => void }) {
  const { state } = useDemoStore();
  const [filter, setFilter] = useState('All programs');
  const visible = grants.filter(grant => filter === 'All programs' || grant.status === filter);
  return <>
    <div className="admin-toolbar"><span className="admin-count" data-testid="text-admin-grants-count">{visible.length} of {grants.length} example programs</span><select className="admin-filter" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter grant programs by status" data-testid="select-admin-filter-grants"><option>All programs</option><option>Active</option><option>Draft</option></select></div>
    <div className="admin-program-grid">{visible.map(grant => { const Icon = grant.icon; return <article className="admin-program-card" key={grant.id} data-testid={`card-admin-grant-${grant.id}`}><div className="admin-program-top"><span className="admin-program-icon"><Icon size={19} /></span><Badge status={grant.status} /></div><h2>{grant.title}</h2><p>{grant.description}</p><div className="admin-program-meta"><div><span>Funding ceiling</span><strong>Up to {money(grant.ceiling)}</strong></div><div><span>{findGrant(grant.id) ? 'Budget left' : 'Focus'}</span><strong>{findGrant(grant.id) ? `${money(programBudget(state, grant.id).remaining)} of ${money(programBudget(state, grant.id).budget)}` : grant.focus}</strong></div></div><button type="button" onClick={() => openDetail(grantDetail(state, grant))} aria-label={`Preview ${grant.title} program details`} data-testid={`button-preview-admin-grant-${grant.id}`}>View program preview <ArrowRight size={14} /></button></article>; })}</div>
  </>;
}

function Settings() {
  return <><BrandColorSettings /><div className="admin-settings-grid">
    <section className="admin-panel"><SectionHead title="Workspace configuration" subtitle="A preview of where program controls could live. These settings cannot be changed here." />
      <div className="admin-setting-item"><ShieldCheck size={18} /><div><strong>Policy documents</strong><p>Future home for eligibility guidance, terms, and privacy documents. No policy is uploaded or published in this preview.</p></div><span>NOT CONNECTED</span></div>
      <div className="admin-setting-item"><Users size={18} /><div><strong>Applicant sectors</strong><p>Future controls for the sector options applicants can choose when building a profile.</p></div><span>NOT CONNECTED</span></div>
      <div className="admin-setting-item"><ClipboardList size={18} /><div><strong>Review stages</strong><p>The review flow is fixed for now: Submitted → Under review → Approved, Declined, or Changes requested (back to the applicant). Configurable stages need a secured backend.</p></div><span>NOT CONNECTED</span></div>
      <div className="admin-setting-item"><FileText size={18} /><div><strong>Program criteria</strong><p>Eligibility requirements and application questions would require a secured admin backend.</p></div><span>NOT CONNECTED</span></div>
    </section>
    <div className="admin-grid">
      <section className="admin-panel"><SectionHead title="Example sectors" subtitle="Illustrative labels, not live choices." /><div className="admin-sector-list"><span>Creative industries</span><span>Retail</span><span>Community</span><span>Climate</span><span>Food &amp; beverage</span></div><div className="admin-settings-callout"><strong>Configuration preview only</strong><p>Editing these options would require authenticated admin access and a backend. This screen does not save changes.</p></div></section>
      <section className="admin-panel"><SectionHead title="Access & safety" subtitle="Important before a real admin rollout." /><div className="admin-mini-stat"><span>Authorization</span><strong>Not enabled</strong></div><div className="admin-mini-stat"><span>Data source</span><strong>This browser</strong></div><div className="admin-mini-stat"><span>Write access</span><strong>Reviews &amp; payouts (browser only)</strong></div></section>
    </div>
  </div><AdminEmailSettings /></>;
}

const sectionCopy: Record<AdminSection, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: 'The grant team workspace', title: 'A better view of what matters.', description: 'A thoughtful place to orient around people, programs, and the requests between them.' },
  applicants: { eyebrow: 'People / Directory', title: 'The people behind the work.', description: 'Browse fictional applicant profiles across sectors and regions. Profiles open as read-only previews.' },
  inbox: { eyebrow: 'Workspace / Correspondence', title: 'The team inbox.', description: 'A quiet reading space for fictional grant correspondence. Explore the sample flow without sending or receiving email.' },
  applications: { eyebrow: 'Funding / Review queue', title: 'Every request, in context.', description: 'Review submitted requests, ask applicants for changes, and record approvals or declines. Decisions are saved in this browser only.' },
  payouts: { eyebrow: 'Funding / Payouts', title: 'Money out, on the record.', description: 'Process applicant withdrawal requests: record each as paid or failed. No payment provider is connected, so nothing is actually sent.' },
  grants: { eyebrow: 'Funding / Programs', title: 'Programs with a purpose.', description: 'Explore sample grant categories, their focus, and illustrative funding ceilings.' },
  settings: { eyebrow: 'Workspace / Configuration', title: 'A place for the rules.', description: 'Preview the brand color and see where policies, sectors, and review conventions could be managed.' },
};

export function AdminPage({ section }: { section: AdminSection }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const closeDetail = () => setDetail(null);
  const closeReview = useCallback(() => setReviewId(null), []);
  useEffect(() => { setDetail(null); setReviewId(null); }, [section]);
  const copy = sectionCopy[section];
  const content: Record<AdminSection, ReactNode> = {
    overview: <Overview openReview={setReviewId} />,
    applicants: <Applicants openDetail={setDetail} />,
    inbox: <AdminInbox />,
    applications: <Applications openReview={setReviewId} />,
    payouts: <AdminPayouts />,
    grants: <Grants openDetail={setDetail} />,
    settings: <Settings />,
  };
  return <div className="admin-shell">
    <aside className="admin-sidebar"><div className="admin-brand"><span className="admin-brand-mark">a</span><span className="admin-brand-name">arc<span>.</span>fund</span><span className="admin-brand-divider" /><span className="admin-brand-role">Admin</span></div><div className="admin-sidebar-label">Workspace</div><nav className="admin-nav" aria-label="Admin navigation">{navItems.map(item => { const Icon = item.icon; return <Link key={item.section} href={item.href} className={`admin-nav-link ${section === item.section ? 'active' : ''}`} aria-current={section === item.section ? 'page' : undefined} data-testid={`link-admin-nav-${item.section}`}><Icon size={17} strokeWidth={1.8} />{item.label}</Link>; })}</nav><div className="admin-sidebar-bottom"><div className="admin-sidebar-rule" /><div className="admin-sidebar-note"><strong>Preview workspace</strong>Demo records only. Review decisions, payout records, and brand color are saved in this browser; there is no staff sign-in or server.</div><div className="admin-sidebar-index">ARC / TEAM SPACE 001</div></div></aside>
    <main className="admin-main"><header className="admin-topbar"><div className="admin-topbar-left"><div className="admin-mobile-brand"><span className="admin-brand-mark">a</span><span>arc.fund <span style={{ color: '#7b887b', fontWeight: 500 }}>/ admin</span></span></div><div className="admin-breadcrumb">Team workspace <span>/</span> <strong>{section === 'grants' ? 'Grant programs' : section[0].toUpperCase() + section.slice(1)}</strong></div></div><div className="admin-topbar-right"><span className="admin-preview-pill" data-testid="status-admin-preview">Preview mode</span><span className="admin-avatar" aria-label="Illustrative team avatar">AT</span></div></header>
      <div className="admin-content"><div className="admin-pagehead"><div><p className="admin-eyebrow">{copy.eyebrow}</p><h1 data-testid={`heading-admin-${section}`}>{copy.title}</h1><p>{copy.description}</p></div><span className="admin-date">SAMPLE WORKSPACE / 2026</span></div>{content[section]}</div>
    </main>
    <nav className="admin-mobile-nav" aria-label="Admin mobile navigation">{navItems.map(item => { const Icon = item.icon; return <Link key={item.section} href={item.href} className={section === item.section ? 'active' : ''} aria-current={section === item.section ? 'page' : undefined} data-testid={`link-admin-mobile-${item.section}`}><Icon size={18} strokeWidth={1.8} /><span>{item.section === 'applications' ? 'Queue' : item.section === 'applicants' ? 'People' : item.section === 'overview' ? 'Home' : item.section === 'inbox' ? 'Inbox' : item.section === 'payouts' ? 'Payouts' : item.section === 'settings' ? 'Settings' : 'Grants'}</span></Link>; })}</nav>
    {detail && <DetailPanel detail={detail} onClose={closeDetail} />}
    {reviewId && <AdminReviewPanel appId={reviewId} onClose={closeReview} />}
  </div>;
}

export default AdminPage;