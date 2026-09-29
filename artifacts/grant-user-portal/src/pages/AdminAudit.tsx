import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Lock, Search } from 'lucide-react';
import { format } from 'date-fns';
import { auditToCsv, auditToJson, filterAudit } from '@workspace/domain/audit';
import { can, ROLE_LABELS } from '@workspace/domain/staff';
import { useServerData } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import { downloadText } from '@/lib/download';
import { RoleNotice } from './AdminStaff';

const when = (iso: string) => format(new Date(iso), 'dd MMM yyyy, HH:mm:ss');

/** Read-only, append-only audit trail with filters and CSV/JSON export. */
export function AdminAudit() {
  const { state } = useDemoStore();
  const { connected, auditChain, refreshActivity } = useServerData();
  useEffect(() => { void refreshActivity(); }, [refreshActivity]);
  const [query, setQuery] = useState('');
  const [staffId, setStaffId] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  if (!can(state, 'audit.view')) return <section className="admin-panel"><div className="admin-empty"><Lock size={25} /><h3>Audit log restricted</h3><RoleNotice permission="audit.view" /></div></section>;

  const rows = filterAudit(state, { query, staffId, action, from, to });
  const actions = [...new Set(state.audit.map(e => e.action))].sort();
  // Everyone who appears in the log, so filtering works for server staff too.
  const people = [...new Map(state.audit.map(e => [e.staffId, e.staffName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const reset = () => { setQuery(''); setStaffId(''); setAction(''); setFrom(''); setTo(''); };
  const stamp = format(new Date(), 'yyyyMMdd-HHmm');

  return <section className="admin-panel" data-testid="panel-admin-audit">
    <div className="admin-panel-head"><div><h2>Audit trail</h2><p>{connected
      ? 'Every staff action, who took it under which role, from which address, the record it touched, and what changed. Entries are stored on the server and chained by hash, so any edit or deletion is detectable.'
      : 'Every staff action, who took it under which role, the record it touched, and what changed. Entries can\'t be edited or deleted from any role. IP addresses aren\'t captured because there is no server; resetting the sample data clears this browser\'s log.'}</p></div>
      <div className="admin-review-buttons"><button type="button" className="admin-btn" disabled={!rows.length} onClick={() => downloadText(`arc-fund-audit-${stamp}.csv`, auditToCsv(rows), 'text/csv')} data-testid="button-admin-audit-csv"><Download size={13} /> CSV</button><button type="button" className="admin-btn" disabled={!rows.length} onClick={() => downloadText(`arc-fund-audit-${stamp}.json`, auditToJson(rows), 'application/json')} data-testid="button-admin-audit-json"><Download size={13} /> JSON</button></div></div>
    {auditChain && <div className={`admin-review-flash ${auditChain.intact ? 'ok' : 'error'}`} role="status" data-testid="status-admin-audit-chain">{auditChain.intact
      ? `Integrity check passed: all ${auditChain.checked} entries match their hashes.`
      : `Integrity check failed at ${auditChain.brokenAt}: that entry or an earlier one was changed or removed outside the app. Treat the log as compromised and investigate.`}</div>}
    <div className="admin-toolbar admin-audit-toolbar"><div className="admin-toolbar-left">
      <label className="admin-search"><Search size={15} /><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search records, people, summaries" aria-label="Search audit log" data-testid="input-admin-search-audit" /></label>
      <select className="admin-filter" value={staffId} onChange={e => setStaffId(e.target.value)} aria-label="Filter by staff member" data-testid="select-admin-audit-staff"><option value="">All staff</option>{people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <select className="admin-filter" value={action} onChange={e => setAction(e.target.value)} aria-label="Filter by action" data-testid="select-admin-audit-action"><option value="">All actions</option>{actions.map(a => <option key={a}>{a}</option>)}</select>
      <input className="admin-filter" type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="From date" data-testid="input-admin-audit-from" />
      <input className="admin-filter" type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="To date" data-testid="input-admin-audit-to" />
    </div><span className="admin-count" data-testid="text-admin-audit-count">{rows.length} of {state.audit.length} entries</span></div>
    {rows.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Timestamp</th><th>Admin user</th><th>Action</th><th>Entity</th><th>Target user</th><th>IP address</th><th>Risk</th></tr></thead><tbody>{rows.map(e => <Fragment key={e.id}>
      <tr data-testid={`row-admin-audit-${e.id}`}>
        <td className="admin-table-muted"><button type="button" className="admin-audit-toggle" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id} aria-label={`${open === e.id ? 'Hide' : 'Show'} changes for ${e.id}`} data-testid={`button-admin-audit-expand-${e.id}`}>{open === e.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>{when(e.at)}</td>
        <td><span className="admin-table-primary">{e.staffName}</span><span className="admin-table-secondary">{ROLE_LABELS[e.role]} · {e.staffId}</span></td>
        <td><span className="admin-table-primary">{e.action}</span><span className="admin-table-secondary">{e.summary}</span></td>
        <td className="admin-table-muted">{e.target}</td>
        <td className="admin-table-muted">{e.applicantId ?? '—'}</td>
        <td className="admin-table-muted">{e.ip ?? 'Not captured'}</td>
        <td className="admin-table-number">{e.riskScore ?? '—'}</td>
      </tr>
      {open === e.id && <tr className="admin-audit-detail"><td colSpan={7}>{e.changes.length ? <table className="admin-audit-changes"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>{e.changes.map(c => <tr key={c.field}><td>{c.field}</td><td>{c.before}</td><td>{c.after}</td></tr>)}</tbody></table> : <span className="admin-table-muted">No field changes recorded on the target (the action created related records only).</span>}</td></tr>}
    </Fragment>)}</tbody></table></div>
      : <div className="admin-empty" data-testid="empty-admin-audit"><Search size={25} /><h3>{state.audit.length ? 'Nothing matches these filters' : 'No staff actions yet'}</h3><p>{state.audit.length ? 'Try a wider date range or clear the filters.' : 'Reviews, payouts, settings changes, and account actions appear here as staff take them.'}</p>{state.audit.length > 0 && <button type="button" onClick={reset} data-testid="button-admin-audit-reset">Clear filters</button>}</div>}
  </section>;
}
