import { ArrowLeft, Info } from 'lucide-react';
import { Link } from 'wouter';
import { format } from 'date-fns';
import { findApplicant } from '@workspace/domain/applicants';
import type { Transaction } from '@workspace/domain/model';
import { useServerData } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import { ApplicantDetails } from './AdminApplicantPanel';
import { CardManager, CardSettingsEditor, cardSettingsFor, useCardHolder } from './AdminCards';

// The admin user profile: one applicant's identity, account controls,
// balances, cards and card rules, and recent ledger, on one page. Opened from
// the Applicants directory (/admin/applicants/<id>).

const usd = (value: number) => `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string) => format(new Date(iso), 'dd MMM yyyy, HH:mm');
const statusClass = (tx: Transaction) => `admin-badge ${tx.status === 'Completed' ? 'approved' : tx.status === 'Failed' ? 'declined' : tx.status === 'Cancelled' ? 'draft' : 'submitted'}`;

export function AdminApplicantProfile({ applicantId }: { applicantId: string }) {
  const { state } = useDemoStore();
  const { connected, applicantsError } = useServerData();
  const { holder, loadError, replace, reload, demoOnly } = useCardHolder(applicantId);
  const person = findApplicant(state, applicantId);
  const back = <Link href="/admin/applicants" className="admin-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 16 }} data-testid="link-admin-back-to-applicants"><ArrowLeft size={14} /> All applicants</Link>;

  if (!person) return <>{back}<section className="admin-panel"><div className="admin-empty" data-testid="empty-admin-applicant-profile"><Info size={25} /><h3>{connected && !applicantsError ? 'Loading applicant…' : 'Applicant not found'}</h3><p>{applicantsError ?? 'They may have been removed, or the link is wrong.'}</p></div></section></>;

  const ledger = state.transactions.filter(t => t.applicantId === applicantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25);
  return <div data-testid="page-admin-applicant-profile">
    {back}
    <div className="admin-profile-grid">
      <section className="admin-panel admin-profile-panel" aria-label="Applicant"><ApplicantDetails applicantId={applicantId} /></section>
      <section className="admin-panel admin-profile-panel" aria-labelledby="admin-profile-cards-title">
        <div className="admin-panel-head"><div><h2 id="admin-profile-cards-title">Cards</h2><p>Card rules, the card balance, and both cards. The virtual card comes first; a physical card needs it.</p></div></div>
        <CardSettingsEditor applicantId={applicantId} settings={cardSettingsFor(state, applicantId, holder)} onSaved={() => void reload()} />
        {holder ? <CardManager holder={holder} onHolder={replace} />
          : demoOnly ? <p className="admin-review-hint" data-testid="text-admin-profile-cards-demo">In the demo only the applicant-portal user ({state.profile.name}) has cards. Card rules above still apply.</p>
          : loadError ? <p className="admin-field-error">{loadError}</p>
          : <p className="admin-review-hint">Loading cards…</p>}
      </section>
    </div>
    <section className="admin-panel" aria-labelledby="admin-profile-ledger-title" style={{ marginTop: 16 }}>
      <div className="admin-panel-head"><div><h2 id="admin-profile-ledger-title">Recent money activity</h2><p>The latest {ledger.length} ledger entries: awards, deposits, payouts, fees, and card moves.</p></div></div>
      {ledger.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Entry</th><th>Type</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>{ledger.map(tx => <tr key={tx.id} data-testid={`row-admin-profile-tx-${tx.id}`}>
        <td><span className="admin-table-primary">{tx.description}</span><span className="admin-table-secondary">{tx.id}{tx.processedBy ? ` · ${tx.processedBy}` : ''}{tx.note ? ` · "${tx.note}"` : ''}</span></td>
        <td className="admin-table-muted">{tx.type}</td>
        <td className="admin-table-number">{usd(tx.amount)}</td>
        <td><span className={statusClass(tx)}>{tx.status}</span></td>
        <td className="admin-table-muted">{when(tx.createdAt)}</td>
      </tr>)}</tbody></table></div>
        : <div className="admin-empty"><p>No money activity yet.</p></div>}
    </section>
  </div>;
}
