import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Palette, RotateCcw } from 'lucide-react';
import { setBrandColors } from '@workspace/api-client-react';
import { applyBrandColor, DEFAULT_BRAND_COLOR, readBrandColor, storeBrandColor } from '@/lib/brandColor';
import { BrandLockup, useAppName } from '@/lib/appName';
import { apiError } from '@/lib/serverData';
import { useCan } from './AdminStaff';
import './BrandColorSettings.css';

export const BRAND_PRESETS = [
  { name: 'Arc lime', hex: DEFAULT_BRAND_COLOR },
  { name: 'Sea glass', hex: '#82D0C2' },
  { name: 'Apricot', hex: '#F5A86C' },
  { name: 'Periwinkle', hex: '#8EA7F1' },
  { name: 'Orchid', hex: '#D997D0' },
];

type Feedback = { tone: 'ok' | 'error'; text: string } | null;

/** Preset swatches and a custom picker, shared by the app and email colour panels. */
export function ColorPicker({ value, onPick, disabled, presets, idPrefix }: { value: string; onPick: (hex: string) => void; disabled: boolean; presets: { name: string; hex: string }[]; idPrefix: string }) {
  return <>
    <div className="admin-brand-swatches" role="group" aria-label="Colour presets">
      {presets.map(option => <button key={option.hex} type="button" disabled={disabled} className={`admin-brand-swatch ${value === option.hex ? 'selected' : ''}`} style={{ '--swatch-color': option.hex } as CSSProperties} onClick={() => onPick(option.hex)} aria-label={`${option.name} (${option.hex})`} aria-pressed={value === option.hex} title={option.name} data-testid={`button-${idPrefix}-${option.name.toLowerCase().replace(' ', '-')}`}><span /></button>)}
    </div>
    <label className="admin-brand-custom" htmlFor={`${idPrefix}-picker`}>Custom colour <input id={`${idPrefix}-picker`} type="color" disabled={disabled} value={value} onChange={event => onPick(event.target.value.toUpperCase())} data-testid={`input-${idPrefix}`} /><strong data-testid={`text-${idPrefix}-value`}>{value}</strong></label>
  </>;
}

/**
 * The app's accent colour. Signed in: super admins save it for everyone (portal and admin);
 * picking previews it in this tab until saved. Demo: a preview saved in this browser only.
 */
export function BrandColorSettings() {
  const { shared, brandColor, adopt } = useAppName();
  const can = useCan();
  const editable = !shared || can('staff.manage');
  const saved = (shared ? brandColor : readBrandColor()) ?? DEFAULT_BRAND_COLOR;
  const [color, setColor] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  useEffect(() => { if (shared) setColor(saved); }, [shared, saved]);
  // Leaving the page with an unsaved choice puts everyone's colour back in this tab.
  const savedRef = useRef(brandColor);
  savedRef.current = brandColor;
  useEffect(() => () => { if (shared) applyBrandColor(savedRef.current); }, [shared]);
  const dirty = shared && color !== saved;

  const choose = (next: string) => {
    setColor(next);
    applyBrandColor(next);
    if (shared) { setFeedback(null); return; }
    setFeedback({ tone: 'ok', text: storeBrandColor(next)
      ? 'Preview colour saved in this browser. It is not published for other visitors.'
      : 'Colour preview applied, but this browser blocked local storage. It may reset on reload.' });
  };
  const publish = async (next: string | null) => {
    setBusy(true); setFeedback(null);
    try {
      adopt(await setBrandColors({ brandColor: next }));
      setColor(next ?? DEFAULT_BRAND_COLOR);
      setFeedback({ tone: 'ok', text: next ? `Saved. Everyone now sees ${next} across the applicant portal and the admin.` : 'Saved. Everyone sees the original colour again.' });
    } catch (err) { setFeedback({ tone: 'error', text: apiError(err, "Couldn't save the colour.").error }); }
    finally { setBusy(false); }
  };
  const discard = () => { setColor(saved); applyBrandColor(brandColor); setFeedback(null); };
  const reset = () => {
    if (shared) { void publish(null); return; }
    setColor(DEFAULT_BRAND_COLOR);
    applyBrandColor(null);
    setFeedback({ tone: 'ok', text: storeBrandColor(null) ? 'Original brand colour restored in this browser.' : 'Original colour restored for this tab, but browser storage could not be updated.' });
  };

  return <section className="admin-panel admin-brand-settings" aria-labelledby="admin-brand-settings-title" data-testid="panel-admin-brand-color">
    <div className="admin-panel-head">
      <div><p className="admin-brand-settings-kicker"><Palette size={15} /> APPEARANCE / COLOUR</p><h2 id="admin-brand-settings-title">App colour</h2>
        <p>{shared ? 'The accent on buttons, highlights, and navigation, in the applicant portal and the admin. Saved for everyone; only super admins can change it.' : 'Try an accent across the admin and applicant pages. Only this browser sees the change; it is not published for everyone.'}</p></div>
      <span className="admin-brand-settings-chip" data-testid="status-brand-color-preview">{shared ? 'EVERYONE' : 'BROWSER PREVIEW'}</span>
    </div>
    <div className="admin-brand-settings-layout">
      <div>
        <span className="admin-brand-settings-label">Choose a colour</span>
        <ColorPicker value={color} onPick={choose} disabled={!editable || busy} presets={BRAND_PRESETS} idPrefix="brand-color" />
        {shared && editable && <div className="admin-review-buttons" style={{ marginTop: 16, flexWrap: 'wrap' }}>
          <button type="button" className="admin-btn primary" disabled={!dirty || busy} onClick={() => void publish(color === DEFAULT_BRAND_COLOR ? null : color)} data-testid="button-save-brand-color">{busy ? 'Saving…' : 'Save colour'}</button>
          {dirty && <button type="button" className="admin-btn" disabled={busy} onClick={discard} data-testid="button-discard-brand-color">Discard</button>}
        </div>}
        {editable && saved !== DEFAULT_BRAND_COLOR && <button type="button" className="admin-brand-reset" disabled={busy} onClick={reset} data-testid="button-reset-brand-color"><RotateCcw size={14} /> Restore original colour</button>}
        {!editable && <p className="admin-brand-feedback">Only a super admin can change this.</p>}
        {feedback && <p className={feedback.tone === 'error' ? 'admin-field-error' : 'admin-brand-feedback'} role="status" data-testid="status-brand-color-change">{feedback.text}</p>}
        {dirty && <p className="admin-brand-feedback">Previewing in this tab only. Save to publish it.</p>}
      </div>
      <div className="admin-brand-preview" aria-label="Brand colour preview">
        <span className="admin-brand-preview-kicker">LIVE PREVIEW</span>
        <div className="admin-brand-preview-title"><BrandLockup onDark markClass="admin-brand-preview-mark" nameClass="admin-brand-preview-name" logoClass="admin-brand-preview-logo" /></div>
        <p>Your chosen accent updates navigation, highlights, and buttons.</p>
        <span className="admin-brand-preview-action">Brand action <span>↗</span></span>
      </div>
    </div>
  </section>;
}
