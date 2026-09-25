import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Archive, ArrowLeft, CornerUpLeft, FilePenLine, Inbox, Info, Mail, PenLine, Search, Send, Star, Trash2, X } from 'lucide-react';
import { Form } from '@/components/ui/form';
import './AdminInbox.css';

type Folder = 'Inbox' | 'Sent' | 'Drafts' | 'Archive' | 'Trash';
type Message = {
  id: string; sender: string; address: string; to: string; subject: string;
  snippet: string; body: string[]; date: string; folder: Folder; read: boolean; starred: boolean;
};
type Draft = { id: string; to: string; subject: string; body: string };

const seed: Message[] = [
  { id: 'm1', sender: 'Maya Okafor', address: 'maya.okafor@example.org', to: 'team@example.org', subject: 'Creative Practice · application question', snippet: 'I wanted to ask whether the print studio proposal can include shared equipment.', body: ['Hello grant team,', 'I wanted to ask whether the print studio proposal can include shared equipment that will be used by several neighborhood makers. I have a draft budget and would appreciate some guidance before finalizing it.', 'Thank you for your time,', 'Maya'], date: '21 May 2025 · 10:42', folder: 'Inbox', read: false, starred: true },
  { id: 'm2', sender: 'Nia Campbell', address: 'nia.campbell@example.org', to: 'team@example.org', subject: 'Community Roots supporting details', snippet: 'The updated kitchen plan is ready for review when you have a moment.', body: ['Good morning,', 'The updated kitchen plan is ready for review when you have a moment. We have clarified the community sessions and the proposed use of the space.', 'Kind regards,', 'Nia'], date: '20 May 2025 · 15:18', folder: 'Inbox', read: false, starred: false },
  { id: 'm3', sender: 'Samira Haddad', address: 'samira.haddad@example.org', to: 'team@example.org', subject: 'Green Transition eligibility', snippet: 'Would the energy assessment count toward the project budget?', body: ['Hello,', 'Would the energy assessment count toward the project budget, or should we only include the installation work? I am pulling together the remaining estimates now.', 'Best,', 'Samira'], date: '19 May 2025 · 09:06', folder: 'Inbox', read: true, starred: false },
  { id: 'm4', sender: 'Theo Mensah', address: 'theo.mensah@example.org', to: 'team@example.org', subject: 'Timeline for the next review cycle', snippet: 'Could you share when the next review cycle is expected to begin?', body: ['Dear team,', 'Could you share when the next review cycle is expected to begin? I am gathering information for a food storage project.', 'Many thanks,', 'Theo'], date: '16 May 2025 · 11:24', folder: 'Inbox', read: true, starred: false },
  { id: 'm5', sender: 'Grant team', address: 'team@example.org', to: 'priya.shah@example.org', subject: 'Re: Creative Practice question', snippet: 'Thank you for sharing the outline of your ceramics workshop.', body: ['Hello Priya,', 'Thank you for sharing the outline of your ceramics workshop. The preview program notes are available in the applicant workspace.', 'Best,', 'Grant team'], date: '14 May 2025 · 13:35', folder: 'Sent', read: true, starred: false },
  { id: 'm6', sender: 'Elias Navarro', address: 'elias.navarro@example.org', to: 'team@example.org', subject: 'Business Momentum follow-up', snippet: 'I have a revised estimate for the shop equipment.', body: ['Hello team,', 'I have a revised estimate for the shop equipment and wanted to keep it on record for our next conversation.', 'Regards,', 'Elias'], date: '12 May 2025 · 16:05', folder: 'Archive', read: true, starred: false },
];
const folderIcons = { Inbox, Sent: Send, Drafts: FilePenLine, Archive, Trash: Trash2 };
const folders: Folder[] = ['Inbox', 'Sent', 'Drafts', 'Archive', 'Trash'];
const blankDraft = (): Draft => ({ id: `draft-${Date.now()}`, to: '', subject: '', body: '' });

