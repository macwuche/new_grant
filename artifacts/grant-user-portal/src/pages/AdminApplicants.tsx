import { useMemo, useState } from 'react';
import { ArrowDownUp, ChevronDown, ChevronLeft, ChevronRight, Download, Filter, Search, Users } from 'lucide-react';
import { format } from 'date-fns';
import { applicantRecords } from '@workspace/domain/applicants';
import type { KycStatus, Tier } from '@workspace/domain/model';
import { assessRisk, type RiskAssessment } from '@workspace/domain/risk';
import { reviewQueue } from '@workspace/domain/review';
import { computeBalances } from '@workspace/domain/rules';
import { useServerData } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import { downloadText } from '@/lib/download';
import { simpleActs, useAccountAction, type Outcome } from './AdminApplicantPanel';
import { ReasonDialog } from './AdminAccountDialogs';
import { useCan } from './AdminStaff';
import './AdminApplicantProfile.css';

// The applicant directory (/admin/applicants): every applicant with status,
// tier, identity, location, balances, and risk; tabs, search, sort, filters,
// row selection with CSV export, quick lock / unlock and tier change, and
// pagination. A row opens the applicant's profile page.

export type ApplicantRow = {
  id: string; name: string; email: string; phone: string; sector: string; country: string; joinedAt: string; joined: string;
  tier: Tier; kyc: KycStatus; locked: boolean; risk: RiskAssessment; grant: number; deposit: number; card: number; wallet: number;
  applications: number; activeGrants: number; current: boolean;
};

const shortDate = (iso: string) => format(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso), 'dd MMM yyyy');
const usd = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).map(part => part[0]).join('').slice(0, 2).toUpperCase();

export function useApplicantRows(): ApplicantRow[] {
  const { state } = useDemoStore();
  return useMemo(() => {
    const now = new Date();
    const queue = reviewQueue(state);
    return applicantRecords(state).map(p => {
      const apps = queue.filter(a => a.applicantId === p.id);
      const b = computeBalances(state.transactions.filter(t => t.applicantId === p.id));
      return {
        id: p.id, name: p.name, email: p.email, phone: p.phone, sector: p.sector, country: p.country, joinedAt: p.joined, joined: shortDate(p.joined),
        tier: p.tier, kyc: p.account.kyc.status, locked: p.account.status === 'Locked', risk: assessRisk(state, p.id, now),
        grant: b.grant, deposit: b.deposit, card: b.card, wallet: b.grant + b.deposit, applications: apps.length,
        activeGrants: apps.filter(a => a.status === 'Approved').length, current: p.current,
      };
    });
  }, [state]);
}

type Tab = 'all' | 'active' | 'locked' | 'pending' | 'verified';
const TABS: { id: Tab; label: string; match: (r: ApplicantRow) => boolean }[] = [
  { id: 'all', label: 'All users', match: () => true },
  { id: 'active', label: 'Active', match: r => !r.locked },
  { id: 'pending', label: 'Identity to review', match: r => r.kyc === 'Pending' },
  { id: 'verified', label: 'Verified', match: r => r.kyc === 'Verified' },
  { id: 'locked', label: 'Locked', match: r => r.locked },
];
type Sort = 'newest' | 'oldest' | 'name' | 'balance' | 'risk';
const SORTS: Record<Sort, { label: string; compare: (a: ApplicantRow, b: ApplicantRow) => number }> = {
  newest: { label: 'Newest first', compare: (a, b) => b.joinedAt.localeCompare(a.joinedAt) },
  oldest: { label: 'Oldest first', compare: (a, b) => a.joinedAt.localeCompare(b.joinedAt) },
  name: { label: 'Name A–Z', compare: (a, b) => a.name.localeCompare(b.name) },
  balance: { label: 'Highest balance', compare: (a, b) => b.wallet - a.wallet },
  risk: { label: 'Highest risk', compare: (a, b) => b.risk.score - a.risk.score },
};
type Narrow = 'any' | 'tier-1' | 'tier-2' | 'tier-3' | 'high-risk' | 'no-identity';
const NARROW: Record<Narrow, { label: string; match: (r: ApplicantRow) => boolean }> = {
  any: { label: 'All tiers and risk', match: () => true },
  'tier-1': { label: 'Tier 1 · Basic', match: r => r.tier === 1 },
  'tier-2': { label: 'Tier 2 · Verified', match: r => r.tier === 2 },
  'tier-3': { label: 'Tier 3 · Enterprise', match: r => r.tier === 3 },
  'high-risk': { label: 'High risk', match: r => r.risk.level === 'High' },
  'no-identity': { label: 'Identity not submitted', match: r => r.kyc === 'Not submitted' },
};
const PAGE_SIZES = [10, 25, 50];

