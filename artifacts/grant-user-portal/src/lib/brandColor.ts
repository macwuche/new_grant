export const DEFAULT_BRAND_COLOR = '#C9F35B';
export const BRAND_COLOR_STORAGE_KEY = 'arc.fund.previewBrandColor';

const isHexColor = (value: string): boolean => /^#[0-9a-f]{6}$/i.test(value);

export function readBrandColor(): string | null {
  try {
    const value = window.localStorage.getItem(BRAND_COLOR_STORAGE_KEY);
    return value && isHexColor(value) ? value.toUpperCase() : null;
  } catch {
    return null;
  }
}

export function applyBrandColor(value: string | null): void {
  const root = document.documentElement;
  if (!value || !isHexColor(value)) {
    for (const property of ['--brand-accent', '--brand-accent-ink', '--lime', '--lime-deep']) {
      root.style.removeProperty(property);
    }
    return;
  }

  const [red, green, blue] = [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));
  const [r, g, b] = [red, green, blue].map(channel => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  const linear = [r, g, b].map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  const darkInkLuminance = 0.017;
  const whiteContrast = 1.05 / (luminance + 0.05);
  const darkContrast = (luminance + 0.05) / (darkInkLuminance + 0.05);
  const ink = whiteContrast > darkContrast ? '#ffffff' : '#1d2330';

  root.style.setProperty('--brand-accent', value);
  root.style.setProperty('--brand-accent-ink', ink);
  root.style.setProperty('--lime', `${Math.round(hue)} ${Math.round(saturation * 100)}% ${Math.round(lightness * 100)}%`);
  root.style.setProperty('--lime-deep', `${Math.round(hue)} ${Math.round(saturation * 85)}% ${Math.max(22, Math.min(43, Math.round(lightness * 100) - 16))}%`);
}

export function storeBrandColor(value: string | null): boolean {
  try {
    if (value) window.localStorage.setItem(BRAND_COLOR_STORAGE_KEY, value);
    else window.localStorage.removeItem(BRAND_COLOR_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}