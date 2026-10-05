// Shared branding rules: the app's accent colour, the email accent colour, and
// the uploaded logo, logo for dark backgrounds, and favicon. Saved on the
// server by a super admin and the same for everyone (portal, admin, emails).

export const DEFAULT_BRAND_COLOR = '#C9F35B';
/** The email button and top bar colour before a super admin picks one (the original dark button). */
export const DEFAULT_EMAIL_COLOR = '#1D1D1B';

export type BrandImageKind = 'logo' | 'logoDark' | 'favicon';
export const BRAND_IMAGE_KINDS: readonly BrandImageKind[] = ['logo', 'logoDark', 'favicon'];
/** Upload limits: logos up to 2 MB, the favicon up to 1 MB. */
export const MAX_BRAND_IMAGE_BYTES: Record<BrandImageKind, number> = { logo: 2 * 1024 * 1024, logoDark: 2 * 1024 * 1024, favicon: 1024 * 1024 };
export const BRAND_IMAGE_LABELS: Record<BrandImageKind, string> = { logo: 'Logo', logoDark: 'Logo for dark backgrounds', favicon: 'Favicon' };

export const isHexColor = (value: string): boolean => /^#[0-9a-f]{6}$/i.test(value);

/** A colour as saved: `#RRGGBB` in capitals; null for anything else. */
export const normalizeHex = (value: string): string | null => {
  const v = value.trim();
  return isHexColor(v) ? v.toUpperCase() : null;
};

/** The text colour that reads best on `hex`: white or the app's dark ink. */
export function inkFor(hex: string): '#FFFFFF' | '#1D2330' {
  const linear = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  const onWhite = 1.05 / (luminance + 0.05);
  const onDark = (luminance + 0.05) / (0.017 + 0.05);
  return onWhite > onDark ? '#FFFFFF' : '#1D2330';
}

/** Where a brand image is served (public), versioned by its hash so it can be cached. */
export const brandImagePath = (kind: BrandImageKind, sha256: string) => `/api/branding/${kind === 'logoDark' ? 'logo-dark' : kind}?v=${sha256.slice(0, 12)}`;
