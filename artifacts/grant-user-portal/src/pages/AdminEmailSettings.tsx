import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { format } from 'date-fns';
import { Copy, Globe2, Info, KeyRound, Mail, Radio, RefreshCw, ShieldCheck, Webhook } from 'lucide-react';
import {
  addEmailDomain, getEmailDomain, getEmailSettings, getEmailStatus, getSignupEmailSetting, saveEmailSettings, sendAuthEmailsThroughResend, sendTestEmail, setAuthEmailTemplates, setSignupEmailSetting, verifyEmailDomain,
  type EmailDomain, type EmailSettings, type EmailSettingsInput, type EmailStatus, type SignupEmailSetting,
} from '@workspace/api-client-react';
import { apiError } from '@/lib/serverData';
import { useAppName } from '@/lib/appName';
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
  if (signedIn && can('staff.manage')) return <EmailAdmin />;
  return <section className="admin-panel admin-email-settings" aria-labelledby="admin-email-settings-title">
    <div className="admin-panel-head"><div><p className="admin-email-settings-kicker">DELIVERY / RESEND</p><h2 id="admin-email-settings-title">Email configuration</h2><p>{signedIn ? 'Delivery status is visible to super admins.' : 'The connection checklist for official correspondence. Nothing here is active in this demo.'}</p></div><span className="admin-email-settings-state">{signedIn ? 'SUPER ADMIN ONLY' : 'NOT CONNECTED'}</span></div>
    {!signedIn && <><div className="admin-email-settings-banner"><Info size={17} /><span>In demo mode nothing is sent. The sample inbox does not send, receive, or sync messages.</span></div>
    <div className="admin-email-settings-list">{configuration.map(({ icon: Icon, label, value, detail }) => <div className="admin-email-settings-row" key={label}><span className="admin-email-settings-icon"><Icon size={17} /></span><div><strong>{label}</strong><p>{detail}</p></div><span className="admin-email-settings-value" data-testid={`status-email-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{value}</span></div>)}</div></>}
  </section>;
}

type Flash = { tone: 'ok' | 'error'; text: string } | null;

/** Super admins, signed in: every email setting, the domain, the webhook, sign-up confirmation, and delivery status. */
function EmailAdmin() {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setSettings(await getEmailSettings()); setLoadError(null); } catch (err) { setLoadError(apiError(err, "Couldn't load the email settings.").error); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <>
    <SignupConfirmation tokenSet={!!settings?.supabaseToken.set} sending={!!settings?.sending} />
    <section className="admin-panel admin-email-settings" aria-labelledby="email-connection-title" data-testid="panel-admin-email-settings">
      <div className="admin-panel-head"><div><p className="admin-email-settings-kicker">DELIVERY / RESEND</p><h2 id="email-connection-title">Email connection</h2><p>The Resend account the app sends and receives mail through. Keys and secrets are stored encrypted on the server and never shown again; leave a secret blank to keep the saved one.</p></div>
        <span className="admin-email-settings-state" data-testid="status-email-configured">{settings === null ? '…' : settings.sending ? 'SENDING' : 'OFF'}</span></div>
      {loadError && <p className="admin-field-error">{loadError}</p>}
      {settings && <ConnectionForm settings={settings} onSaved={setSettings} />}
    </section>
    {settings && <DomainPanel settings={settings} onChanged={load} />}
    {settings && <WebhookPanel settings={settings} />}
    <DeliveryStatus />
  </>;
}

function SignupConfirmation({ tokenSet, sending }: { tokenSet: boolean; sending: boolean }) {
  const [state, setState] = useState<SignupEmailSetting | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  useEffect(() => { let live = true; getSignupEmailSetting().then(s => { if (live) setState(s); }).catch(() => { if (live) setState({ connected: false, emailConfirmation: null }); }); return () => { live = false; }; }, [tokenSet]);
  const run = async (action: () => Promise<SignupEmailSetting>, done: (s: SignupEmailSetting) => string, failed: string) => {
    setBusy(true); setFlash(null);
    try { const next = await action(); setState(next); setFlash({ tone: 'ok', text: done(next) }); }
    catch (err) { setFlash({ tone: 'error', text: apiError(err, failed).error }); }
    finally { setBusy(false); }
  };
  const toggle = () => {
    if (!state?.connected || state.emailConfirmation === null) return;
    void run(() => setSignupEmailSetting({ emailConfirmation: !state.emailConfirmation }), next => next.emailConfirmation ? 'New accounts must confirm their email.' : 'New accounts are confirmed automatically.', "Couldn't change the setting.");
  };
  const on = state?.emailConfirmation;
  const smtp = state?.smtp;
  const { name: appName } = useAppName();
  return <section className="admin-panel admin-email-settings" aria-labelledby="signup-confirm-title" data-testid="panel-admin-signup-confirmation">
    <div className="admin-panel-head"><div><p className="admin-email-settings-kicker">SIGN-UP / SUPABASE</p><h2 id="signup-confirm-title">Email verification at sign-up</h2><p>When on, new applicants and staff must click the link in a confirmation email before they can sign in. When off, accounts work straight away, but anyone can sign up with an address they don't own.</p></div>
      <button type="button" className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={!!on} aria-label="Require email verification at sign-up" disabled={!state?.connected || busy} onClick={toggle} data-testid="switch-signup-email-confirmation" /></div>
    {state && !state.connected && <div className="admin-email-settings-banner"><Info size={17} /><span>{state.error ? `Supabase refused the saved token: ${state.error}` : 'To control this from here, save a Supabase access token under Email connection below.'} You can also change it in Supabase → Authentication → Sign In / Providers → Email → Confirm email.</span></div>}
    {state?.connected && smtp && <div className="admin-email-settings-list">
      <div className="admin-email-settings-row"><span className="admin-email-settings-icon"><Mail size={17} /></span><div><strong>Sent through Resend</strong><p>Confirmation, password-reset, and verification-code emails come from Supabase. Its built-in mailer allows only a few emails an hour from a generic sender; this points it at Resend with the saved key and sender. Press again after changing the Resend key or sender.{smtp.emailsPerHour !== null ? ` Supabase currently allows ${smtp.emailsPerHour} emails an hour (Authentication → Rate Limits).` : ''}</p></div>
        <span className="admin-email-settings-value" data-testid="status-auth-smtp">{smtp.viaResend ? `Resend${smtp.sender ? ` · ${smtp.sender}` : ''}` : smtp.host ? `Other (${smtp.host})` : "Supabase's mailer"}</span>
        <button type="button" className="admin-btn" disabled={busy || !sending} title={sending ? undefined : 'Save a Resend API key and a sender first.'} onClick={() => void run(sendAuthEmailsThroughResend, next => `Supabase's emails now go through Resend${next.smtp?.sender ? ` from ${next.smtp.sender}` : ''}.`, "Couldn't update Supabase.")} data-testid="button-auth-smtp-resend">{smtp.viaResend ? 'Update' : 'Use Resend'}</button></div>
      <div className="admin-email-settings-row"><span className="admin-email-settings-icon"><ShieldCheck size={17} /></span><div><strong>Email wording</strong><p>Replaces Supabase's default text for the confirmation, reset, invite, email-change, sign-in link, and code emails with the app's own, under the application name. Press Reapply after changing the name.</p></div>
        <span className="admin-email-settings-value" data-testid="status-auth-templates">{state.appTemplates ? appName : 'Supabase default'}</span>
        <button type="button" className="admin-btn" disabled={busy} onClick={() => void run(setAuthEmailTemplates, () => `Supabase's emails now use the app's wording as ${appName}.`, "Couldn't update Supabase.")} data-testid="button-auth-templates">{state.appTemplates ? 'Reapply' : 'Use app wording'}</button></div>
    </div>}
    {state?.connected && <div className="admin-email-settings-banner"><Info size={17} /><span>Use a scoped access token limited to this project, with only Auth read & write and a short expiry. A legacy token can manage every project in the Supabase account. Remove the token under Email connection once setup is done: these settings stay in Supabase.</span></div>}
    {flash && <p className={flash.tone === 'error' ? 'admin-field-error' : 'admin-review-hint'} role="status">{flash.text}</p>}
  </section>;
}

function ConnectionForm({ settings, onSaved }: { settings: EmailSettings; onSaved: (s: EmailSettings) => void }) {
  const initial = { resendKey: '', fromAddress: settings.fromSource === 'settings' ? settings.from ?? '' : '', replyTo: settings.replyTo ?? '', appUrl: settings.appUrl ?? '', inboxAddress: settings.inboxAddress ?? '', webhookSecret: '', supabaseToken: '' };
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState('');
  const set = (key: keyof typeof form, value: string) => { setForm(f => ({ ...f, [key]: value })); setErrors(({ [key]: _, ...rest }) => rest); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const patch: EmailSettingsInput = {};
    for (const key of ['resendKey', 'webhookSecret', 'supabaseToken'] as const) if (form[key].trim()) patch[key] = form[key].trim();
    for (const key of ['fromAddress', 'replyTo', 'appUrl', 'inboxAddress'] as const) if (form[key].trim() !== initial[key]) patch[key] = form[key].trim();
    if (!Object.keys(patch).length) { setFlash({ tone: 'error', text: 'Nothing changed.' }); return; }
    setBusy(true); setFlash(null);
    try { const saved = await saveEmailSettings(patch); onSaved(saved); setForm(f => ({ ...f, resendKey: '', webhookSecret: '', supabaseToken: '' })); setErrors({}); setFlash({ tone: 'ok', text: 'Saved. Changes apply to the next email sent.' }); }
    catch (err) { const failure = apiError(err, "Couldn't save the settings."); setErrors(failure.fieldErrors ?? {}); setFlash({ tone: 'error', text: failure.error }); }
    finally { setBusy(false); }
  };
  const clear = async (key: 'resendKey' | 'webhookSecret' | 'supabaseToken') => {
    setBusy(true);
    try { onSaved(await saveEmailSettings({ [key]: '' })); setFlash({ tone: 'ok', text: 'Removed.' }); } catch (err) { setFlash({ tone: 'error', text: apiError(err, "Couldn't remove it.").error }); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setFlash(null);
    try { setFlash({ tone: 'ok', text: (await sendTestEmail({ to: testTo.trim() })).message }); } catch (err) { setFlash({ tone: 'error', text: apiError(err, "Couldn't send the test.").error }); } finally { setBusy(false); }
  };
  const field = (key: keyof typeof form, label: string, hint: string, opts: { secret?: boolean; placeholder?: string; saved?: string | null; clearable?: boolean } = {}) =>
    <label className="admin-review-field" key={key}><span>{label}</span>
      <span style={{ display: 'flex', gap: 6 }}><input className="admin-input" style={{ flex: 1 }} type={opts.secret ? 'password' : 'text'} autoComplete="off" value={form[key]} onChange={e => set(key, e.target.value)} placeholder={opts.saved ? `Saved (…${opts.saved})` : opts.placeholder} aria-invalid={!!errors[key]} data-testid={`input-email-${key}`} />
        {opts.clearable && <button type="button" className="admin-btn" disabled={busy} onClick={() => void clear(key as 'resendKey')} data-testid={`button-clear-${key}`}>Remove</button>}</span>
      <small className={errors[key] ? 'admin-field-error' : ''}>{errors[key] ?? hint}</small></label>;
  return <form onSubmit={save} noValidate className="admin-email-form">
    {field('resendKey', 'Resend API key', settings.resendKey.source === 'environment' ? `Using the server's RESEND_API_KEY (…${settings.resendKey.last4}). Saving a key here overrides it.` : 'From Resend → API Keys. Use a key with full access so the domain can be set up from here.', { secret: true, placeholder: 're_…', saved: settings.resendKey.source === 'settings' ? settings.resendKey.last4 : null, clearable: settings.resendKey.source === 'settings' })}
    {field('fromAddress', 'Sender', settings.fromSource === 'environment' ? `Using the server's EMAIL_FROM (${settings.from}).` : 'The name and address emails come from, on your verified domain.', { placeholder: 'Nova Bridge Grants <grants@novabridgegrant.org>' })}
    {field('inboxAddress', 'Team mailbox address', 'Where applicants write to you (e.g. info@novabridgegrant.org). Mail to it arrives in the admin inbox; replies are sent from it.', { placeholder: 'info@novabridgegrant.org' })}
    {field('replyTo', 'Reply-to (optional)', 'Where replies to notification emails go. Leave empty to use the sender.', { placeholder: 'info@novabridgegrant.org' })}
    {field('appUrl', 'Portal address', 'Used for links in emails and the webhook address.', { placeholder: 'https://portal.novabridgegrant.org' })}
    {field('webhookSecret', 'Webhook signing secret', 'From Resend → Webhooks → your endpoint → Signing secret (starts with whsec_).', { secret: true, placeholder: 'whsec_…', saved: settings.webhook.secretSet ? '••••' : null, clearable: settings.webhook.secretSet })}
    {field('supabaseToken', 'Supabase access token', 'Lets this page manage sign-up verification and sign-in emails. Create one at supabase.com → Account → Access Tokens: a Project token for this project only, with Auth set to read & write and everything else None, expiring in 7 days. Remove it when you\'re done.', { secret: true, placeholder: 'Access token', saved: settings.supabaseToken.set ? '••••' : null, clearable: settings.supabaseToken.set })}
    <div className="admin-review-buttons" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <span className="admin-review-hint">{settings.updatedBy ? `Last changed by ${settings.updatedBy}${settings.updatedAt ? ` · ${format(new Date(settings.updatedAt), 'dd MMM yyyy, HH:mm')}` : ''}.` : 'Not changed from here yet.'}</span>
      <button type="submit" className="admin-btn primary" disabled={busy} data-testid="button-save-email-settings">{busy ? 'Saving…' : 'Save email settings'}</button>
    </div>
    {flash && <p className={flash.tone === 'error' ? 'admin-field-error' : 'admin-review-hint'} role="status" data-testid="status-email-settings">{flash.text}</p>}
    <div className="admin-form-row" style={{ alignItems: 'flex-end', marginTop: 10 }}>
      <label className="admin-review-field" style={{ flex: 1 }}><span>Send a test email</span><input className="admin-input" value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="you@example.org" data-testid="input-test-email" /></label>
      <button type="button" className="admin-btn" disabled={busy || !settings.sending} onClick={() => void test()} data-testid="button-send-test-email">Send test</button>
    </div>
  </form>;
}

function DomainPanel({ settings, onChanged }: { settings: EmailSettings; onChanged: () => Promise<void> }) {
  const [domain, setDomain] = useState<EmailDomain | null>(null);
  const [name, setName] = useState('');
  const [receiving, setReceiving] = useState(true);
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!settings.domain) { setDomain(null); return; }
    try { setDomain((await getEmailDomain()) as EmailDomain | null); } catch (err) { setFlash({ tone: 'error', text: apiError(err, "Couldn't load the domain from Resend.").error }); }
  }, [settings.domain]);
  useEffect(() => { void refresh(); }, [refresh]);
  const add = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setFlash(null);
    try { setDomain(await addEmailDomain({ name: name.trim(), receiving })); await onChanged(); setFlash({ tone: 'ok', text: 'Domain added in Resend. Create the DNS records below at your domain provider, then check.' }); }
    catch (err) { setFlash({ tone: 'error', text: apiError(err, "Couldn't add the domain.").error }); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setFlash(null);
    try { const d = await verifyEmailDomain(); setDomain(d); setFlash({ tone: 'ok', text: d.status === 'verified' ? 'Domain verified.' : 'Resend is checking the records. DNS changes can take up to a few hours; check again later.' }); }
    catch (err) { setFlash({ tone: 'error', text: apiError(err, "Couldn't check the domain.").error }); }
    finally { setBusy(false); }
  };
  return <section className="admin-panel admin-email-settings" aria-labelledby="email-domain-title" data-testid="panel-admin-email-domain">
    <div className="admin-panel-head"><div><p className="admin-email-settings-kicker">DOMAIN / DNS</p><h2 id="email-domain-title">Email domain</h2><p>The domain mail is sent from and received at. Resend gives you DNS records to add at your domain provider (where you bought the domain).</p></div>
      {domain && <span className="admin-email-settings-state" data-testid="status-email-domain">{domain.status.toUpperCase()}</span>}</div>
    {!settings.resendKey.set ? <p className="admin-review-hint">Save a Resend API key first.</p>
      : !settings.domain ? <form className="admin-form-row" style={{ alignItems: 'flex-end' }} onSubmit={add} noValidate>
        <label className="admin-review-field" style={{ flex: 1 }}><span>Domain</span><input className="admin-input" value={name} onChange={e => setName(e.target.value)} placeholder="novabridgegrant.org" data-testid="input-email-domain" /></label>
        <label className="admin-review-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={receiving} onChange={e => setReceiving(e.target.checked)} data-testid="checkbox-email-receiving" /><span>Also receive email</span></label>
        <button type="submit" className="admin-btn primary" disabled={busy || !name.trim()} data-testid="button-add-email-domain">Add domain</button>
      </form>
      : <>
        <p className="admin-review-hint"><strong>{settings.domain.name}</strong>{domain?.capabilities ? ` · sending ${domain.capabilities.sending ?? '—'}, receiving ${domain.capabilities.receiving ?? '—'}` : ''}</p>
        {domain?.records?.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Priority</th><th>Status</th></tr></thead><tbody>{domain.records.map((r, i) => <tr key={i}>
          <td>{r.type}</td><td><code>{r.name}</code></td><td style={{ maxWidth: 320, wordBreak: 'break-all' }}><code>{r.value ?? '—'}</code></td><td>{r.priority ?? ''}</td><td>{r.status}</td>
        </tr>)}</tbody></table></div> : <p className="admin-review-hint">Loading the DNS records…</p>}
        <div className="admin-review-buttons"><button type="button" className="admin-btn" onClick={() => void refresh()} disabled={busy}><RefreshCw size={13} /> Refresh</button><button type="button" className="admin-btn primary" onClick={() => void verify()} disabled={busy} data-testid="button-verify-email-domain">Check DNS records</button></div>
      </>}
    {flash && <p className={flash.tone === 'error' ? 'admin-field-error' : 'admin-review-hint'} role="status">{flash.text}</p>}
  </section>;
}

