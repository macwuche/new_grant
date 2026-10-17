import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { format } from 'date-fns';
import { Archive, ArrowLeft, CornerUpLeft, Forward, Inbox, Lock, ReplyAll, Info, Mail, Paperclip, PenLine, RefreshCw, Search, Send, Trash2, X } from 'lucide-react';
import { getInbox, sendInboxEmail, updateInboxMessage, type InboxMessage, type InboxView } from '@workspace/api-client-react';
import { apiError } from '@/lib/serverData';
import { useSession } from '@/lib/session';
import './AdminInbox.css';

// The team mailbox (signed in): mail received through the Resend webhook, and
// mail sent from here through Resend. Received HTML is shown in a sandboxed
// frame with scripts, forms, and remote loading blocked.

type Folder = 'inbox' | 'sent' | 'archive' | 'trash';
const FOLDERS: { id: Folder; label: string; icon: typeof Inbox }[] = [
  { id: 'inbox', label: 'Inbox', icon: Inbox }, { id: 'sent', label: 'Sent', icon: Send }, { id: 'archive', label: 'Archive', icon: Archive }, { id: 'trash', label: 'Trash', icon: Trash2 },
];
/** `key`: one per message being written, so a double click or retry sends it once. `copies`: the Cc/Bcc fields are open. */
type Draft = { mode: 'new' | 'reply' | 'replyAll' | 'forward'; key: string; to: string; cc: string; bcc: string; copies: boolean; subject: string; text: string; inReplyTo?: string; attachments?: number };
const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const blank = (mode: Draft['mode'], fields: Partial<Draft> = {}): Draft => ({ mode, key: newKey(), to: '', cc: '', bcc: '', copies: false, subject: '', text: '', ...fields });
const unique = (list: string[]) => [...new Map(list.map(a => [a.toLowerCase(), a])).values()];

const when = (iso: string) => format(new Date(iso), 'dd MMM yyyy · HH:mm');
const nameOf = (address: string) => /^([^<]+)</.exec(address)?.[1]?.trim() || address.replace(/<|>/g, '');
const emailOf = (address: string) => /<([^>]+)>/.exec(address)?.[1] ?? address;
const BLOCKS = 'p,div,h1,h2,h3,h4,h5,h6,li,tr,table,blockquote,section,article,header,footer,ul,ol,pre,hr';
/** An HTML email as plain text, keeping line and paragraph breaks. DOMParser runs no scripts and loads nothing. */
const htmlToText = (html: string) => {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  body.querySelectorAll('style,script,title,noscript,template').forEach(el => el.remove());
  body.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
  body.querySelectorAll(BLOCKS).forEach(el => { el.prepend('\n'); el.append('\n'); });
  return (body.textContent ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
};
/** The message as plain text, for quoting: the text part, else the HTML's text. */
const plainText = (m: InboxMessage) => m.text ?? (m.html ? htmlToText(m.html) : '');
/** Keeps a quoted message well inside the API's 20,000-character limit for a whole message. */
const QUOTE_LIMIT = 15_000;
const clip = (text: string) => text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}\n[…]` : text;
const withPrefix = (prefix: string, subject: string) => new RegExp(`^${prefix}:`, 'i').test(subject) ? subject : `${prefix}: ${subject}`;
const snippet = (m: InboxMessage) => (m.text ?? m.html?.replace(/<[^>]+>/g, ' ') ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
/** Mail HTML, isolated: no scripts, no remote styles, links open outside; images only inline or from this portal (our logo in sent mail). */
const safeDoc = (html: string) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${window.location.origin}; style-src 'unsafe-inline'"><base target="_blank"><style>body{font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;margin:0;padding:4px;color:#1d1d1b;word-wrap:break-word}img{max-width:100%}</style></head><body>${html}</body></html>`;

