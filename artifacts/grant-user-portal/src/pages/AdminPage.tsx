import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import {
  ArrowRight, Building2, ClipboardList, FileText, FolderOpen, Info,
  LayoutDashboard, Leaf, Mail, Palette, Search, Settings2, ShieldCheck,
  Store, Users, X,
} from 'lucide-react';
import { AdminInbox } from './AdminInbox';
import { AdminEmailSettings } from './AdminEmailSettings';
import './AdminPage.css';

export type AdminSection = 'overview' | 'applicants' | 'inbox' | 'applications' | 'grants' | 'settings';
type Applicant = { id: string; name: string; email: string; sector: string; country: string; status: string; joined: string };
type Application = { id: string; title: string; applicant: string; amount: number; status: string; date: string; program: string; note: string };
type Grant = { id: string; title: string; ceiling: number; status: string; focus: string; cycle: string; description: string; icon: typeof Store };
type Detail = { title: string; eyebrow: string; description: string; fields: { label: string; value: string }[] };

const applicants: Applicant[] = [
  { id: 'APL-1042', name: 'Maya Okafor', email: 'maya.okafor@example.org', sector: 'Creative industries', country: 'United Kingdom', status: 'Verified', joined: '18 May 2025' },
  { id: 'APL-1043', name: 'Elias Navarro', email: 'elias.navarro@example.org', sector: 'Retail', country: 'United States', status: 'Pending', joined: '16 May 2025' },
  { id: 'APL-1044', name: 'Nia Campbell', email: 'nia.campbell@example.org', sector: 'Community', country: 'Canada', status: 'Verified', joined: '12 May 2025' },
  { id: 'APL-1045', name: 'Samira Haddad', email: 'samira.haddad@example.org', sector: 'Climate', country: 'United Kingdom', status: 'Verified', joined: '09 May 2025' },
  { id: 'APL-1046', name: 'Theo Mensah', email: 'theo.mensah@example.org', sector: 'Food & beverage', country: 'Ghana', status: 'Pending', joined: '06 May 2025' },
  { id: 'APL-1047', name: 'Priya Shah', email: 'priya.shah@example.org', sector: 'Creative industries', country: 'Canada', status: 'Verified', joined: '03 May 2025' },
];

const applications: Application[] = [
  { id: 'APP-2051', title: 'A neighborhood print studio', applicant: 'Maya Okafor', amount: 7400, status: 'Under review', date: '21 May 2025', program: 'Creative Practice', note: 'Equipment and workshop materials for a shared neighborhood print studio.' },
  { id: 'APP-2050', title: 'A lower-energy storefront', applicant: 'Samira Haddad', amount: 12800, status: 'Submitted', date: '20 May 2025', program: 'Green Transition', note: 'Practical energy upgrades across a small independent storefront.' },
  { id: 'APP-2049', title: 'Community kitchen expansion', applicant: 'Nia Campbell', amount: 16250, status: 'Under review', date: '19 May 2025', program: 'Community Roots', note: 'Additional kitchen capacity for local food programming.' },
  { id: 'APP-2048', title: 'Growing the corner shop', applicant: 'Elias Navarro', amount: 7800, status: 'Shortlisted', date: '14 May 2025', program: 'Business Momentum', note: 'Inventory and equipment to support a second year of trading.' },
  { id: 'APP-2047', title: 'A mobile ceramics workshop', applicant: 'Priya Shah', amount: 4950, status: 'Submitted', date: '12 May 2025', program: 'Creative Practice', note: 'Portable tools and materials for accessible ceramics sessions.' },
  { id: 'APP-2046', title: 'Solar-ready food storage', applicant: 'Theo Mensah', amount: 11350, status: 'Draft', date: '08 May 2025', program: 'Green Transition', note: 'Cold storage planning for a neighborhood food business.' },
];

