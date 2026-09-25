import { useState, type CSSProperties } from 'react';
import { Palette, RotateCcw } from 'lucide-react';
import { applyBrandColor, DEFAULT_BRAND_COLOR, readBrandColor, storeBrandColor } from '@/lib/brandColor';
import './BrandColorSettings.css';

const colors = [
  { name: 'Arc lime', hex: DEFAULT_BRAND_COLOR },
  { name: 'Sea glass', hex: '#82D0C2' },
  { name: 'Apricot', hex: '#F5A86C' },
  { name: 'Periwinkle', hex: '#8EA7F1' },
  { name: 'Orchid', hex: '#D997D0' },
];

export function BrandColorSettings() {
  const [color, setColor] = useState(() => readBrandColor() ?? DEFAULT_BRAND_COLOR);
  const [feedback, setFeedback] = useState('');

  const chooseColor = (nextColor: string) => {
    const normalized = nextColor.toUpperCase();
    setColor(normalized);
    applyBrandColor(normalized);
    setFeedback(storeBrandColor(normalized)
      ? 'Preview color saved in this browser. It is not published for other visitors.'
      : 'Color preview applied, but this browser blocked local storage. It may reset on reload.');
  };
  const resetColor = () => {
    setColor(DEFAULT_BRAND_COLOR);
    applyBrandColor(null);
    setFeedback(storeBrandColor(null)
      ? 'Original brand color restored in this browser.'
      : 'Original color restored for this tab, but browser storage could not be updated.');
  };

  return <section className="admin-panel admin-brand-settings" aria-labelledby="admin-brand-settings-title">
    <div className="admin-panel-head">
      <div><p className="admin-brand-settings-kicker"><Palette size={15} /> APPEARANCE / BRAND</p><h2 id="admin-brand-settings-title">App brand color</h2><p>Try an accent across the admin and applicant pages. Only this browser sees the change; it is not published for everyone.</p></div>
      <span className="admin-brand-settings-chip" data-testid="status-brand-color-preview">BROWSER PREVIEW</span>
    </div>
    <div className="admin-brand-settings-layout">
      <div>
        <span className="admin-brand-settings-label">Choose a color</span>
        <div className="admin-brand-swatches" role="group" aria-label="Brand color presets">
          {colors.map(option => <button key={option.hex} type="button" className={`admin-brand-swatch ${color === option.hex ? 'selected' : ''}`} style={{ '--swatch-color': option.hex } as CSSProperties} onClick={() => chooseColor(option.hex)} aria-label={`${option.name} (${option.hex})`} aria-pressed={color === option.hex} title={option.name} data-testid={`button-brand-color-${option.name.toLowerCase().replace(' ', '-')}`}><span /></button>)}
        </div>
        <label className="admin-brand-custom" htmlFor="admin-brand-picker">Custom color <input id="admin-brand-picker" type="color" value={color} onChange={event => chooseColor(event.target.value)} data-testid="input-brand-color" /><strong data-testid="text-brand-color-value">{color}</strong></label>
        <button type="button" className="admin-brand-reset" onClick={resetColor} data-testid="button-reset-brand-color"><RotateCcw size={14} /> Restore original color</button>
        {feedback && <p className="admin-brand-feedback" role="status" data-testid="status-brand-color-change">{feedback}</p>}
      </div>
      <div className="admin-brand-preview" aria-label="Brand color preview">
        <span className="admin-brand-preview-kicker">LIVE PREVIEW</span>
        <div className="admin-brand-preview-title"><span className="admin-brand-preview-mark">a</span><strong>arc<span>.</span>fund</strong></div>
        <p>Your chosen accent updates navigation, highlights, and buttons in this browser.</p>
        <span className="admin-brand-preview-action">Brand action <span>↗</span></span>
      </div>
    </div>
  </section>;
}