export function AdminInboxLive() {
  const [folder, setFolder] = useState<Folder>('inbox');
  const [view, setView] = useState<InboxView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [mobileReading, setMobileReading] = useState(false);
  const mailboxRef = useRef<HTMLDivElement>(null);
  // Reading is open to every active staff member; sending and filing mail need inbox.send (not Support).
  const canSend = !!useSession().me?.permissions.includes('inbox.send');
  /** Brings the whole mailbox into the window, so the message actions and Send are on screen. */
  const reveal = () => window.requestAnimationFrame(() => mailboxRef.current?.scrollIntoView({ block: 'nearest' }));

  const load = useCallback(async (f: Folder = folder) => {
    try { setView(await getInbox({ folder: f })); setError(null); } catch (err) { setError(apiError(err, "Couldn't load the mailbox.").error); }
  }, [folder]);
  useEffect(() => { void load(folder); const t = window.setInterval(() => void load(folder), 30_000); return () => window.clearInterval(t); }, [folder, load]);

  const messages = (view?.messages ?? []).filter(m => `${m.from} ${m.to.join(' ')} ${m.subject} ${snippet(m)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const active = view?.messages.find(m => m.id === selected) ?? null;

  const choose = async (m: InboxMessage) => {
    setSelected(m.id); setDraft(null); setMobileReading(true); setNotice(''); reveal();
    if (!m.read && canSend) { try { await updateInboxMessage(m.id, { read: true }); void load(); } catch { /* shown as unread until the next refresh */ } }
  };
  const move = async (m: InboxMessage, to: Folder) => {
    try { await updateInboxMessage(m.id, { folder: to }); setSelected(null); setMobileReading(false); setNotice(`Moved to ${to}.`); void load(); }
    catch (err) { setNotice(apiError(err, "Couldn't move the message.").error); }
  };
  /** Reply all: the sender (or, for our own mail, its recipients) in To; everyone else on it in Cc, minus the team address. */
  const replyAllRecipients = (m: InboxMessage) => {
    const ours = new Set([view?.address, m.direction === 'outbound' ? emailOf(m.from) : null].filter(Boolean).map(a => a!.toLowerCase()));
    const to = unique((m.direction === 'inbound' ? [m.from] : m.to).map(emailOf)).filter(a => !ours.has(a.toLowerCase()));
    const taken = new Set([...ours, ...to.map(a => a.toLowerCase())]);
    const cc = unique((m.direction === 'inbound' ? [...m.to, ...m.cc] : m.cc).map(emailOf)).filter(a => !taken.has(a.toLowerCase()));
    return { to, cc };
  };
  const reply = (m: InboxMessage, all = false) => {
    const quoted = clip(plainText(m)).split('\n').map(l => `> ${l}`).join('\n');
    const everyone = replyAllRecipients(m);
    const to = all ? everyone.to.join(', ') : emailOf(m.direction === 'inbound' ? m.from : m.to[0] ?? '');
    const cc = all ? everyone.cc.join(', ') : '';
    setDraft(blank(all ? 'replyAll' : 'reply', { to, cc, copies: !!cc, subject: withPrefix('Re', m.subject), text: `\n\nOn ${when(m.at)}, ${nameOf(m.from)} wrote:\n${quoted}`, inReplyTo: m.id }));
    setFieldErrors({}); setMobileReading(true); setNotice(''); reveal();
  };
  const forward = (m: InboxMessage) => {
    const header = ['---------- Forwarded message ----------', `From: ${m.from}`, `Date: ${when(m.at)}`, `Subject: ${m.subject}`, `To: ${m.to.join(', ')}`, ...(m.cc.length ? [`Cc: ${m.cc.join(', ')}`] : [])].join('\n');
    setDraft(blank('forward', { subject: withPrefix('Fwd', m.subject), text: `\n\n${header}\n\n${clip(plainText(m))}`, attachments: m.attachments.length }));
    setFieldErrors({}); setMobileReading(true); setNotice(''); reveal();
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    try {
      await sendInboxEmail({ to: draft.to, ...(draft.cc.trim() ? { cc: draft.cc } : {}), ...(draft.bcc.trim() ? { bcc: draft.bcc } : {}), subject: draft.subject, text: draft.text, ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}), idempotencyKey: draft.key });
      setDraft(null); setNotice('Sent.'); setFieldErrors({});
      if (folder === 'sent') void load(); else void load();
    } catch (err) {
      const failure = apiError(err, "Couldn't send the message. Try again.");
      setFieldErrors(failure.fieldErrors ?? {}); setNotice(failure.fieldErrors ? '' : failure.error);
    } finally { setBusy(false); }
  };

  const sendingOffHint = 'Sending is off: a super admin can finish the email setup under Settings → Email.';
  const readOnlyHint = 'Read only: your role can read the team inbox but not send or file mail.';
  /** Why Compose, Reply, and Forward are off, if they are. */
  const sendBlocked = !canSend ? readOnlyHint : !view?.sending ? sendingOffHint : null;
  const setupNote = view && (!view.sending || !view.receiving)
    ? `${!view.sending ? 'Sending is off' : ''}${!view.sending && !view.receiving ? ' and ' : ''}${!view.receiving ? `${view.sending ? 'Receiving is off' : 'receiving is off'}` : ''}: a super admin can finish the email setup under Settings → Email.`
    : null;

  return <div className="admin-inbox" data-testid="admin-inbox-live">
    {setupNote && <div className="admin-inbox-notice" role="note"><Info size={17} /><div><strong>Mailbox not fully set up</strong><span>{setupNote}</span></div></div>}
    {error && <div className="admin-inbox-notice" role="alert"><Info size={17} /><div><strong>Couldn't load the mailbox</strong><span>{error}</span></div></div>}
    {notice && <div className="admin-inbox-feedback" role="status" data-testid="status-inbox-action"><Info size={15} /><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Dismiss"><X size={15} /></button></div>}
    <div ref={mailboxRef} className={`admin-mailbox ${mobileReading ? 'is-reading' : ''}`}>
      <aside className="admin-mail-folders" aria-label="Mail folders">
        <div className="admin-mail-folders-heading"><span className="admin-mail-overline">TEAM MAILBOX</span><strong title={view?.address ?? undefined}>{view?.address ?? 'Mail'}</strong></div>
        <button type="button" className="admin-mail-compose" disabled={!!sendBlocked} title={sendBlocked ?? undefined} onClick={() => { setDraft(blank('new')); setFieldErrors({}); setMobileReading(true); setNotice(''); reveal(); }} data-testid="button-compose-email"><PenLine size={16} /> Compose <span>+</span></button>
        <nav aria-label="Email folders">{FOLDERS.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={`admin-mail-folder ${folder === id ? 'active' : ''}`} onClick={() => { setFolder(id); setSelected(null); setDraft(null); setMobileReading(false); setQuery(''); }} aria-current={folder === id ? 'page' : undefined} data-testid={`button-mail-folder-${id}`}><Icon size={16} /><span>{label}</span>{id === 'inbox' && (view?.unread ?? 0) > 0 && <small>{view!.unread}</small>}</button>)}</nav>
        <div className="admin-mail-folder-foot"><button type="button" className="admin-mail-secondary" onClick={() => void load()} data-testid="button-refresh-mail"><RefreshCw size={14} /> Refresh</button><p>Checks for new mail every 30 seconds.</p></div>
      </aside>
      <section className="admin-mail-list" aria-label={`${folder} messages`}>
        <div className="admin-mail-list-heading"><div><span className="admin-mail-overline">FOLDER / {folder.toUpperCase()}</span><h2>{FOLDERS.find(f => f.id === folder)!.label}</h2><p>{messages.length} {messages.length === 1 ? 'message' : 'messages'}</p></div></div>
        <label className="admin-mail-search"><Search size={16} /><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={`Search ${folder}`} aria-label={`Search ${folder}`} data-testid="input-search-mail" /></label>
        <div className="admin-mail-list-scroll">{view === null && !error ? <div className="admin-mail-empty"><p>Loading…</p></div> : messages.length ? messages.map(m => <button key={m.id} type="button" className={`admin-mail-row ${selected === m.id ? 'selected' : ''} ${!m.read ? 'unread' : ''}`} onClick={() => void choose(m)} aria-current={selected === m.id ? 'true' : undefined} data-testid={`button-mail-message-${m.id}`}>
          <span className="admin-mail-row-top"><span className="admin-mail-sender">{!m.read && <i aria-label="Unread" />}{m.direction === 'inbound' ? nameOf(m.from) : `To ${m.to.map(nameOf).join(', ')}`}</span><span className="admin-mail-row-date">{format(new Date(m.at), 'dd MMM')}</span></span>
          <strong>{m.subject}</strong><span className="admin-mail-snippet">{snippet(m)}</span>
          <span className="admin-mail-row-bottom"><span>{m.direction === 'outbound' ? (m.status ?? 'sent').toUpperCase() : emailOf(m.from)}</span>{m.attachments.length > 0 && <Paperclip size={13} aria-label="Has attachments" />}</span>
        </button>) : <div className="admin-mail-empty"><Mail size={24} /><h3>{query ? 'No matching messages' : `Nothing in ${folder}`}</h3><p>{query ? 'Try a different search.' : folder === 'inbox' ? 'Mail sent to the team address appears here once receiving is set up.' : ''}</p></div>}</div>
      </section>
      <section className="admin-mail-reader" aria-label="Reading and reply area">
        <div className="admin-mail-reader-top"><button type="button" className="admin-mail-back" onClick={() => { setMobileReading(false); setDraft(null); }} data-testid="button-back-to-mail-list"><ArrowLeft size={16} /> Back to list</button>
          {active && !draft && <div className="admin-mail-toolbar" role="toolbar" aria-label="Message actions">
            {active.folder !== 'trash' && <>
              <button type="button" className="admin-mail-primary" onClick={() => reply(active)} disabled={!!sendBlocked} title={sendBlocked ?? undefined} data-testid="button-reply-mail"><CornerUpLeft size={15} /> Reply</button>
              {replyAllRecipients(active).cc.length > 0 && <button type="button" className="admin-mail-secondary" onClick={() => reply(active, true)} disabled={!!sendBlocked} title={sendBlocked ?? undefined} data-testid="button-reply-all-mail"><ReplyAll size={15} /> Reply all</button>}
              <button type="button" className="admin-mail-secondary" onClick={() => forward(active)} disabled={!!sendBlocked} title={sendBlocked ?? undefined} data-testid="button-forward-mail"><Forward size={15} /> Forward</button>
            </>}
            {active.folder !== 'archive' && active.folder !== 'trash' && <button type="button" className="admin-mail-secondary" onClick={() => void move(active, 'archive')} disabled={!canSend} title={canSend ? 'Archive' : readOnlyHint} aria-label="Archive" data-testid="button-archive-mail"><Archive size={15} /></button>}
            {active.folder !== 'trash' && <button type="button" className="admin-mail-secondary" onClick={() => void move(active, 'trash')} disabled={!canSend} title={canSend ? 'Move to Trash' : readOnlyHint} aria-label="Move to Trash" data-testid="button-trash-mail"><Trash2 size={15} /></button>}
            {(active.folder === 'trash' || active.folder === 'archive') && <button type="button" className="admin-mail-secondary" onClick={() => void move(active, active.direction === 'outbound' ? 'sent' : 'inbox')} disabled={!canSend} title={canSend ? undefined : readOnlyHint} data-testid="button-restore-mail">Move back</button>}
          </div>}
        </div>
        {draft ? <div className="admin-mail-compose-pane">
          <div className="admin-mail-compose-title"><div><span className="admin-mail-overline">FROM / {view?.address ?? ''}</span><h2>{draft.mode === 'reply' ? 'Reply' : draft.mode === 'replyAll' ? 'Reply all' : draft.mode === 'forward' ? 'Forward' : 'New message'}</h2></div><button type="button" aria-label="Close composer" onClick={() => setDraft(null)} data-testid="button-close-composer"><X size={18} /></button></div>
          <form onSubmit={send} className="admin-mail-form" noValidate>
            <label htmlFor="mail-to">To <span>Separate addresses with commas{!draft.copies && <> · <button type="button" className="admin-mail-link" onClick={() => setDraft({ ...draft, copies: true })} data-testid="button-mail-show-copies">Cc / Bcc</button></>}</span></label><input id="mail-to" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} aria-invalid={!!fieldErrors.to} data-testid="input-mail-to" />{fieldErrors.to && <small className="admin-field-error">{fieldErrors.to}</small>}
            {(draft.copies || fieldErrors.cc || fieldErrors.bcc) && <>
              <label htmlFor="mail-cc">Cc</label><input id="mail-cc" value={draft.cc} onChange={e => setDraft({ ...draft, cc: e.target.value })} aria-invalid={!!fieldErrors.cc} data-testid="input-mail-cc" />{fieldErrors.cc && <small className="admin-field-error">{fieldErrors.cc}</small>}
              <label htmlFor="mail-bcc">Bcc <span>Hidden from the other recipients</span></label><input id="mail-bcc" value={draft.bcc} onChange={e => setDraft({ ...draft, bcc: e.target.value })} aria-invalid={!!fieldErrors.bcc} data-testid="input-mail-bcc" />{fieldErrors.bcc && <small className="admin-field-error">{fieldErrors.bcc}</small>}
            </>}
            <label htmlFor="mail-subject">Subject</label><input id="mail-subject" value={draft.subject} onChange={e => setDraft({ ...draft, subject: e.target.value })} aria-invalid={!!fieldErrors.subject} data-testid="input-mail-subject" />{fieldErrors.subject && <small className="admin-field-error">{fieldErrors.subject}</small>}
            <label htmlFor="mail-body">Message</label><textarea id="mail-body" value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} aria-invalid={!!fieldErrors.text} data-testid="textarea-mail-body" />{fieldErrors.text && <small className="admin-field-error">{fieldErrors.text}</small>}
            {draft.mode === 'forward' && (draft.attachments ?? 0) > 0 && <p className="admin-mail-form-hint"><Paperclip size={14} /> The original's attachments aren't forwarded; only its text is included. Open them in the Resend dashboard.</p>}
            <p className="admin-mail-form-hint"><Info size={14} /> Sent through Resend from the team address. Sending is recorded in the audit log.</p>
            <div className="admin-mail-form-actions"><button type="button" className="admin-mail-secondary" onClick={() => setDraft(null)}>Discard</button><button type="submit" className="admin-mail-primary" disabled={busy} data-testid="button-send-mail"><Send size={15} /> {busy ? 'Sending…' : 'Send'}</button></div>
          </form>
        </div> : active ? <article className="admin-mail-message" data-testid="article-mail-message">
          <span className="admin-mail-overline">{active.direction === 'inbound' ? 'RECEIVED' : `SENT${active.sentBy ? ` BY ${active.sentBy.toUpperCase()}` : ''} · ${(active.status ?? 'sent').toUpperCase()}`}</span><h2>{active.subject}</h2>
          <div className="admin-mail-message-meta"><span className="admin-mail-initials">{nameOf(active.from).split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase()}</span><div><strong>{nameOf(active.from)}</strong><span>{emailOf(active.from)}</span><span>To: {active.to.join(', ')}{active.cc.length ? ` · Cc: ${active.cc.join(', ')}` : ''}{active.bcc.length ? ` · Bcc: ${active.bcc.join(', ')}` : ''}</span></div><time>{when(active.at)}</time></div>
          {active.html
            ? <iframe title="Message" className="admin-mail-html" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={safeDoc(active.html)} data-testid="frame-mail-body" />
            : <div className="admin-mail-body" style={{ whiteSpace: 'pre-wrap' }}>{active.text ?? '(This message has no text. It may not have been fetched from Resend; check the Resend key.)'}</div>}
          {active.attachments.length > 0 && <div className="admin-mail-reader-foot"><Paperclip size={14} /> {active.attachments.map(a => a.filename).join(', ')} · open attachments in the Resend dashboard.</div>}
          {sendBlocked && <p className="admin-mail-form-hint" data-testid="text-mail-blocked">{canSend ? <Info size={14} /> : <Lock size={14} />} {sendBlocked}</p>}
        </article> : <div className="admin-mail-reader-empty"><span className="admin-mail-empty-mark"><Mail size={26} /></span><h2>Select a message</h2><p>Choose a message to read it here, or compose a new one.</p></div>}
      </section>
    </div>
  </div>;
}