const grants: Grant[] = [
  { id: 'momentum', title: 'Business Momentum', ceiling: 12500, status: 'Active', focus: 'Small businesses', cycle: 'Summer 2025', description: 'Working capital for small businesses ready for their next chapter.', icon: Store },
  { id: 'green', title: 'Green Transition', ceiling: 18000, status: 'Active', focus: 'Climate action', cycle: 'Summer 2025', description: 'Support for practical energy upgrades that reduce operating costs.', icon: Leaf },
  { id: 'creative', title: 'Creative Practice', ceiling: 8500, status: 'Active', focus: 'Independent makers', cycle: 'Summer 2025', description: 'Flexible funding for independent makers and creative studios.', icon: Palette },
  { id: 'community', title: 'Community Roots', ceiling: 22000, status: 'Active', focus: 'Local organizations', cycle: 'Summer 2025', description: 'Help local organizations build more resilient neighborhoods.', icon: Building2 },
  { id: 'space', title: 'Shared Spaces', ceiling: 14500, status: 'Draft', focus: 'Civic spaces', cycle: 'Future cycle', description: 'An illustrative concept for welcoming, adaptable community spaces.', icon: FolderOpen },
];

const money = (value: number) => `$${value.toLocaleString('en-US')}`;
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const navItems = [
  { section: 'overview' as const, label: 'Overview', icon: LayoutDashboard, href: '/admin' },
  { section: 'applicants' as const, label: 'Applicants', icon: Users, href: '/admin/applicants' },
  { section: 'inbox' as const, label: 'Email inbox', icon: Mail, href: '/admin/inbox' },
  { section: 'applications' as const, label: 'Applications', icon: ClipboardList, href: '/admin/applications' },
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

function Overview({ openDetail }: { openDetail: (detail: Detail) => void }) {
  return <>
    <div className="admin-overview-metrics">
      <div className="admin-metric featured" data-testid="metric-admin-review-queue"><span className="admin-metric-label">In the review queue</span><strong className="admin-metric-value">04</strong><span className="admin-metric-foot">Submitted or under review · sample records</span></div>
      <div className="admin-metric" data-testid="metric-admin-applicants"><span className="admin-metric-label">Sample applicants</span><strong className="admin-metric-value">06</strong><span className="admin-metric-foot">Across five sectors</span></div>
      <div className="admin-metric" data-testid="metric-admin-programs"><span className="admin-metric-label">Active programs</span><strong className="admin-metric-value">04</strong><span className="admin-metric-foot">Plus one draft concept</span></div>
      <div className="admin-metric" data-testid="metric-admin-requested"><span className="admin-metric-label">Requested in queue</span><strong className="admin-metric-value">$41.4k</strong><span className="admin-metric-foot">Illustrative, not committed funds</span></div>
    </div>
    <div className="admin-overview-main">
      <section className="admin-panel"><SectionHead title="Review queue" subtitle="A small sample of requests moving through the workspace." href="/admin/applications" link="Open queue" /><div className="admin-list">{applications.slice(0, 4).map(item => <div className="admin-list-item" key={item.id} data-testid={`item-admin-queue-${item.id}`}><span className="admin-list-icon"><FileText size={17} /></span><span className="admin-list-copy"><strong>{item.title}</strong><small>{item.applicant} · {money(item.amount)} · {item.date}</small></span><Badge status={item.status} /><button type="button" className="admin-icon-button" onClick={() => openDetail(applicationDetail(item))} aria-label={`Preview application ${item.title}`} data-testid={`button-preview-admin-application-${item.id}`}><ArrowRight size={15} /></button></div>)}</div></section>
      <div className="admin-grid">
        <div className="admin-priority"><span className="admin-eyebrow">Workspace focus</span><strong>A clearer view of every request.</strong><p>Explore the illustrative review queue without making a decision or changing a record.</p><Link href="/admin/applications" data-testid="link-admin-explore-review-queue">Explore review queue <ArrowRight size={14} /></Link></div>
        <section className="admin-panel"><SectionHead title="At a glance" subtitle="A snapshot of this fictional workspace." /><div className="admin-mini-stat"><span>Awaiting first look</span><strong>02</strong></div><div className="admin-mini-stat"><span>Under review</span><strong>02</strong></div><div className="admin-mini-stat"><span>Shortlisted</span><strong>01</strong></div></section>
      </div>
    </div>
    <div className="admin-overview-bottom">
      <section className="admin-panel"><SectionHead title="Recently joined" subtitle="Illustrative applicant profiles." href="/admin/applicants" link="View applicants" />{applicants.slice(0, 3).map(person => <div className="admin-simple-row" key={person.id}><strong>{person.name}</strong><span>{person.sector}</span></div>)}</section>
      <section className="admin-panel"><SectionHead title="Program landscape" subtitle="Example funding categories in this preview." href="/admin/grants" link="View programs" />{grants.slice(0, 3).map(grant => <div className="admin-simple-row" key={grant.id}><strong>{grant.title}</strong><span>Up to {money(grant.ceiling)}</span></div>)}</section>
    </div>
  </>;
}

function applicantDetail(person: Applicant): Detail {
  return { eyebrow: person.id, title: person.name, description: 'A fictional applicant profile for layout and navigation preview only.', fields: [
    { label: 'Email', value: person.email }, { label: 'Sector', value: person.sector }, { label: 'Country', value: person.country }, { label: 'Profile status', value: person.status }, { label: 'Joined', value: person.joined }, { label: 'Reference', value: person.id },
  ] };
}
function applicationDetail(item: Application): Detail {
  return { eyebrow: item.id, title: item.title, description: item.note, fields: [
    { label: 'Applicant', value: item.applicant }, { label: 'Grant program', value: item.program }, { label: 'Requested', value: money(item.amount) }, { label: 'Review status', value: item.status }, { label: 'Date', value: item.date }, { label: 'Reference', value: item.id },
  ] };
}
function grantDetail(grant: Grant): Detail {
  return { eyebrow: 'Grant program', title: grant.title, description: grant.description, fields: [
    { label: 'Funding ceiling', value: money(grant.ceiling) }, { label: 'Focus', value: grant.focus }, { label: 'Cycle', value: grant.cycle }, { label: 'Program status', value: grant.status },
  ] };
}

function Applicants({ openDetail }: { openDetail: (detail: Detail) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All statuses');
  const rows = applicants.filter(person => (filter === 'All statuses' || person.status === filter) && `${person.name} ${person.email} ${person.sector} ${person.country}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="admin-panel">
    <SectionHead title="Applicant directory" subtitle="Browse example profiles. These are invented names and contact details." />
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

function Applications({ openDetail }: { openDetail: (detail: Detail) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All statuses');
  const rows = applications.filter(item => (filter === 'All statuses' || item.status === filter) && `${item.title} ${item.applicant} ${item.program} ${item.id}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="admin-panel">
    <SectionHead title="Review queue" subtitle="Search fictional funding requests and open a read-only summary." />
    <div className="admin-toolbar"><div className="admin-toolbar-left"><label className="admin-search"><Search size={15} /><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search requests or applicants" aria-label="Search applications" data-testid="input-admin-search-applications" /></label><select className="admin-filter" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter applications by status" data-testid="select-admin-filter-applications"><option>All statuses</option><option>Submitted</option><option>Under review</option><option>Shortlisted</option><option>Draft</option></select></div><span className="admin-count" data-testid="text-admin-applications-count">{rows.length} of {applications.length} requests</span></div>
    {rows.length ? <>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Request</th><th>Program</th><th>Requested</th><th>Status</th><th>Date</th><th><span className="admin-eyebrow" style={{ margin: 0 }}>Explore</span></th></tr></thead><tbody>{rows.map(item => <tr key={item.id} data-testid={`row-admin-application-${item.id}`}><td><span className="admin-table-primary">{item.title}</span><span className="admin-table-secondary">{item.applicant} · {item.id}</span></td><td className="admin-table-muted">{item.program}</td><td className="admin-table-number">{money(item.amount)}</td><td><Badge status={item.status} /></td><td className="admin-table-muted">{item.date}</td><td><button type="button" className="admin-icon-button" onClick={() => openDetail(applicationDetail(item))} aria-label={`Preview application ${item.title}`} data-testid={`button-preview-admin-application-${item.id}`}><ArrowRight size={15} /></button></td></tr>)}</tbody></table></div>
      <div className="admin-mobile-records" role="list" aria-label="Funding requests">{rows.map(item => <article className="admin-mobile-record" role="listitem" key={item.id} data-testid={`card-admin-application-${item.id}`}>
        <div className="admin-mobile-record-top"><div className="admin-mobile-record-identity"><strong>{item.title}</strong><span>{item.applicant} · {item.id}</span></div><Badge status={item.status} /></div>
        <dl className="admin-mobile-record-facts"><div><dt>Program</dt><dd>{item.program}</dd></div><div><dt>Requested</dt><dd>{money(item.amount)}</dd></div><div><dt>Date</dt><dd>{item.date}</dd></div></dl>
        <button type="button" className="admin-mobile-record-action" onClick={() => openDetail(applicationDetail(item))} aria-label={`Preview application ${item.title}`} data-testid={`button-preview-admin-application-mobile-${item.id}`}>Preview request <ArrowRight size={15} /></button>
      </article>)}</div>
    </> : <EmptyResults onReset={() => { setQuery(''); setFilter('All statuses'); }} />}
  </section>;
}

function Grants({ openDetail }: { openDetail: (detail: Detail) => void }) {
  const [filter, setFilter] = useState('All programs');
  const visible = grants.filter(grant => filter === 'All programs' || grant.status === filter);
  return <>
    <div className="admin-toolbar"><span className="admin-count" data-testid="text-admin-grants-count">{visible.length} of {grants.length} example programs</span><select className="admin-filter" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter grant programs by status" data-testid="select-admin-filter-grants"><option>All programs</option><option>Active</option><option>Draft</option></select></div>
    <div className="admin-program-grid">{visible.map(grant => { const Icon = grant.icon; return <article className="admin-program-card" key={grant.id} data-testid={`card-admin-grant-${grant.id}`}><div className="admin-program-top"><span className="admin-program-icon"><Icon size={19} /></span><Badge status={grant.status} /></div><h2>{grant.title}</h2><p>{grant.description}</p><div className="admin-program-meta"><div><span>Funding ceiling</span><strong>Up to {money(grant.ceiling)}</strong></div><div><span>Focus</span><strong>{grant.focus}</strong></div></div><button type="button" onClick={() => openDetail(grantDetail(grant))} aria-label={`Preview ${grant.title} program details`} data-testid={`button-preview-admin-grant-${grant.id}`}>View program preview <ArrowRight size={14} /></button></article>; })}</div>
  </>;
}

function Settings() {
  return <><div className="admin-settings-grid">
    <section className="admin-panel"><SectionHead title="Workspace configuration" subtitle="A preview of where program controls could live. These settings cannot be changed here." />
      <div className="admin-setting-item"><ShieldCheck size={18} /><div><strong>Policy documents</strong><p>Future home for eligibility guidance, terms, and privacy documents. No policy is uploaded or published in this preview.</p></div><span>NOT CONNECTED</span></div>
      <div className="admin-setting-item"><Users size={18} /><div><strong>Applicant sectors</strong><p>Future controls for the sector options applicants can choose when building a profile.</p></div><span>NOT CONNECTED</span></div>
      <div className="admin-setting-item"><ClipboardList size={18} /><div><strong>Review stages</strong><p>A potential place to define queue stages and reviewer handoffs. No decisions can be recorded here.</p></div><span>NOT CONNECTED</span></div>
      <div className="admin-setting-item"><FileText size={18} /><div><strong>Program criteria</strong><p>Eligibility requirements and application questions would require a secured admin backend.</p></div><span>NOT CONNECTED</span></div>
    </section>
    <div className="admin-grid">
      <section className="admin-panel"><SectionHead title="Example sectors" subtitle="Illustrative labels, not live choices." /><div className="admin-sector-list"><span>Creative industries</span><span>Retail</span><span>Community</span><span>Climate</span><span>Food &amp; beverage</span></div><div className="admin-settings-callout"><strong>Configuration preview only</strong><p>Editing these options would require authenticated admin access and a backend. This screen does not save changes.</p></div></section>
      <section className="admin-panel"><SectionHead title="Access & safety" subtitle="Important before a real admin rollout." /><div className="admin-mini-stat"><span>Authorization</span><strong>Not enabled</strong></div><div className="admin-mini-stat"><span>Data source</span><strong>Local examples</strong></div><div className="admin-mini-stat"><span>Write access</span><strong>None</strong></div></section>
    </div>
  </div><AdminEmailSettings /></>;
}

const sectionCopy: Record<AdminSection, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: 'The grant team workspace', title: 'A better view of what matters.', description: 'A thoughtful place to orient around people, programs, and the requests between them.' },
  applicants: { eyebrow: 'People / Directory', title: 'The people behind the work.', description: 'Browse fictional applicant profiles across sectors and regions. Profiles open as read-only previews.' },
  inbox: { eyebrow: 'Workspace / Correspondence', title: 'The team inbox.', description: 'A quiet reading space for fictional grant correspondence. Explore the sample flow without sending or receiving email.' },
  applications: { eyebrow: 'Funding / Review queue', title: 'Every request, in context.', description: 'An illustrative queue designed to make the shape of each funding request easier to understand.' },
  grants: { eyebrow: 'Funding / Programs', title: 'Programs with a purpose.', description: 'Explore sample grant categories, their focus, and illustrative funding ceilings.' },
  settings: { eyebrow: 'Workspace / Configuration', title: 'A place for the rules.', description: 'See where policies, sectors, and review conventions could be managed in a future connected workspace.' },
};

export function AdminPage({ section }: { section: AdminSection }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const closeDetail = () => setDetail(null);
  useEffect(() => { setDetail(null); }, [section]);
  const copy = sectionCopy[section];
  const content: Record<AdminSection, ReactNode> = {
    overview: <Overview openDetail={setDetail} />,
    applicants: <Applicants openDetail={setDetail} />,
    inbox: <AdminInbox />,
    applications: <Applications openDetail={setDetail} />,
    grants: <Grants openDetail={setDetail} />,
    settings: <Settings />,
  };
  return <div className="admin-shell">
    <aside className="admin-sidebar"><div className="admin-brand"><span className="admin-brand-mark">a</span><span className="admin-brand-name">arc<span>.</span>fund</span><span className="admin-brand-divider" /><span className="admin-brand-role">Admin</span></div><div className="admin-sidebar-label">Workspace</div><nav className="admin-nav" aria-label="Admin navigation">{navItems.map(item => { const Icon = item.icon; return <Link key={item.section} href={item.href} className={`admin-nav-link ${section === item.section ? 'active' : ''}`} aria-current={section === item.section ? 'page' : undefined} data-testid={`link-admin-nav-${item.section}`}><Icon size={17} strokeWidth={1.8} />{item.label}</Link>; })}</nav><div className="admin-sidebar-bottom"><div className="admin-sidebar-rule" /><div className="admin-sidebar-note"><strong>Preview workspace</strong>Illustrative records only. No account access, decisions, or persistent changes are available here.</div><div className="admin-sidebar-index">ARC / TEAM SPACE 001</div></div></aside>
    <main className="admin-main"><header className="admin-topbar"><div className="admin-topbar-left"><div className="admin-mobile-brand"><span className="admin-brand-mark">a</span><span>arc.fund <span style={{ color: '#7b887b', fontWeight: 500 }}>/ admin</span></span></div><div className="admin-breadcrumb">Team workspace <span>/</span> <strong>{section === 'grants' ? 'Grant programs' : section[0].toUpperCase() + section.slice(1)}</strong></div></div><div className="admin-topbar-right"><span className="admin-preview-pill" data-testid="status-admin-preview">Preview mode</span><span className="admin-avatar" aria-label="Illustrative team avatar">AT</span></div></header>
      <div className="admin-content"><div className="admin-demo-banner" role="note" data-testid="notice-admin-demo"><Info size={17} /><div><strong>Illustrative admin preview — not a live workspace</strong><p>No real applicant information is shown. Nothing here is stored across reloads, submitted, approved, or paid out. This page does not provide admin access control.</p></div></div><div className="admin-pagehead"><div><p className="admin-eyebrow">{copy.eyebrow}</p><h1 data-testid={`heading-admin-${section}`}>{copy.title}</h1><p>{copy.description}</p></div><span className="admin-date">SAMPLE WORKSPACE / 2025</span></div>{content[section]}</div>
    </main>
    <nav className="admin-mobile-nav" aria-label="Admin mobile navigation">{navItems.map(item => { const Icon = item.icon; return <Link key={item.section} href={item.href} className={section === item.section ? 'active' : ''} aria-current={section === item.section ? 'page' : undefined} data-testid={`link-admin-mobile-${item.section}`}><Icon size={18} strokeWidth={1.8} /><span>{item.section === 'applications' ? 'Queue' : item.section === 'applicants' ? 'People' : item.section === 'overview' ? 'Home' : item.section === 'inbox' ? 'Inbox' : item.section === 'settings' ? 'Settings' : 'Grants'}</span></Link>; })}</nav>
    {detail && <DetailPanel detail={detail} onClose={closeDetail} />}
  </div>;
}

export default AdminPage;