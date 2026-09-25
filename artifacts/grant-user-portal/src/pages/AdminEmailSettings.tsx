import { Globe2, Info, KeyRound, Mail, Radio, ShieldCheck, Webhook } from 'lucide-react';
import './AdminEmailSettings.css';

const configuration = [
  { icon: KeyRound, label: 'Resend API key', value: 'Not configured', detail: 'A future server-side secret only. Never paste an API key into this browser preview.' },
  { icon: Globe2, label: 'Sending domain', value: 'Not configured', detail: 'A verified domain and DNS records will be needed before any outbound mail.' },
  { icon: Mail, label: 'Sender / from address', value: 'Not configured', detail: 'The official address that would appear as the sender after domain verification.' },
  { icon: Radio, label: 'Receiving address & domain', value: 'Not configured', detail: 'An inbound mailbox and receiving domain have not been assigned.' },
  { icon: ShieldCheck, label: 'Inbound MX verification', value: 'Not verified', detail: 'MX records must be configured and verified before messages can be received.' },
  { icon: Webhook, label: 'Inbound webhook endpoint', value: 'Not configured', detail: 'No endpoint exists in this preview. A secured server route would be required.' },
  { icon: ShieldCheck, label: 'Webhook signing', value: 'Not configured', detail: 'A server-side signing secret and signature verification are required to trust inbound events.' },
];

export function AdminEmailSettings() {
  return <section className="admin-panel admin-email-settings" aria-labelledby="admin-email-settings-title">
    <div className="admin-panel-head"><div><p className="admin-email-settings-kicker">DELIVERY / RESEND</p><h2 id="admin-email-settings-title">Email configuration</h2><p>The connection checklist for future official correspondence. Nothing here is active or editable in this preview.</p></div><span className="admin-email-settings-state">NOT CONNECTED</span></div>
    <div className="admin-email-settings-banner"><Info size={17} /><span>Mail delivery and inbound processing require a secured backend. The sample inbox does not send, receive, or sync messages.</span></div>
    <div className="admin-email-settings-list">{configuration.map(({ icon: Icon, label, value, detail }) => <div className="admin-email-settings-row" key={label}><span className="admin-email-settings-icon"><Icon size={17} /></span><div><strong>{label}</strong><p>{detail}</p></div><span className="admin-email-settings-value" data-testid={`status-email-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{value}</span></div>)}</div>
  </section>;
}