import { useCallback, useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Globe2, Info, KeyRound, Mail, Radio, RefreshCw, ShieldCheck, Webhook } from 'lucide-react';
import { getEmailStatus, type EmailStatus } from '@workspace/api-client-react';
import { apiError } from '@/lib/serverData';
import { useCan } from './AdminStaff';
import './AdminEmailSettings.css';

const configuration = [
  { icon: KeyRound, label: 'Resend API key', value: 'Not configured', detail: 'A server-side secret only. Never paste an API key into this browser preview.' },
  { icon: Globe2, label: 'Sending domain', value: 'Not configured', detail: 'A verified domain and DNS records will be needed before any outbound mail.' },
  { icon: Mail, label: 'Sender / from address', value: 'Not configured', detail: 'The official address that would appear as the sender after domain verification.' },
  { icon: Radio, label: 'Receiving address & domain', value: 'Not configured', detail: 'An inbound mailbox and receiving domain have not been assigned.' },
  { icon: ShieldCheck, label: 'Inbound MX verification', value: 'Not verified', detail: 'MX records must be configured and verified before messages can be received.' },
  { icon: Webhook, label: 'Inbound webhook endpoint', value: 'Not configured', detail: 'No endpoint exists in this preview. A secured server route would be required.' },
  { icon: ShieldCheck, label: 'Webhook signing', value: 'Not configured', detail: 'A server-side signing secret and signature verification are required to trust inbound events.' },
];

const STATUS_LABEL = { queued: 'Queued', sending: 'Sending', sent: 'Sent', failed: 'Failed', skipped: 'Skipped' } as const;

export function AdminEmailSettings({ signedIn = false }: { signedIn?: boolean }) {
  const can = useCan();
  if (signedIn && can('staff.manage')) return <LiveEmailStatus />;
  return <section className="admin-panel admin-email-settings" aria-labelledby="admin-email-settings-title">
    <div className="admin-panel-head"><div><p className="admin-email-settings-kicker">DELIVERY / RESEND</p><h2 id="admin-email-settings-title">Email configuration</h2><p>{signedIn ? 'Delivery status is visible to super admins.' : 'The connection checklist for official correspondence. Nothing here is active in this demo.'}</p></div><span className="admin-email-settings-state">{signedIn ? 'SUPER ADMIN ONLY' : 'NOT CONNECTED'}</span></div>
    {!signedIn && <><div className="admin-email-settings-banner"><Info size={17} /><span>In demo mode nothing is sent. The sample inbox does not send, receive, or sync messages.</span></div>
    <div className="admin-email-settings-list">{configuration.map(({ icon: Icon, label, value, detail }) => <div className="admin-email-settings-row" key={label}><span className="admin-email-settings-icon"><Icon size={17} /></span><div><strong>{label}</strong><p>{detail}</p></div><span className="admin-email-settings-value" data-testid={`status-email-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{value}</span></div>)}</div></>}
  </section>;
}

/** Super admins, signed in: whether Resend is configured, and what the outbox has done. */
function LiveEmailStatus() {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setStatus(await getEmailStatus()); setError(null); } catch (err) { setError(apiError(err, "Couldn't load the email status.").error); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const on = status?.configured;
  return <section className="admin-panel admin-email-settings" aria-labelledby="admin-email-settings-title" data-testid="panel-admin-email-status">
    <div className="admin-panel-head"><div><p className="admin-email-settings-kicker">DELIVERY / RESEND</p><h2 id="admin-email-settings-title">Email delivery</h2><p>Copies of applicant notifications and staff invitations. Messages are queued with the change that causes them and sent by the server, retrying for about eight hours.</p></div>
      <span className="admin-email-settings-state" data-testid="status-email-configured">{status === null ? '…' : on ? 'SENDING' : 'OFF'}</span></div>
    {error && <p className="admin-field-error">{error}</p>}
    {status && <>
      {!on && <div className="admin-email-settings-banner"><Info size={17} /><span>Email is off: set <code>RESEND_API_KEY</code> and <code>EMAIL_FROM</code> (an address on a domain verified in Resend) in the server's secrets and restart. Until then, queued messages are marked skipped, so nothing old is sent when you turn it on.</span></div>}
      <div className="admin-email-settings-row"><span className="admin-email-settings-icon"><Mail size={17} /></span><div><strong>Sender</strong><p>The from address on every message. Applicants can turn off email copies in their settings.</p></div><span className="admin-email-settings-value" data-testid="text-email-from">{status.from ?? 'Not set'}</span></div>
      <div className="admin-email-counts">{(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map(k => <div key={k} data-testid={`count-email-${k}`}><strong>{status.counts[k]}</strong><span>{STATUS_LABEL[k]}</span></div>)}</div>
      <div className="admin-panel-head" style={{ marginTop: 14 }}><div><h3 style={{ margin: 0, fontSize: 13 }}>Latest messages</h3></div><button type="button" className="admin-btn" onClick={() => void load()} data-testid="button-refresh-email-status"><RefreshCw size={13} /> Refresh</button></div>
      {status.recent.length === 0 ? <p className="admin-review-hint">Nothing sent yet.</p>
        : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Queued</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>{status.recent.map(m => <tr key={m.seq} data-testid={`row-email-${m.seq}`}>
          <td>{format(new Date(m.createdAt), 'dd MMM, HH:mm')}</td><td>{m.to}</td><td>{m.subject}</td>
          <td><strong>{STATUS_LABEL[m.status]}</strong>{m.attempts > 1 ? ` · ${m.attempts} tries` : ''}{m.lastError && m.status !== 'sent' ? <div className="admin-table-muted">{m.lastError}</div> : null}</td>
        </tr>)}</tbody></table></div>}
    </>}
  </section>;
}