function WebhookPanel({ settings }: { settings: EmailSettings }) {
  const [copied, setCopied] = useState(false);
  const url = settings.webhook.url;
  const copy = async () => { if (!url) return; try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* select it by hand */ } };
  return <section className="admin-panel admin-email-settings" aria-labelledby="email-webhook-title" data-testid="panel-admin-email-webhook">
    <div className="admin-panel-head"><div><p className="admin-email-settings-kicker">WEBHOOK / RESEND</p><h2 id="email-webhook-title">Receiving and delivery webhook</h2><p>Resend calls this address when mail arrives for your domain (it lands in the admin inbox) and when sent mail is delivered or bounces.</p></div>
      <span className="admin-email-settings-state">{settings.webhook.secretSet ? 'SECRET SAVED' : 'NO SECRET'}</span></div>
    <div className="admin-email-settings-row"><span className="admin-email-settings-icon"><Webhook size={17} /></span><div><strong>Endpoint URL</strong><p>{url ? <code data-testid="text-webhook-url">{url}</code> : 'Save the portal address first.'}</p></div>{url && <button type="button" className="admin-btn" onClick={() => void copy()} data-testid="button-copy-webhook"><Copy size={13} /> {copied ? 'Copied' : 'Copy'}</button>}</div>
    <ol className="admin-review-hint" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
      <li>In Resend, open <strong>Webhooks → Add endpoint</strong> and paste the whole URL above, ending in <code>/api/email/webhook</code> (the site address alone gets a 404).</li>
      <li>Select the events <code>email.received</code>, <code>email.delivered</code>, <code>email.bounced</code>, <code>email.complained</code>, and <code>email.delivery_delayed</code>.</li>
      <li>Copy the endpoint's <strong>signing secret</strong> (whsec_…) into <em>Webhook signing secret</em> above and save.</li>
      <li>For receiving, the domain above needs receiving turned on and its MX record in your DNS.</li>
    </ol>
  </section>;
}