export const KYC_TONE: Record<KycStatus, string> = { Verified: 'good', Pending: 'warn', Rejected: 'bad', 'Not submitted': 'neutral' };
export const KYC_TEXT: Record<KycStatus, string> = { Verified: 'Verified', Pending: 'To review', Rejected: 'Rejected', 'Not submitted': 'Not submitted' };

/** Spreadsheet-safe CSV cell: quoted, and never starting like a formula. */
const cell = (value: string | number) => { const text = String(value); return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`; };
function toCsv(rows: ApplicantRow[]) {
  const head = ['id', 'name', 'email', 'phone', 'country', 'sector', 'tier', 'identity', 'status', 'grant_balance', 'deposit_balance', 'card_balance', 'risk_score', 'joined'];
  return [head.join(','), ...rows.map(r => [r.id, r.name, r.email, r.phone, r.country, r.sector, r.tier, r.kyc, r.locked ? 'Locked' : 'Active', r.grant, r.deposit, r.card, r.risk.score, r.joinedAt].map(cell).join(','))].join('\n');
}

export function AdminApplicants({ openApplicant }: { openApplicant: (id: string) => void }) {
  const rows = useApplicantRows();
  const { connected, applicantsError } = useServerData();
  const can = useCan();
  const { busy, perform } = useAccountAction();
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [narrow, setNarrow] = useState<Narrow>('any');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ id: string; name: string; action: 'lock' | 'tier'; tier?: Tier } | null>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = rows
    .filter(r => TABS.find(t => t.id === tab)!.match(r) && NARROW[narrow].match(r))
    .filter(r => !q || `${r.name} ${r.email} ${r.phone} ${r.sector} ${r.country} ${r.id}`.toLowerCase().includes(q))
    .sort(SORTS[sort].compare);
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(page, pages);
  const shown = filtered.slice((current - 1) * size, current * size);
  const allShown = shown.length > 0 && shown.every(r => selected.has(r.id));
  const reset = (fn: () => void) => { fn(); setPage(1); };

  const toggle = (id: string) => setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const toggleShown = () => setSelected(prev => { const next = new Set(prev); shown.forEach(r => allShown ? next.delete(r.id) : next.add(r.id)); return next; });
  const exportRows = selected.size ? rows.filter(r => selected.has(r.id)) : filtered;
  const exportCsv = () => downloadText(`applicants-${format(new Date(), 'yyyyMMdd-HHmm')}.csv`, toCsv(exportRows), 'text/csv');
  const report = (outcome: Outcome) => setFlash(outcome.ok ? { tone: 'ok', text: outcome.message } : { tone: 'error', text: outcome.error });
  const unlock = async (r: ApplicantRow) => report(await perform(simpleActs(r.id).unlock, r.id));

  return <section className="aup-card aup-directory" data-testid="panel-admin-applicants">
    <div className="aup-directory-top">
      <div className="aup-tabs" role="tablist" aria-label="Applicant groups">
        {TABS.map(t => { const count = rows.filter(t.match).length; return <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => reset(() => setTab(t.id))} data-testid={`tab-admin-applicants-${t.id}`}>{t.label}<span>{count}</span></button>; })}
      </div>
      <button type="button" className="aup-btn primary" onClick={exportCsv} disabled={!exportRows.length} data-testid="button-admin-applicants-export">
        {selected.size ? `Export ${selected.size} selected` : 'Export CSV'} <Download size={15} />
      </button>
    </div>

    <div className="aup-directory-tools">
      <label className="aup-search"><input type="search" value={query} onChange={e => reset(() => setQuery(e.target.value))} placeholder="Search name, email, phone, country, or ID" aria-label="Search applicants" data-testid="input-admin-search-applicants" /><Search size={17} /></label>
      <label className="aup-select-pill"><span className="sr-only">Sort by</span><select value={sort} onChange={e => setSort(e.target.value as Sort)} aria-label="Sort applicants" data-testid="select-admin-sort-applicants">{(Object.keys(SORTS) as Sort[]).map(k => <option key={k} value={k}>{SORTS[k].label}</option>)}</select><ArrowDownUp size={15} /></label>
      <label className="aup-select-pill"><span className="sr-only">Filter</span><select value={narrow} onChange={e => reset(() => setNarrow(e.target.value as Narrow))} aria-label="Filter applicants" data-testid="select-admin-filter-applicants">{(Object.keys(NARROW) as Narrow[]).map(k => <option key={k} value={k}>{NARROW[k].label}</option>)}</select><Filter size={15} /></label>
    </div>

    {applicantsError && <div className="aup-flash error" role="alert" data-testid="status-admin-applicants-error">{applicantsError}</div>}
    {flash && <div className={`aup-flash ${flash.tone}`} role="status" data-testid="status-admin-applicants-flash">{flash.text}</div>}
    {!connected && <p className="aup-hint">Preview directory: invented people; the first is the applicant-portal preview user.</p>}

    {shown.length ? <>
      <div className="aup-table-wrap"><table className="aup-table aup-directory-table">
        <thead><tr>
          <th className="aup-check"><input type="checkbox" checked={allShown} onChange={toggleShown} aria-label="Select all on this page" data-testid="checkbox-admin-applicants-all" /></th>
          <th>User</th><th>Status</th><th>Tier</th><th>Identity</th><th>Location</th><th className="num">Balance</th><th>Risk</th><th className="end">Actions</th>
        </tr></thead>
        <tbody>{shown.map(r => <tr key={r.id} className={selected.has(r.id) ? 'selected' : ''} data-testid={`row-admin-applicant-${r.id}`}>
          <td className="aup-check"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} /></td>
          <td><button type="button" className="aup-user" onClick={() => openApplicant(r.id)} data-testid={`button-preview-admin-applicant-${r.id}`}>
            <span className="aup-avatar" aria-hidden="true">{initials(r.name)}</span>
            <span><strong>{r.name}</strong><small>{r.email}</small></span>
          </button></td>
          <td><span className={`aup-pill ${r.locked ? 'bad' : 'good'}`}>{r.locked ? 'Locked' : 'Active'}</span></td>
          <td>{can('accounts.tier')
            ? <label className="aup-inline-select"><select value={r.tier} onChange={e => { const next = Number(e.target.value) as Tier; if (next !== r.tier) setDialog({ id: r.id, name: r.name, action: 'tier', tier: next }); }} aria-label={`Tier for ${r.name}`} data-testid={`select-admin-row-tier-${r.id}`}>{([1, 2, 3] as Tier[]).map(t => <option key={t} value={t}>Tier {t}</option>)}</select><ChevronDown size={14} /></label>
            : <span className="aup-muted">Tier {r.tier}</span>}</td>
          <td><span className={`aup-pill ${KYC_TONE[r.kyc]}`}>{KYC_TEXT[r.kyc]}</span></td>
          <td className="aup-muted nowrap">{r.country || '—'}{r.sector && <small className="aup-sub">{r.sector}</small>}</td>
          <td className="num nowrap" title={`Grant ${usd(r.grant)} · deposit ${usd(r.deposit)} · card ${usd(r.card)}`}><strong>{usd(r.wallet)}</strong><small className="aup-sub">grant + deposit</small></td>
          <td><span className={`aup-pill ${r.risk.level === 'High' ? 'bad' : r.risk.level === 'Medium' ? 'warn' : 'neutral'}`} title={r.risk.factors.map(f => `${f.label} (+${f.points})`).join('\n') || 'No risk signals'}>{r.risk.level} · {r.risk.score}</span></td>
          <td className="end"><span className="aup-row-actions">
            {r.locked
              ? <button type="button" className="aup-btn sm" disabled={!can('accounts.manage') || busy} onClick={() => void unlock(r)} data-testid={`button-admin-row-unlock-${r.id}`}>Unlock</button>
              : <button type="button" className="aup-btn sm" disabled={!can('accounts.manage')} onClick={() => setDialog({ id: r.id, name: r.name, action: 'lock' })} data-testid={`button-admin-row-lock-${r.id}`}>Lock</button>}
            <button type="button" className="aup-btn sm" onClick={() => openApplicant(r.id)} data-testid={`button-admin-row-view-${r.id}`}>View</button>
          </span></td>
        </tr>)}</tbody>
      </table></div>

      <div className="aup-mobile-list" role="list" aria-label="Applicants">{shown.map(r => <article key={r.id} role="listitem" className="aup-mobile-row" data-testid={`card-admin-applicant-${r.id}`}>
        <div className="aup-mobile-row-top">
          <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} />
          <button type="button" className="aup-user" onClick={() => openApplicant(r.id)}><span className="aup-avatar" aria-hidden="true">{initials(r.name)}</span><span><strong>{r.name}</strong><small>{r.email}</small></span></button>
        </div>
        <div className="aup-mobile-row-pills"><span className={`aup-pill ${r.locked ? 'bad' : 'good'}`}>{r.locked ? 'Locked' : 'Active'}</span><span className="aup-pill neutral">Tier {r.tier}</span><span className={`aup-pill ${KYC_TONE[r.kyc]}`}>{KYC_TEXT[r.kyc]}</span></div>
        <dl className="aup-mobile-row-facts"><div><dt>Balance</dt><dd>{usd(r.wallet)}</dd></div><div><dt>Location</dt><dd>{r.country || '—'}</dd></div><div><dt>Risk</dt><dd>{r.risk.level} · {r.risk.score}</dd></div></dl>
        <button type="button" className="aup-btn block" onClick={() => openApplicant(r.id)} data-testid={`button-preview-admin-applicant-mobile-${r.id}`}>Open profile <ChevronRight size={15} /></button>
      </article>)}</div>

      <div className="aup-pager">
        <nav className="aup-pages" aria-label="Pages">
          <button type="button" disabled={current === 1} onClick={() => setPage(current - 1)} aria-label="Previous page"><ChevronLeft size={15} /></button>
          {pageList(current, pages).map((p, i) => p === '…' ? <span key={`gap-${i}`} aria-hidden="true">…</span>
            : <button key={p} type="button" className={p === current ? 'active' : ''} aria-current={p === current ? 'page' : undefined} onClick={() => setPage(p)} data-testid={`button-admin-applicants-page-${p}`}>{p}</button>)}
          <button type="button" disabled={current === pages} onClick={() => setPage(current + 1)} aria-label="Next page"><ChevronRight size={15} /></button>
        </nav>
        <span className="aup-count" data-testid="text-admin-applicants-count">{filtered.length ? `${(current - 1) * size + 1}–${Math.min(current * size, filtered.length)} of ${filtered.length}` : '0'} · {rows.length} total</span>
        <label className="aup-select-pill small"><span className="sr-only">Rows per page</span><select value={size} onChange={e => reset(() => setSize(Number(e.target.value)))} aria-label="Rows per page" data-testid="select-admin-applicants-page-size">{PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}</select><ChevronDown size={14} /></label>
      </div>
    </> : <div className="aup-empty" data-testid="empty-admin-applicants"><Users size={26} /><h3>{rows.length ? 'Nobody matches' : 'No applicants yet'}</h3><p>{rows.length ? 'Try another tab, a shorter search, or clear the filter.' : 'People appear here once they sign up and open the applicant portal.'}</p>
      {rows.length > 0 && <button type="button" className="aup-btn" onClick={() => { setTab('all'); setQuery(''); setNarrow('any'); setPage(1); }} data-testid="button-admin-applicants-reset">Clear filters</button>}</div>}

    {dialog && <ReasonDialog applicantId={dialog.id} name={dialog.name} action={dialog.action} tier={dialog.tier ?? null} onClose={() => setDialog(null)} onDone={outcome => { setDialog(null); report(outcome); }} />}
  </section>;
}

/** Page numbers with gaps: 1 2 … 6, around the current page. */
function pageList(current: number, pages: number): (number | '…')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const keep = new Set([1, pages, current - 1, current, current + 1].filter(p => p >= 1 && p <= pages));
  const sorted = [...keep].sort((a, b) => a - b);
  return sorted.flatMap((p, i) => (i && p - sorted[i - 1]! > 1 ? ['…' as const, p] : [p]));
}
