import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';
import { applyBrandColor, BRAND_COLOR_STORAGE_KEY, readBrandColor } from '@/lib/brandColor';

import './index.css';

applyBrandColor(readBrandColor());
window.addEventListener('storage', event => {
  if (event.key === BRAND_COLOR_STORAGE_KEY) applyBrandColor(readBrandColor());
});

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