function DeliveryStatus() {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setStatus(await getEmailStatus()); setError(null); } catch (err) { setError(apiError(err, "Couldn't load the email status.").error); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <section className="admin-panel admin-email-settings" aria-labelledby="admin-email-settings-title" data-testid="panel-admin-email-status">
    <div className="admin-panel-head"><div><p className="admin-email-settings-kicker">OUTBOX</p><h2 id="admin-email-settings-title">Email delivery</h2><p>Copies of applicant notifications and staff invitations, queued with the change that causes them and sent by the server, retrying for about eight hours.</p></div>
      <button type="button" className="admin-btn" onClick={() => void load()} data-testid="button-refresh-email-status"><RefreshCw size={13} /> Refresh</button></div>
    {error && <p className="admin-field-error">{error}</p>}
    {status && <>
      <div className="admin-email-counts">{(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map(k => <div key={k} data-testid={`count-email-${k}`}><strong>{status.counts[k]}</strong><span>{STATUS_LABEL[k]}</span></div>)}</div>
      {status.recent.length === 0 ? <p className="admin-review-hint">Nothing sent yet.</p>
        : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Queued</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>{status.recent.map(m => <tr key={m.seq} data-testid={`row-email-${m.seq}`}>
          <td>{format(new Date(m.createdAt), 'dd MMM, HH:mm')}</td><td>{m.to}</td><td>{m.subject}</td>
          <td><strong>{STATUS_LABEL[m.status]}</strong>{m.attempts > 1 ? ` · ${m.attempts} tries` : ''}{m.lastError && m.status !== 'sent' ? <div className="admin-table-muted">{m.lastError}</div> : null}</td>
        </tr>)}</tbody></table></div>}
    </>}
  </section>;
}
