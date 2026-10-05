import { describe, expect, it } from 'vitest';
import { brandImagePath, inkFor, normalizeHex } from './branding';

describe('branding', () => {
  it('accepts only #RRGGBB colours, saved in capitals', () => {
    expect(normalizeHex(' #1d4ed8 ')).toBe('#1D4ED8');
    for (const bad of ['red', '#123', '#12345g', '1D4ED8', '#1D4ED8;background:url(x)']) expect(normalizeHex(bad)).toBeNull();
  });

  it('picks readable text for a colour', () => {
    expect(inkFor('#1D1D1B')).toBe('#FFFFFF');
    expect(inkFor('#1D4ED8')).toBe('#FFFFFF');
    expect(inkFor('#C9F35B')).toBe('#1D2330');
    expect(inkFor('#FFFFFF')).toBe('#1D2330');
  });

  it('serves each image at a versioned public address', () => {
    expect(brandImagePath('logo', 'abcdef0123456789')).toBe('/api/branding/logo?v=abcdef012345');
    expect(brandImagePath('logoDark', 'ff'.repeat(32))).toBe(`/api/branding/logo-dark?v=${'ff'.repeat(6)}`);
    expect(brandImagePath('favicon', '00'.repeat(32))).toMatch(/^\/api\/branding\/favicon\?v=0{12}$/);
  });
});
