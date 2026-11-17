import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { format } from 'date-fns';
import { Archive, ArrowLeft, CornerUpLeft, FileText, Forward, Inbox, Lock, ReplyAll, Info, Mail, Paperclip, PenLine, RefreshCw, Search, Send, Trash2, X } from 'lucide-react';
import { deleteInboxDraft, getInbox, getInboxAttachment, saveInboxDraft, sendInboxEmail, updateInboxMessage, type InboxMessage, type InboxView } from '@workspace/api-client-react';
import { apiError } from '@/lib/serverData';
import { useSession } from '@/lib/session';
import './AdminInbox.css';

// The team mailbox (signed in): mail received through the Resend webhook, and
// mail sent from here through Resend. Received HTML is shown in a sandboxed
// frame with scripts, forms, and remote loading blocked. What's being written
// is saved as a draft (seen only by its author) a few seconds after each change
// and when the composer closes.

type Folder = 'inbox' | 'drafts' | 'sent' | 'archive' | 'trash';
const FOLDERS: { id: Folder; label: string; icon: typeof Inbox }[] = [
  { id: 'inbox', label: 'Inbox', icon: Inbox }, { id: 'drafts', label: 'Drafts', icon: FileText }, { id: 'sent', label: 'Sent', icon: Send }, { id: 'archive', label: 'Archive', icon: Archive }, { id: 'trash', label: 'Trash', icon: Trash2 },
];
/**
 * `key`: one per message being written, so a double click or retry sends it once. `copies`: the Cc/Bcc fields are open.
 * `draftId`: its saved draft, once there is one. `skipped`: the forwarded message's files that can't be attached.
 */
