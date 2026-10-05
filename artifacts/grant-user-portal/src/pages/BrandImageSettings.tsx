import { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Mail, RotateCcw, Trash2, Upload } from 'lucide-react';
import * as api from '@workspace/api-client-react';
import type { Branding } from '@workspace/api-client-react';
import { BRAND_IMAGE_LABELS, DEFAULT_EMAIL_COLOR, MAX_BRAND_IMAGE_BYTES, type BrandImageKind } from '@workspace/domain/branding';
import { brandLetter, useAppName, Wordmark } from '@/lib/appName';
import { apiError } from '@/lib/serverData';
import { useCan } from './AdminStaff';
import { ColorPicker } from './BrandColorSettings';
import './BrandColorSettings.css';

type Feedback = { tone: 'ok' | 'error'; text: string } | null;
const ACCEPT = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const SLOTS: { kind: BrandImageKind; url: 'logoUrl' | 'logoDarkUrl' | 'faviconUrl'; dark: boolean; help: string;
  upload: (file: Blob) => Promise<Branding>; remove: () => Promise<Branding> }[] = [
  { kind: 'logo', url: 'logoUrl', dark: false, help: 'Replaces the letter mark and the name everywhere: emails, the phone header, and (unless you add the next one) the dark sidebars and sign-in pages. A wide PNG with a transparent background works best; emails show it 40 px high.', upload: api.uploadBrandLogo, remove: api.removeBrandLogo },
  { kind: 'logoDark', url: 'logoDarkUrl', dark: true, help: 'Optional: a light version for the dark sidebars and sign-in pages, if your main logo is dark.', upload: api.uploadBrandLogoDark, remove: api.removeBrandLogoDark },
  { kind: 'favicon', url: 'faviconUrl', dark: false, help: 'The small icon in browser tabs and bookmarks. Use a square PNG, at least 64 × 64 px.', upload: api.uploadBrandFavicon, remove: api.removeBrandFavicon },
];