export function AdminInbox() {
  const [messages, setMessages] = useState(seed);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [folder, setFolder] = useState<Folder>('Inbox');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>('m1');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [notice, setNotice] = useState('');
  const [mobileReading, setMobileReading] = useState(false);
  const form = useForm<Pick<Draft, 'to' | 'subject' | 'body'>>({
    defaultValues: { to: '', subject: '', body: '' },
  });
  const { reset, getValues } = form;
  useEffect(() => {
    if (editing) reset({ to: editing.to, subject: editing.subject, body: editing.body });
  }, [editing, reset]);

  const unread = messages.filter(message => message.folder === 'Inbox' && !message.read).length;
  const rows = (folder === 'Drafts'
    ? drafts.map(draft => ({ id: draft.id, sender: 'Draft to ' + (draft.to || 'no recipient'), subject: draft.subject || '(No subject)', snippet: draft.body || 'Start writing your message', date: 'Local preview', read: true, starred: false }))
    : messages.filter(message => message.folder === folder))
    .filter(message => `${message.sender} ${message.subject} ${message.snippet}`.toLowerCase().includes(query.trim().toLowerCase()));
  const activeMessage = messages.find(message => message.id === selected && message.folder === folder);
  const activeDraft = drafts.find(draft => draft.id === selected && folder === 'Drafts');

  const chooseFolder = (next: Folder) => {
    setFolder(next); setQuery(''); setEditing(null); setSelected(null); setMobileReading(false); setNotice('');
  };
  const chooseMessage = (id: string) => {
    setSelected(id); setEditing(null); setMobileReading(true); setNotice('');
    setMessages(current => current.map(message => message.id === id ? { ...message, read: true } : message));
  };
  const saveDraft = () => {
    if (!editing) return;
    setDrafts(current => [{ ...editing, ...getValues() }, ...current.filter(draft => draft.id !== editing.id)]);
    setFolder('Drafts'); setSelected(editing.id); setEditing(null); setMobileReading(true);
    setNotice('Saved in this preview only. Nothing was sent or saved across reloads.');
  };
  const previewSend = () => {
    setNotice('Preview send only — no email sent. This mailbox is not connected.');
  };
  const moveMessage = (destination: Folder) => {
    if (!activeMessage) return;
    setMessages(current => current.map(message => message.id === activeMessage.id ? { ...message, folder: destination } : message));
    setSelected(null); setMobileReading(false);
    setNotice(`Moved to ${destination} in this preview only.`);
  };
  const startReply = () => {
    if (!activeMessage) return;
    setEditing({ id: `draft-${Date.now()}`, to: activeMessage.address, subject: activeMessage.subject.startsWith('Re:') ? activeMessage.subject : `Re: ${activeMessage.subject}`, body: `\n\nOn ${activeMessage.date}, ${activeMessage.sender} wrote:\n> ${activeMessage.snippet}` });
    setMobileReading(true); setNotice('');
  };
  return <div className="admin-inbox" data-testid="admin-inbox">
    <div className="admin-inbox-notice" role="note"><Info size={17} /><div><strong>Sample mailbox only · NOT CONNECTED</strong><span>These are fictional example.org conversations. Incoming email will NOT automatically appear here yet. No email can be sent from this preview.</span></div></div>
    {notice && <div className="admin-inbox-feedback" role="status" data-testid="status-inbox-action"><Info size={15} /><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Dismiss inbox notice" data-testid="button-dismiss-inbox-notice"><X size={15} /></button></div>}
    <div className={`admin-mailbox ${mobileReading ? 'is-reading' : ''}`}>
      <aside className="admin-mail-folders" aria-label="Mail folders">
        <div className="admin-mail-folders-heading"><span className="admin-mail-overline">CORRESPONDENCE / 001</span><strong>Mail workspace</strong><span className="admin-mail-offline"><span /> Demo only</span></div>
        <button type="button" className="admin-mail-compose" onClick={() => { setEditing(blankDraft()); setMobileReading(true); setNotice(''); }} data-testid="button-compose-email"><PenLine size={16} /> Compose <span>+</span></button>
        <nav aria-label="Email folders">{folders.map(item => { const Icon = folderIcons[item]; return <button key={item} type="button" className={`admin-mail-folder ${folder === item ? 'active' : ''}`} onClick={() => chooseFolder(item)} aria-current={folder === item ? 'page' : undefined} data-testid={`button-mail-folder-${item.toLowerCase()}`}><Icon size={16} /><span>{item}</span>{item === 'Inbox' && unread > 0 && <small>{unread}</small>}{item === 'Drafts' && drafts.length > 0 && <small>{drafts.length}</small>}</button>; })}</nav>
        <div className="admin-mail-folder-foot"><span>01 / SAMPLE ENVIRONMENT</span><p>Local changes reset when this page reloads.</p></div>
      </aside>
      <section className="admin-mail-list" aria-label={`${folder} messages`}>
        <div className="admin-mail-list-heading"><div><span className="admin-mail-overline">FOLDER / {folder.toUpperCase()}</span><h2>{folder}</h2><p>{rows.length} {rows.length === 1 ? 'conversation' : 'conversations'} in view</p></div><span className="admin-mail-list-index">ARC—MAIL</span></div>
        <label className="admin-mail-search"><Search size={16} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={`Search ${folder.toLowerCase()}`} aria-label={`Search ${folder.toLowerCase()} messages`} data-testid="input-search-mail" /></label>
        <div className="admin-mail-list-scroll">{rows.length ? rows.map(message => <button key={message.id} type="button" className={`admin-mail-row ${selected === message.id ? 'selected' : ''} ${!message.read ? 'unread' : ''}`} onClick={() => chooseMessage(message.id)} aria-current={selected === message.id ? 'true' : undefined} data-testid={`button-mail-message-${message.id}`}><span className="admin-mail-row-top"><span className="admin-mail-sender">{!message.read && <i aria-label="Unread" />}{message.sender}</span><span className="admin-mail-row-date">{message.date.split(' · ')[0]}</span></span><strong>{message.subject}</strong><span className="admin-mail-snippet">{message.snippet}</span><span className="admin-mail-row-bottom"><span>{folder === 'Drafts' ? 'UNSENT DRAFT' : 'EXAMPLE.ORG'}</span>{message.starred && <Star size={13} fill="currentColor" aria-label="Starred" />}</span></button>) : <div className="admin-mail-empty"><Mail size={24} /><h3>{query ? 'No matching conversations' : `Nothing in ${folder.toLowerCase()}`}</h3><p>{query ? 'Try a different search term.' : 'This folder has no sample messages right now.'}</p>{query && <button type="button" onClick={() => setQuery('')} data-testid="button-clear-mail-search">Clear search</button>}</div>}</div>
      </section>
      <section className="admin-mail-reader" aria-label="Reading and reply area">
        <div className="admin-mail-reader-top"><button type="button" className="admin-mail-back" onClick={() => { setMobileReading(false); setEditing(null); }} data-testid="button-back-to-mail-list"><ArrowLeft size={16} /> Back to list</button><span>PRIVATE PREVIEW / NO LIVE MAIL</span></div>
        {editing ? <div className="admin-mail-compose-pane">
          <div className="admin-mail-compose-title"><div><span className="admin-mail-overline">COMPOSE / LOCAL DRAFT</span><h2>{editing.subject.startsWith('Re:') ? 'Write a reply' : 'New message'}</h2></div><button type="button" aria-label="Close composer" onClick={() => setEditing(null)} data-testid="button-close-composer"><X size={18} /></button></div>
          <Form {...form}><form onSubmit={form.handleSubmit(previewSend)} className="admin-mail-form">
            <label htmlFor="mail-to">To <span>Example addresses only</span></label><input id="mail-to" type="email" required {...form.register('to', { required: true })} placeholder="person@example.org" data-testid="input-mail-to" />
            <label htmlFor="mail-subject">Subject</label><input id="mail-subject" required {...form.register('subject', { required: true })} placeholder="Add a subject" data-testid="input-mail-subject" />
            <label htmlFor="mail-body">Message</label><textarea id="mail-body" required {...form.register('body', { required: true })} placeholder="Write your message here…" data-testid="textarea-mail-body" />
            <p className="admin-mail-form-hint"><Info size={14} /> Preview only. Never enter private or real correspondence. Nothing is transmitted.</p>
            <div className="admin-mail-form-actions"><button type="button" className="admin-mail-secondary" onClick={saveDraft} data-testid="button-save-mail-draft">Save local draft</button><button type="submit" className="admin-mail-primary" data-testid="button-preview-send"><Send size={15} /> Preview send <span> / No email sent</span></button></div>
          </form></Form>
        </div> : activeDraft ? <div className="admin-mail-draft-view"><span className="admin-mail-overline">UNSENT / LOCAL PREVIEW</span><h2>{activeDraft.subject || '(No subject)'}</h2><p>To: {activeDraft.to || 'No recipient'}</p><div className="admin-mail-draft-body">{activeDraft.body || 'This draft has no message yet.'}</div><div className="admin-mail-actions"><button type="button" className="admin-mail-primary" onClick={() => setEditing(activeDraft)} data-testid="button-edit-mail-draft"><PenLine size={15} /> Edit draft</button><button type="button" className="admin-mail-secondary" onClick={() => { setDrafts(current => current.filter(draft => draft.id !== activeDraft.id)); setSelected(null); setMobileReading(false); setNotice('Local draft deleted.'); }} data-testid="button-delete-mail-draft"><Trash2 size={15} /> Delete draft</button></div></div> : activeMessage ? <article className="admin-mail-message" data-testid="article-mail-message">
          <span className="admin-mail-overline">{activeMessage.folder.toUpperCase()} / SAMPLE CONVERSATION</span><h2>{activeMessage.subject}</h2>
          <div className="admin-mail-message-meta"><span className="admin-mail-initials">{activeMessage.sender.split(' ').map(part => part[0]).join('')}</span><div><strong>{activeMessage.sender}</strong><span>{activeMessage.address}</span><span>To: {activeMessage.to}</span></div><time>{activeMessage.date}</time></div>
          <div className="admin-mail-body">{activeMessage.body.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
          <div className="admin-mail-actions">{activeMessage.folder !== 'Trash' && <button type="button" className="admin-mail-primary" onClick={startReply} data-testid="button-reply-mail"><CornerUpLeft size={15} /> Reply draft</button>}<button type="button" className="admin-mail-secondary" onClick={() => setMessages(current => current.map(message => message.id === activeMessage.id ? { ...message, starred: !message.starred } : message))} aria-label={activeMessage.starred ? 'Remove star' : 'Star message'} data-testid="button-star-mail"><Star size={15} fill={activeMessage.starred ? 'currentColor' : 'none'} /> {activeMessage.starred ? 'Starred' : 'Star'}</button>{activeMessage.folder !== 'Archive' && activeMessage.folder !== 'Trash' && <button type="button" className="admin-mail-secondary" onClick={() => moveMessage('Archive')} data-testid="button-archive-mail"><Archive size={15} /> Archive</button>}{activeMessage.folder !== 'Trash' && <button type="button" className="admin-mail-secondary" onClick={() => moveMessage('Trash')} data-testid="button-trash-mail"><Trash2 size={15} /> Trash</button>}{activeMessage.folder === 'Trash' && <button type="button" className="admin-mail-secondary" onClick={() => moveMessage('Inbox')} data-testid="button-restore-mail">Restore to inbox</button>}{activeMessage.folder === 'Archive' && <button type="button" className="admin-mail-secondary" onClick={() => moveMessage('Inbox')} data-testid="button-move-mail-inbox">Move to inbox</button>}</div>
          <div className="admin-mail-reader-foot"><Info size={14} /> Fictional sample content. No real message was received.</div>
        </article> : <div className="admin-mail-reader-empty"><span className="admin-mail-empty-mark"><Mail size={26} /></span><span className="admin-mail-overline">READING DESK</span><h2>Select a conversation</h2><p>Choose a sample message from the list to read it here, or compose a local draft.</p></div>}
      </section>
    </div>
  </div>;
}