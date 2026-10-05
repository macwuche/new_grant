import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getBranding, setBranding, type Branding } from '@workspace/api-client-react';
import { applyBrandColor } from './brandColor';
import { supabase } from './supabase';

// The application's branding: name, accent colours, logos, and favicon.
// Signed-in mode: saved on the server by a super admin (GET /api/branding is
// public, so sign-in pages show it too) and the same for everyone, including
// emails. Demo mode: the name and colour are a preview saved in this browser
// only; logos and the favicon need sign-in.

export const DEFAULT_APP_NAME = 'arc.fund';
const DEMO_KEY = 'arc.fund.previewAppName';
// The last name the server gave, so pages don't flash the default on load. It's public, not a record.
const CACHE_KEY = 'arc.fund.appName';
// The last branding the server gave (public), so the colour, logo, and favicon don't flash on load.
export const BRANDING_CACHE_KEY = 'arc.fund.branding';

const read = (key: string) => { try { return window.localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => {
  try { if (value) window.localStorage.setItem(key, value); else window.localStorage.removeItem(key); return true; } catch { return false; }
};

export type BrandImages = Pick<Branding, 'brandColor' | 'emailColor' | 'logoUrl' | 'logoDarkUrl' | 'faviconUrl'>;
const NO_IMAGES: BrandImages = { brandColor: null, emailColor: null, logoUrl: null, logoDarkUrl: null, faviconUrl: null };

/** The shared branding last cached in this browser (signed-in mode). */
export function readCachedBranding(): BrandImages {
  try { return { ...NO_IMAGES, ...JSON.parse(read(BRANDING_CACHE_KEY) ?? '{}') as Partial<BrandImages> }; } catch { return NO_IMAGES; }
}

/** Points the tab icon at the uploaded favicon, or back at the default. */
export function applyFavicon(url: string | null) {
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  if (url) { link.removeAttribute('type'); link.href = url; }
  else { link.type = 'image/svg+xml'; link.href = `${import.meta.env.BASE_URL}favicon.svg`; }
}

type AppNameState = BrandImages & {
  name: string;
  isDefault: boolean;
  /** True when the branding is saved on the server for everyone; false in demo mode (this browser only). */
  shared: boolean;
  /** Saves a new name ('' restores the default). Resolves to false when the browser couldn't store a demo preview. */
  save: (name: string) => Promise<boolean>;
  /** Takes branding the server just returned (after a colour or image change), so every page updates at once. */
  adopt: (branding: Branding) => void;
};

const AppNameContext = createContext<AppNameState>({ name: DEFAULT_APP_NAME, isDefault: true, shared: false, save: async () => false, adopt: () => {}, ...NO_IMAGES });

export function AppNameProvider({ children }: { children: ReactNode }) {
  const shared = !!supabase;
  const [name, setName] = useState(() => read(shared ? CACHE_KEY : DEMO_KEY) || DEFAULT_APP_NAME);
  const [images, setImages] = useState<BrandImages>(() => shared ? readCachedBranding() : NO_IMAGES);
  const apply = useCallback((next: string | null) => {
    const value = next || DEFAULT_APP_NAME;
    setName(value);
    if (shared) write(CACHE_KEY, value === DEFAULT_APP_NAME ? null : value);
  }, [shared]);
  const adopt = useCallback((b: Branding) => {
    apply(b.appName);
    const next: BrandImages = { brandColor: b.brandColor, emailColor: b.emailColor, logoUrl: b.logoUrl, logoDarkUrl: b.logoDarkUrl, faviconUrl: b.faviconUrl };
    setImages(next);
    write(BRANDING_CACHE_KEY, JSON.stringify(next));
  }, [apply]);

  // Signed in, the colour and favicon are everyone's; in demo mode the colour is the browser preview (main.tsx).
  useEffect(() => { if (shared) { applyBrandColor(images.brandColor); applyFavicon(images.faviconUrl); } }, [shared, images.brandColor, images.faviconUrl]);

  useEffect(() => {
    if (!shared) {
      const onStorage = (e: StorageEvent) => { if (e.key === DEMO_KEY) setName(read(DEMO_KEY) || DEFAULT_APP_NAME); };
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    }
    let live = true;
    const load = () => { getBranding().then(b => { if (live) adopt(b); }).catch(() => {}); };
    load();
    window.addEventListener('focus', load);
    return () => { live = false; window.removeEventListener('focus', load); };
  }, [shared, adopt]);

  const save = useCallback(async (next: string) => {
    const trimmed = next.trim().replace(/\s+/g, ' ');
    if (shared) { adopt(await setBranding({ appName: trimmed })); return true; }
    const value = trimmed && trimmed !== DEFAULT_APP_NAME ? trimmed : null;
    setName(value ?? DEFAULT_APP_NAME);
    return write(DEMO_KEY, value);
  }, [shared, adopt]);

  return <AppNameContext.Provider value={{ name, isDefault: name === DEFAULT_APP_NAME, shared, save, adopt, ...images }}>{children}</AppNameContext.Provider>;
}

export const useAppName = () => useContext(AppNameContext);

/** The name as a wordmark: the first "." is styled as the accent dot, as in arc.fund. */
export function Wordmark({ name }: { name?: string }) {
  const { name: current } = useAppName();
  const text = name ?? current;
  const dot = text.indexOf('.');
  return dot > 0 && dot < text.length - 1 ? <>{text.slice(0, dot)}<span>.</span>{text.slice(dot + 1)}</> : <>{text}</>;
}

/** The single letter in the square brand mark. */
export const brandLetter = (name: string) => (name.trim()[0] ?? 'a').toLowerCase();

/** The name as plain text, for use inside sentences. */
export function AppNameText() { return <>{useAppName().name}</>; }

/** The letter for the square brand mark. */
export function BrandLetter() { return <>{brandLetter(useAppName().name)}</>; }

/** The name's first word (before any "." or space), for tight spots like the card face. */
export function ShortAppName() { const { name } = useAppName(); return <>{name.split(/[.\s]/)[0] || name}</>; }

/**
 * The brand as shown in headers: the uploaded logo, or the square letter mark and the
 * name. `onDark` picks the logo for dark backgrounds when there is one. The logo
 * replaces both the mark and the name; `markClass` / `nameClass` style the fallback.
 */
export function BrandLockup({ onDark, markClass, nameClass, logoClass, name: nameOverride }: { onDark: boolean; markClass: string; nameClass: string; logoClass: string; name?: ReactNode }) {
  const { name, logoUrl, logoDarkUrl } = useAppName();
  const [broken, setBroken] = useState<string | null>(null);
  // A logo made for dark backgrounds would vanish on a light one, so light headers use only the main logo.
  const src = (onDark ? logoDarkUrl ?? logoUrl : logoUrl) ?? null;
  if (src && broken !== src) return <img className={logoClass} src={src} alt={name} onError={() => setBroken(src)} data-testid="img-brand-logo" />;
  return <><span className={markClass} aria-hidden="true">{brandLetter(name)}</span><span className={nameClass}>{nameOverride ?? <Wordmark />}</span></>;
}