type Draft = { mode: 'new' | 'reply' | 'replyAll' | 'forward' | 'draft'; key: string; draftId?: string; to: string; cc: string; bcc: string; copies: boolean; subject: string; text: string; inReplyTo?: string; skipped?: string[]; files: Attached[] };
/** A file on the message being written: new (`content`, base64) or already on a message (`ref`: the draft's own, or one being forwarded). */
type Attached = { id: string; name: string; size: number | null; content?: string; ref?: { messageId: string; attachmentId: string } };
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
/** What a save would store: unchanged means nothing to save. Files by their local id (a saved file keeps it). */
const snapshot = (d: Draft) => JSON.stringify([d.to, d.cc, d.bcc, d.subject, d.text, d.inReplyTo ?? '', d.files.map(f => f.id)]);
/** Types a browser shows safely in a tab of its own; anything else is downloaded. */
const PREVIEW_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain'];
/** Matches the API (lib/inboxAttachments.ts): the server checks every file again. */
const ATTACH_TYPES = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'txt', 'csv'];
const ATTACH_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.txt,.csv,application/pdf,image/jpeg,image/png,image/webp,text/plain,text/csv';
const MAX_FILES = 10;
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const fileSize = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});
const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
const blank = (mode: Draft['mode'], fields: Partial<Draft> = {}): Draft => ({ mode, key: newKey(), to: '', cc: '', bcc: '', copies: false, subject: '', text: '', files: [], ...fields });
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  /** The composer's latest state (saves run after renders), what was last saved, and the save in flight. */
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  const savedRef = useRef('');
  const savingRef = useRef<Promise<string | undefined> | null>(null);
  /** Draft ids by composer key: a save that finishes after the composer closed still tells Send and Discard which draft it made. */
  const idByKey = useRef<Record<string, string>>({});
  const sendingRef = useRef(false);
  // Reading is open to every active staff member; sending and filing mail need inbox.send (not Support).
  const canSend = !!useSession().me?.permissions.includes('inbox.send');
  /**
   * Brings the mailbox into the window, so the message actions and Send are on screen. On phones the mailbox flows with
   * the page, so its top goes to the top of the window (the reader's bar and the Send row stick there and at the bottom).
   */
  const reveal = () => window.requestAnimationFrame(() => mailboxRef.current?.scrollIntoView({ block: window.matchMedia('(max-width: 760px)').matches ? 'start' : 'nearest' }));

  const load = useCallback(async (f: Folder = folder) => {
    try { setView(await getInbox({ folder: f })); setError(null); } catch (err) { setError(apiError(err, "Couldn't load the mailbox.").error); }
  }, [folder]);
  useEffect(() => { void load(folder); const t = window.setInterval(() => void load(folder), 30_000); return () => window.clearInterval(t); }, [folder, load]);

  const messages = (view?.messages ?? []).filter(m => `${m.from} ${m.to.join(' ')} ${m.subject} ${snippet(m)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const active = view?.messages.find(m => m.id === selected) ?? null;

  /** Saves the message being written if it changed since the last save; returns its draft id. One save at a time. */
  const persist = useCallback(async (d: Draft | null = draftRef.current, force = false): Promise<string | undefined> => {
    while (savingRef.current) await savingRef.current;
    if (!d || !canSend || sendingRef.current) return d ? d.draftId ?? idByKey.current[d.key] : undefined;
    const id = d.draftId ?? idByKey.current[d.key];
    const snap = snapshot(d);
    if (!force && snap === savedRef.current) return id;
    const run = (async () => {
      setSaveState('saving');
      const refs = d.files.filter(f => f.ref), added = d.files.filter(f => !f.ref && f.content !== undefined);
      try {
        const saved = await saveInboxDraft({ ...(id ? { id } : {}), to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, text: d.text, ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}),
          existingAttachments: refs.map(f => f.ref!), attachments: added.map(f => ({ filename: f.name, content: f.content! })) });
        idByKey.current[d.key] = saved.id;
        // The server answers with the kept files first, then the new ones, in the order sent: each becomes a reference to the draft.
        const mapped = new Map([...refs, ...added].map((f, i) => [f.id, saved.attachments[i]] as const));
        const update = (cur: Draft | null) => cur && cur.key === d.key ? { ...cur, draftId: saved.id, files: cur.files.map(f => { const a = mapped.get(f.id); return a ? { id: f.id, name: a.filename, size: a.size, ref: { messageId: saved.id, attachmentId: a.id } } : f; }) } : cur;
        draftRef.current = update(draftRef.current);
        setDraft(update);
        if (draftRef.current?.key === d.key) savedRef.current = snap;
        setSaveState('saved');
        return saved.id;
      } catch (err) {
        setSaveState('error');
        const failure = apiError(err, "Couldn't save the draft.");
        if (failure.fieldErrors && draftRef.current?.key === d.key) setFieldErrors(failure.fieldErrors);
        throw err;
      }
    })();
    savingRef.current = run;
    try { return await run; } finally { savingRef.current = null; }
  }, [canSend]);
  // Saves a few seconds after the last change.
  useEffect(() => {
    if (!draft || !canSend || snapshot(draft) === savedRef.current) return;
    const t = window.setTimeout(() => { void persist().catch(() => { /* shown in the composer */ }); }, 2500);
    return () => window.clearTimeout(t);
  }, [draft, canSend, persist]);
  const openComposer = (d: Draft, saved = false) => {
    draftRef.current = d; savedRef.current = snapshot(d); setDraft(d); setSaveState(saved ? 'saved' : 'idle');
    setFieldErrors({}); setMobileReading(true); setNotice(''); reveal();
  };
  /** Closes the composer, saving what changed to Drafts; if that fails, the composer comes back with the text. */
  const closeComposer = () => {
    const d = draftRef.current;
    draftRef.current = null; setDraft(null);
    if (!d || !canSend) return;
    if (snapshot(d) === savedRef.current) { if (d.draftId ?? idByKey.current[d.key]) { setNotice('Saved to Drafts.'); if (folder === 'drafts') void load(); } return; }
    void persist(d, true).then(() => { setNotice('Saved to Drafts.'); if (folder === 'drafts') void load(); }).catch(err => {
      openComposer(d); setNotice(apiError(err, "Couldn't save the draft. Your message is still here.").error);
    });
  };
  /** Discard: closes the composer and deletes its draft, if one was saved. */
  const discardDraft = async () => {
    const d = draftRef.current;
    draftRef.current = null; setDraft(null); setFieldErrors({});
    if (!d) return;
    while (savingRef.current) await savingRef.current.catch(() => undefined);
    const id = d.draftId ?? idByKey.current[d.key];
    if (!id) return;
    try { await deleteInboxDraft(id); setNotice('Draft discarded.'); if (folder === 'drafts') { setSelected(null); void load(); } }
    catch (err) { setNotice(apiError(err, "Couldn't discard the draft.").error); }
  };
  /** Opens a saved draft in the composer. */
  const resume = (m: InboxMessage) => {
    setSelected(m.id);
    openComposer(blank('draft', {
      draftId: m.id, to: m.to.join(', '), cc: m.cc.join(', '), bcc: m.bcc.join(', '), copies: m.cc.length + m.bcc.length > 0, subject: m.subject, text: m.text ?? '',
      ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}), files: m.attachments.map(a => ({ id: newKey(), name: a.filename, size: a.size, ref: { messageId: m.id, attachmentId: a.id } })),
    }), true);
  };

  const choose = async (m: InboxMessage) => {
    if (m.folder === 'drafts') { if (canSend) { closeComposer(); resume(m); } return; }
    setSelected(m.id); closeComposer(); setMobileReading(true); setNotice(''); reveal();
    if (!m.read && canSend) { try { await updateInboxMessage(m.id, { read: true }); void load(); } catch { /* shown as unread until the next refresh */ } }
  };
  const move = async (m: InboxMessage, to: Exclude<Folder, 'drafts'>) => {
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
    openComposer(blank(all ? 'replyAll' : 'reply', { to, cc, copies: !!cc, subject: withPrefix('Re', m.subject), text: `\n\nOn ${when(m.at)}, ${nameOf(m.from)} wrote:\n${quoted}`, inReplyTo: m.id }));
  };
  const forward = (m: InboxMessage) => {
    const header = ['---------- Forwarded message ----------', `From: ${m.from}`, `Date: ${when(m.at)}`, `Subject: ${m.subject}`, `To: ${m.to.join(', ')}`, ...(m.cc.length ? [`Cc: ${m.cc.join(', ')}`] : [])].join('\n');
    // The original's files go with it (the server reads them and checks them again); types we can't attach are listed instead.
    const carried = m.attachments.filter(a => a.downloadable && ATTACH_TYPES.includes(extOf(a.filename))).slice(0, MAX_FILES);
    const skipped = m.attachments.filter(a => !carried.includes(a)).map(a => a.filename);
    openComposer(blank('forward', {
      subject: withPrefix('Fwd', m.subject), text: `\n\n${header}\n\n${clip(plainText(m))}`, skipped,
      files: carried.map(a => ({ id: newKey(), name: a.filename, size: a.size, ref: { messageId: m.id, attachmentId: a.id } })),
    }));
  };
  /** Adds chosen files to the message, refusing types, counts, and sizes the server would refuse. */
  const attach = async (list: FileList | null) => {
    if (!draft || !list?.length) return;
    const chosen = [...list];
    const errorsOf = (message: string) => setFieldErrors(e => ({ ...e, attachments: message }));
    const wrongType = chosen.find(f => !ATTACH_TYPES.includes(extOf(f.name)));
    if (wrongType) { errorsOf(`${wrongType.name} isn't a file type you can attach. Attach PDF, JPG, PNG, WEBP, TXT, or CSV files.`); return; }
    if (draft.files.length + chosen.length > MAX_FILES) { errorsOf(`Attach at most ${MAX_FILES} files.`); return; }
    if (draft.files.reduce((n, f) => n + (f.size ?? 0), 0) + chosen.reduce((n, f) => n + f.size, 0) > MAX_ATTACH_BYTES) { errorsOf('Attachments can be up to 10 MB in all.'); return; }
    const empty = chosen.find(f => f.size === 0);
    if (empty) { errorsOf(`${empty.name} is empty.`); return; }
    try {
      const added = await Promise.all(chosen.map(async f => ({ id: newKey(), name: f.name, size: f.size, content: await readBase64(f) })));
      setDraft(d => d ? { ...d, files: [...d.files, ...added] } : d);
      setFieldErrors(({ attachments: _gone, ...rest }) => rest);
    } catch { errorsOf("A file couldn't be read. Try attaching it again."); }
  };
  const removeFile = (id: string) => setDraft(d => d ? { ...d, files: d.files.filter(f => f.id !== id) } : d);
  /**
   * Opens an attachment: PDFs, pictures, and plain text in a new tab (opened first, so popup blockers allow it); anything else
   * (HTML, Office files, and other types a tab could run) is downloaded, never shown on the portal's own address.
   */
  const openAttachment = async (m: InboxMessage, a: InboxMessage['attachments'][number]) => {
    const type = a.contentType.toLowerCase().split(';')[0]!.trim();
    const preview = PREVIEW_TYPES.includes(type);
    const tab = preview ? window.open('', '_blank') : null;
    try {
      const blob = await getInboxAttachment(m.id, a.id);
      const url = URL.createObjectURL(new Blob([blob], { type: preview ? type : 'application/octet-stream' }));
      if (tab) tab.location.href = url;
      else { const link = document.createElement('a'); link.href = url; link.download = a.filename; link.click(); }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) { tab?.close(); setNotice(apiError(err, "Couldn't open the attachment. Try again.").error); }
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    // No autosave while sending; a save already running finishes first, so Send knows the draft to remove.
    sendingRef.current = true;
    try {
      while (savingRef.current) await savingRef.current.catch(() => undefined);
      const d = draftRef.current ?? draft;
      const draftId = d.draftId ?? idByKey.current[d.key];
      const refs = d.files.filter(f => f.ref), added = d.files.filter(f => !f.ref && f.content !== undefined);
      await sendInboxEmail({ to: d.to, ...(d.cc.trim() ? { cc: d.cc } : {}), ...(d.bcc.trim() ? { bcc: d.bcc } : {}), subject: d.subject, text: d.text, ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}),
        ...(refs.length ? { existingAttachments: refs.map(f => f.ref!) } : {}), ...(added.length ? { attachments: added.map(f => ({ filename: f.name, content: f.content! })) } : {}),
        ...(draftId ? { draftId } : {}), idempotencyKey: d.key });
      draftRef.current = null; setDraft(null); setNotice('Sent.'); setFieldErrors({});
      if (folder === 'drafts') setSelected(null);
      void load();
    } catch (err) {
      const failure = apiError(err, "Couldn't send the message. Try again.");
      setFieldErrors(failure.fieldErrors ?? {}); setNotice(failure.fieldErrors ? '' : failure.error);
    } finally { sendingRef.current = false; setBusy(false); }
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
        <button type="button" className="admin-mail-compose" disabled={!!sendBlocked} title={sendBlocked ?? undefined} onClick={() => { closeComposer(); openComposer(blank('new')); }} data-testid="button-compose-email"><PenLine size={16} /> Compose <span>+</span></button>
        <nav aria-label="Email folders">{FOLDERS.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={`admin-mail-folder ${folder === id ? 'active' : ''}`} onClick={() => { setFolder(id); setSelected(null); closeComposer(); setMobileReading(false); setQuery(''); }} aria-current={folder === id ? 'page' : undefined} data-testid={`button-mail-folder-${id}`}><Icon size={16} /><span>{label}</span>{id === 'inbox' && (view?.unread ?? 0) > 0 && <small>{view!.unread}</small>}</button>)}</nav>
        <div className="admin-mail-folder-foot"><button type="button" className="admin-mail-secondary" onClick={() => void load()} data-testid="button-refresh-mail"><RefreshCw size={14} /> Refresh</button><p>Checks for new mail every 30 seconds.</p></div>
      </aside>
      <section className="admin-mail-list" aria-label={`${folder} messages`}>
        <div className="admin-mail-list-heading"><div><span className="admin-mail-overline">FOLDER / {folder.toUpperCase()}</span><h2>{FOLDERS.find(f => f.id === folder)!.label}</h2><p>{messages.length} {messages.length === 1 ? 'message' : 'messages'}</p></div></div>
        <label className="admin-mail-search"><Search size={16} /><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={`Search ${folder}`} aria-label={`Search ${folder}`} data-testid="input-search-mail" /></label>
        <div className="admin-mail-list-scroll">{view === null && !error ? <div className="admin-mail-empty"><p>Loading…</p></div> : messages.length ? messages.map(m => <button key={m.id} type="button" className={`admin-mail-row ${selected === m.id ? 'selected' : ''} ${!m.read ? 'unread' : ''}`} onClick={() => void choose(m)} aria-current={selected === m.id ? 'true' : undefined} data-testid={`button-mail-message-${m.id}`}>
          <span className="admin-mail-row-top"><span className="admin-mail-sender">{!m.read && <i aria-label="Unread" />}{m.direction === 'inbound' ? nameOf(m.from) : m.to.length ? `To ${m.to.map(nameOf).join(', ')}` : 'No recipients yet'}</span><span className="admin-mail-row-date">{format(new Date(m.at), 'dd MMM')}</span></span>
          <strong>{m.subject || '(no subject)'}</strong><span className="admin-mail-snippet">{snippet(m)}</span>
          <span className="admin-mail-row-bottom"><span>{m.folder === 'drafts' ? 'DRAFT' : m.direction === 'outbound' ? (m.status ?? 'sent').toUpperCase() : emailOf(m.from)}</span>{m.attachments.length > 0 && <Paperclip size={13} aria-label="Has attachments" />}</span>
        </button>) : <div className="admin-mail-empty"><Mail size={24} /><h3>{query ? 'No matching messages' : `Nothing in ${folder}`}</h3><p>{query ? 'Try a different search.' : folder === 'inbox' ? 'Mail sent to the team address appears here once receiving is set up.' : folder === 'drafts' ? 'Messages you start writing are saved here. Only you see your drafts.' : ''}</p></div>}</div>
      </section>
      <section className="admin-mail-reader" aria-label="Reading and reply area">
        <div className="admin-mail-reader-top"><button type="button" className="admin-mail-back" onClick={() => { setMobileReading(false); closeComposer(); }} data-testid="button-back-to-mail-list"><ArrowLeft size={16} /> Back to list</button>
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
          <div className="admin-mail-compose-title"><div><span className="admin-mail-overline">FROM / {view?.address ?? ''}</span><h2>{draft.mode === 'reply' ? 'Reply' : draft.mode === 'replyAll' ? 'Reply all' : draft.mode === 'forward' ? 'Forward' : draft.mode === 'draft' ? 'Draft' : 'New message'}</h2>
            {saveState !== 'idle' && <small className={`admin-mail-draft-state ${saveState === 'error' ? 'is-error' : ''}`} role="status" data-testid="text-draft-status">{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved to Drafts' : "Couldn't save the draft"}</small>}</div>
            <button type="button" aria-label="Close and save to Drafts" title="Close (saved to Drafts)" onClick={closeComposer} data-testid="button-close-composer"><X size={18} /></button></div>
          <form onSubmit={send} className="admin-mail-form" noValidate>
            <label htmlFor="mail-to">To <span>Separate addresses with commas{!draft.copies && <> · <button type="button" className="admin-mail-link" onClick={() => setDraft({ ...draft, copies: true })} data-testid="button-mail-show-copies">Cc / Bcc</button></>}</span></label><input id="mail-to" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} aria-invalid={!!fieldErrors.to} data-testid="input-mail-to" />{fieldErrors.to && <small className="admin-field-error">{fieldErrors.to}</small>}
            {(draft.copies || fieldErrors.cc || fieldErrors.bcc) && <>
              <label htmlFor="mail-cc">Cc</label><input id="mail-cc" value={draft.cc} onChange={e => setDraft({ ...draft, cc: e.target.value })} aria-invalid={!!fieldErrors.cc} data-testid="input-mail-cc" />{fieldErrors.cc && <small className="admin-field-error">{fieldErrors.cc}</small>}
              <label htmlFor="mail-bcc">Bcc <span>Hidden from the other recipients</span></label><input id="mail-bcc" value={draft.bcc} onChange={e => setDraft({ ...draft, bcc: e.target.value })} aria-invalid={!!fieldErrors.bcc} data-testid="input-mail-bcc" />{fieldErrors.bcc && <small className="admin-field-error">{fieldErrors.bcc}</small>}
            </>}
            <label htmlFor="mail-subject">Subject</label><input id="mail-subject" value={draft.subject} onChange={e => setDraft({ ...draft, subject: e.target.value })} aria-invalid={!!fieldErrors.subject} data-testid="input-mail-subject" />{fieldErrors.subject && <small className="admin-field-error">{fieldErrors.subject}</small>}
            <label htmlFor="mail-body">Message</label><textarea id="mail-body" value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} aria-invalid={!!fieldErrors.text} data-testid="textarea-mail-body" />{fieldErrors.text && <small className="admin-field-error">{fieldErrors.text}</small>}
            {draft.files.length > 0 && <ul className="admin-mail-attached" aria-label="Attached files" data-testid="list-attached-files">{draft.files.map(f => <li key={f.id}><Paperclip size={13} /><span title={f.name}>{f.name}</span>{f.size !== null && <small>{fileSize(f.size)}</small>}<button type="button" onClick={() => removeFile(f.id)} aria-label={`Remove ${f.name}`} data-testid="button-remove-attachment"><X size={14} /></button></li>)}</ul>}
            {fieldErrors.attachments && <small className="admin-field-error" data-testid="error-attachments">{fieldErrors.attachments}</small>}
            {(draft.skipped?.length ?? 0) > 0 && <p className="admin-mail-form-hint" data-testid="text-forward-skipped"><Paperclip size={14} /> Not forwarded: {draft.skipped!.join(', ')}. Only PDF, JPG, PNG, WEBP, TXT, and CSV files can be attached; open the original to download the others.</p>}
            <p className="admin-mail-form-hint"><Info size={14} /> Sent through Resend from the team address. Sending is recorded in the audit log. Attach PDF, JPG, PNG, WEBP, TXT, or CSV files, up to 10 MB in all. Saved to your Drafts as you write.</p>
            <input ref={fileInputRef} type="file" multiple accept={ATTACH_ACCEPT} hidden onChange={e => { void attach(e.target.files); e.target.value = ''; }} data-testid="input-attach-files" />
            <div className="admin-mail-form-actions"><button type="button" className="admin-mail-secondary" onClick={() => void discardDraft()} title="Delete this message and its draft" data-testid="button-discard-mail">Discard</button><span className="admin-mail-form-send"><button type="button" className="admin-mail-secondary admin-mail-attach-button" onClick={() => fileInputRef.current?.click()} disabled={draft.files.length >= MAX_FILES} title="Attach files (PDF, JPG, PNG, WEBP, TXT, CSV · up to 10 MB in all)" data-testid="button-attach-files"><Paperclip size={15} /> Attach{draft.files.length > 0 && <b> {draft.files.length}</b>}</button><button type="submit" className="admin-mail-primary" disabled={busy} data-testid="button-send-mail"><Send size={15} /> {busy ? 'Sending…' : 'Send'}</button></span></div>
          </form>
        </div> : active ? <article className="admin-mail-message" data-testid="article-mail-message">
          <span className="admin-mail-overline">{active.direction === 'inbound' ? 'RECEIVED' : `SENT${active.sentBy ? ` BY ${active.sentBy.toUpperCase()}` : ''} · ${(active.status ?? 'sent').toUpperCase()}`}</span><h2>{active.subject}</h2>
          <div className="admin-mail-message-meta"><span className="admin-mail-initials">{nameOf(active.from).split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase()}</span><div><strong>{nameOf(active.from)}</strong><span>{emailOf(active.from)}</span><span>To: {active.to.join(', ')}{active.cc.length ? ` · Cc: ${active.cc.join(', ')}` : ''}{active.bcc.length ? ` · Bcc: ${active.bcc.join(', ')}` : ''}</span></div><time>{when(active.at)}</time></div>
          {active.html
            ? <iframe title="Message" className="admin-mail-html" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={safeDoc(active.html)} data-testid="frame-mail-body" />
            : <div className="admin-mail-body" style={{ whiteSpace: 'pre-wrap' }}>{active.text ?? '(This message has no text. It may not have been fetched from Resend; check the Resend key.)'}</div>}
          {active.attachments.some(a => a.downloadable) && <ul className="admin-mail-attached admin-mail-attached-read" aria-label="Attachments" data-testid="list-mail-attachments">{active.attachments.filter(a => a.downloadable).map(a => <li key={a.id}><button type="button" onClick={() => void openAttachment(active, a)} title={PREVIEW_TYPES.includes(a.contentType.toLowerCase()) ? 'Open' : 'Download'} data-testid="button-open-attachment"><Paperclip size={13} /><span title={a.filename}>{a.filename}</span>{a.size !== null && <small>{fileSize(a.size)}</small>}</button></li>)}</ul>}
          {active.direction === 'inbound' && active.attachments.some(a => a.downloadable) && <p className="admin-mail-form-hint" data-testid="text-received-files"><Info size={14} /> These files come from outside the team. Open only what you expect from this sender; opening one is recorded in the audit log.</p>}
          {active.attachments.some(a => !a.downloadable) && <div className="admin-mail-reader-foot"><Paperclip size={14} /> {active.attachments.filter(a => !a.downloadable).map(a => a.filename).join(', ')} · these files can't be opened here.</div>}
          {sendBlocked && <p className="admin-mail-form-hint" data-testid="text-mail-blocked">{canSend ? <Info size={14} /> : <Lock size={14} />} {sendBlocked}</p>}
        </article> : <div className="admin-mail-reader-empty"><span className="admin-mail-empty-mark"><Mail size={26} /></span><h2>Select a message</h2><p>Choose a message to read it here, or compose a new one.</p></div>}
      </section>
    </div>
  </div>;
}