/** One upload slot: a preview on the background it's shown on, and upload / remove. */
function ImageSlot({ slot, editable }: { slot: typeof SLOTS[number]; editable: boolean }) {
  const branding = useAppName();
  const { adopt, name } = branding;
  const url = branding[slot.url];
  const fallback = slot.kind === 'logoDark' ? branding.logoUrl : null;
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const label = BRAND_IMAGE_LABELS[slot.kind];
  const max = MAX_BRAND_IMAGE_BYTES[slot.kind];

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!TYPES.includes(file.type)) { setFeedback({ tone: 'error', text: 'Choose a PNG, JPG, or WEBP image.' }); return; }
    if (file.size > max) { setFeedback({ tone: 'error', text: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${max / 1024 / 1024} MB.` }); return; }
    setBusy(true); setFeedback(null);
    try { adopt(await slot.upload(file)); setFeedback({ tone: 'ok', text: `${label} saved. Everyone sees it now.` }); }
    catch (err) { setFeedback({ tone: 'error', text: apiError(err, `Couldn't upload the ${label.toLowerCase()}.`).error }); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setFeedback(null);
    try { adopt(await slot.remove()); setFeedback({ tone: 'ok', text: `${label} removed.` }); }
    catch (err) { setFeedback({ tone: 'error', text: apiError(err, `Couldn't remove the ${label.toLowerCase()}.`).error }); }
    finally { setBusy(false); }
  };

  const shown = url ?? fallback;
  const preview = slot.kind === 'favicon'
    ? <div className="admin-brand-tab" aria-label="Browser tab preview">{url ? <img src={url} alt="" /> : <span className="admin-brand-tab-default" aria-hidden="true">{brandLetter(name)}</span>}<span>Dashboard | {name}</span></div>
    : shown ? <img className="admin-brand-slot-logo" src={shown} alt={`${label} preview`} />
    : <div className="admin-brand-slot-fallback"><span className="admin-brand-preview-mark" aria-hidden="true">{brandLetter(name)}</span><strong><Wordmark /></strong></div>;

  return <div className="admin-brand-slot" data-testid={`slot-brand-${slot.kind}`}>
    <div className={`admin-brand-slot-stage ${slot.dark ? 'dark' : 'light'}`}>{preview}</div>
    <div className="admin-brand-slot-body">
      <strong>{label}</strong>
      <small>{slot.help}{slot.kind === 'logoDark' && !url && branding.logoUrl ? ' Showing the main logo until you add one.' : ''}</small>
      {editable && <div className="admin-review-buttons" style={{ flexWrap: 'wrap', marginTop: 10 }}>
        <input ref={fileRef} type="file" hidden accept={ACCEPT} onChange={e => { void pick(e.target.files?.[0]); e.target.value = ''; }} data-testid={`input-brand-${slot.kind}-file`} />
        <button type="button" className="admin-btn primary" disabled={busy} onClick={() => fileRef.current?.click()} data-testid={`button-upload-brand-${slot.kind}`}><Upload size={13} /> {busy ? 'Saving…' : url ? 'Replace' : 'Upload'}</button>
        {url && <button type="button" className="admin-btn" disabled={busy} onClick={() => void remove()} data-testid={`button-remove-brand-${slot.kind}`}><Trash2 size={13} /> Remove</button>}
      </div>}
      {feedback && <p className={feedback.tone === 'error' ? 'admin-field-error' : 'admin-brand-feedback'} role="status" data-testid={`status-brand-${slot.kind}`}>{feedback.text}</p>}
    </div>
  </div>;
}

/** Logo, logo for dark backgrounds, and favicon: saved on the server for everyone (super admins). */
export function BrandImageSettings() {
  const { shared } = useAppName();
  const can = useCan();
  const editable = can('staff.manage');
  return <section className="admin-panel admin-brand-settings" aria-labelledby="admin-brand-images-title" data-testid="panel-admin-brand-images">
    <div className="admin-panel-head">
      <div><p className="admin-brand-settings-kicker"><ImageIcon size={15} /> APPEARANCE / LOGO</p><h2 id="admin-brand-images-title">Logo and favicon</h2>
        <p>{shared ? 'Shown to everyone: the applicant portal, the admin, sign-in pages, and emails. PNG, JPG, or WEBP. Only super admins can change them.' : 'Logos and the favicon are saved on the server, so they need sign-in to be set up.'}</p></div>
      <span className="admin-brand-settings-chip">{shared ? 'EVERYONE' : 'NEEDS SIGN-IN'}</span>
    </div>
    {shared && <div className="admin-brand-slots">{SLOTS.map(slot => <ImageSlot key={slot.kind} slot={slot} editable={editable} />)}</div>}
    {shared && !editable && <p className="admin-brand-feedback">Only a super admin can change these.</p>}
  </section>;
}

const EMAIL_PRESETS = [
  { name: 'Ink', hex: DEFAULT_EMAIL_COLOR },
  { name: 'Ocean', hex: '#1D4ED8' },
  { name: 'Forest', hex: '#166534' },
  { name: 'Plum', hex: '#6D28D9' },
  { name: 'Brick', hex: '#B91C1C' },
];

/** The email colour (top bar and button), with a preview of a real email carrying the saved logo. */
export function EmailBrandSettings() {
  const { shared, emailColor, logoUrl, adopt } = useAppName();
  const can = useCan();
  const editable = can('staff.manage');
  const saved = emailColor ?? DEFAULT_EMAIL_COLOR;
  const [color, setColor] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [preview, setPreview] = useState<{ subject: string; html: string; logoShown: boolean } | null>(null);
  const [previewError, setPreviewError] = useState('');
  useEffect(() => { setColor(saved); }, [saved]);
  const dirty = color !== saved;

  // The preview is rendered by the server, exactly as emails are sent; refreshed as the colour or logo changes.
  useEffect(() => {
    if (!shared || !editable) return;
    let live = true;
    const t = setTimeout(() => {
      api.previewBrandEmail({ emailColor: color }).then(p => { if (live) { setPreview(p); setPreviewError(''); } })
        .catch(err => { if (live) setPreviewError(apiError(err, "Couldn't load the preview.").error); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [shared, editable, color, logoUrl]);

  const publish = async (next: string | null) => {
    setBusy(true); setFeedback(null);
    try {
      adopt(await api.setBrandColors({ emailColor: next }));
      setColor(next ?? DEFAULT_EMAIL_COLOR);
      setFeedback({ tone: 'ok', text: 'Saved. Emails sent from now on use this colour.' });
    } catch (err) { setFeedback({ tone: 'error', text: apiError(err, "Couldn't save the email colour.").error }); }
    finally { setBusy(false); }
  };

  return <section className="admin-panel admin-brand-settings" aria-labelledby="admin-email-brand-title" data-testid="panel-admin-email-brand">
    <div className="admin-panel-head">
      <div><p className="admin-brand-settings-kicker"><Mail size={15} /> APPEARANCE / EMAIL</p><h2 id="admin-email-brand-title">Email look</h2>
        <p>{shared ? 'The colour of the top bar and button in every email, with your logo at the top. The preview is the real email layout; nothing is sent.' : 'Emails are sent by the server, so their look needs sign-in to be set up.'}</p></div>
      <span className="admin-brand-settings-chip">{shared ? 'EVERY EMAIL' : 'NEEDS SIGN-IN'}</span>
    </div>
    {shared && !editable && <p className="admin-brand-feedback">Only a super admin can change this.</p>}
    {shared && editable && <div className="admin-brand-email-layout">
      <div>
        <span className="admin-brand-settings-label">Email colour</span>
        <ColorPicker value={color} onPick={next => { setColor(next); setFeedback(null); }} disabled={busy} presets={EMAIL_PRESETS} idPrefix="email-color" />
        <div className="admin-review-buttons" style={{ marginTop: 16, flexWrap: 'wrap' }}>
          <button type="button" className="admin-btn primary" disabled={!dirty || busy} onClick={() => void publish(color === DEFAULT_EMAIL_COLOR ? null : color)} data-testid="button-save-email-color">{busy ? 'Saving…' : 'Save email colour'}</button>
          {dirty && <button type="button" className="admin-btn" disabled={busy} onClick={() => { setColor(saved); setFeedback(null); }} data-testid="button-discard-email-color">Discard</button>}
        </div>
        {saved !== DEFAULT_EMAIL_COLOR && <button type="button" className="admin-brand-reset" disabled={busy} onClick={() => void publish(null)} data-testid="button-reset-email-color"><RotateCcw size={14} /> Restore original colour</button>}
        {feedback && <p className={feedback.tone === 'error' ? 'admin-field-error' : 'admin-brand-feedback'} role="status" data-testid="status-email-color-change">{feedback.text}</p>}
        {dirty && <p className="admin-brand-feedback">The preview shows your choice; save to use it in emails.</p>}
        {preview && !preview.logoShown && <p className="admin-brand-feedback" data-testid="text-email-logo-note">{logoUrl ? 'The logo needs the portal address (Settings → Email) so email apps can load it; until then emails show the name.' : 'Upload a logo above to show it at the top of emails; until then they show the name.'}</p>}
      </div>
      <div className="admin-brand-email-preview">
        <span className="admin-brand-preview-kicker">PREVIEW{preview ? ` · ${preview.subject}` : ''}</span>
        {previewError ? <p className="admin-field-error" role="alert">{previewError}</p>
          : preview ? <iframe title="Email preview" sandbox="" srcDoc={preview.html} data-testid="frame-email-preview" />
          : <p className="admin-brand-feedback">Loading the preview…</p>}
      </div>
    </div>}
  </section>;
}
