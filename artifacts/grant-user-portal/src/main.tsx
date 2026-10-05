import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';
import { applyBrandColor, BRAND_COLOR_STORAGE_KEY, readBrandColor } from '@/lib/brandColor';
import { applyFavicon, readCachedBranding } from '@/lib/appName';
import { supabase } from '@/lib/supabase';

import './index.css';

if (supabase) {
  // Signed-in mode: everyone's colour and favicon, as last loaded (AppNameProvider refreshes them).
  const cached = readCachedBranding();
  applyBrandColor(cached.brandColor);
  applyFavicon(cached.faviconUrl);
} else {
  // Demo mode: the colour previewed in this browser.
  applyBrandColor(readBrandColor());
  window.addEventListener('storage', event => {
    if (event.key === BRAND_COLOR_STORAGE_KEY) applyBrandColor(readBrandColor());
  });
}

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
