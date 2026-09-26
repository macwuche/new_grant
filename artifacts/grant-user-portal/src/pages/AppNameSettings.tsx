import { useEffect, useState, type FormEvent } from 'react';
import { Type } from 'lucide-react';
import { brandLetter, DEFAULT_APP_NAME, useAppName, Wordmark } from '@/lib/appName';
import { apiError } from '@/lib/serverData';
import { useCan } from './AdminStaff';
import './BrandColorSettings.css';

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} .&'-]{0,39}$/u;

/** The application's name. Signed in: super admins change it for everyone (portal, emails, authenticator apps). Demo: this browser only. */
export function AppNameSettings() {
  const { name, isDefault, shared, save } = useAppName();
  const can = useCan();
  const editable = !shared || can('staff.manage');
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => { setDraft(name); }, [name]);
  const preview = draft.trim().replace(/\s+/g, ' ') || DEFAULT_APP_NAME;

  const submit = async (next: string) => {
    const value = next.trim().replace(/\s+/g, ' ');
    if (value && !NAME.test(value)) { setFeedback({ tone: 'error', text: "Use up to 40 letters, numbers, spaces, and . - & ' only." }); return; }
    setBusy(true); setFeedback(null);
    try {
      const stored = await save(value);
      setFeedback({ tone: 'ok', text: shared
        ? `Saved. Everyone now sees ${value || DEFAULT_APP_NAME}. If Supabase's sign-in emails use the app's wording, press Reapply under Email verification at sign-up so they say the new name too.`
        : stored ? 'Saved in this browser only. Other visitors still see the original name.' : 'Applied for this tab, but this browser blocked local storage. It may reset on reload.' });
    } catch (err) { setFeedback({ tone: 'error', text: apiError(err, "Couldn't save the name.").error }); }
    finally { setBusy(false); }
  };
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void submit(draft); };

  return <section className="admin-panel admin-brand-settings" aria-labelledby="admin-app-name-title" data-testid="panel-admin-app-name">
    <div className="admin-panel-head">
      <div><p className="admin-brand-settings-kicker"><Type size={15} /> APPEARANCE / NAME</p><h2 id="admin-app-name-title">Application name</h2>
        <p>{shared ? 'Shown on every page, in page titles, in every email, and in authenticator apps for new two-step setups. Only super admins can change it.' : 'Try a different name across the admin and applicant pages. Only this browser sees the change.'}</p></div>
      <span className="admin-brand-settings-chip" data-testid="status-app-name-scope">{shared ? 'EVERYONE' : 'BROWSER PREVIEW'}</span>
    </div>
    <div className="admin-brand-settings-layout">
      <form onSubmit={onSubmit} noValidate>
        <label className="admin-review-field"><span>Name</span>
          <input className="admin-input" value={draft} maxLength={40} disabled={!editable || busy} onChange={e => { setDraft(e.target.value); setFeedback(null); }} placeholder={DEFAULT_APP_NAME} data-testid="input-app-name" />
          <small>{editable ? 'Up to 40 characters. A "." is shown in the accent colour, as in arc.fund.' : 'Only a super admin can change this.'}</small></label>
        {editable && <div className="admin-review-buttons" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <button type="submit" className="admin-btn primary" disabled={busy || preview === name} data-testid="button-save-app-name">{busy ? 'Saving…' : 'Save name'}</button>
          {!isDefault && <button type="button" className="admin-btn" disabled={busy} onClick={() => void submit('')} data-testid="button-reset-app-name">Restore {DEFAULT_APP_NAME}</button>}
        </div>}
        {feedback && <p className={feedback.tone === 'error' ? 'admin-field-error' : 'admin-brand-feedback'} role="status" data-testid="status-app-name-change">{feedback.text}</p>}
      </form>
      <div className="admin-brand-preview" aria-label="Name preview">
        <span className="admin-brand-preview-kicker">PREVIEW</span>
        <div className="admin-brand-preview-title"><span className="admin-brand-preview-mark">{brandLetter(preview)}</span><strong><Wordmark name={preview} /></strong></div>
        <p>Dashboard | {preview}</p>
      </div>
    </div>
  </section>;
}
