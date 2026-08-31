import './lib/consoleFilters';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Toaster } from './components/ui/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import RouteErrorFallback from './components/RouteErrorFallback';
import { ThemeProvider } from './components/ThemeContext';
import { isStaleChunkError, reloadOnceForStaleChunk } from './utils/staleChunkReload';
import { reportClientError } from './lib/clientErrorReporter';
import { registerServiceWorker } from './lib/registerServiceWorker';
import App from './App';
import './index.css';

// Offline app-shell + low-bandwidth asset caching (production, secure-context
// only — no-op in dev and over plain-HTTP Tailnet). See lib/registerServiceWorker.
registerServiceWorker();

// Vite emits `vite:preloadError` when a code-split chunk's preload 404s —
// usually because the server rebuilt and the chunk filename changed while
// this tab was still open. Catching it here reloads before React's error
// boundary ever sees the failure.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadOnceForStaleChunk()) event.preventDefault?.();
});

// Handle unhandled promise rejections — also a chance to catch stale chunks
// that surface as a rejected dynamic-import promise outside React's tree.
window.addEventListener('unhandledrejection', (event) => {
  if (isStaleChunkError(event.reason) && reloadOnceForStaleChunk()) {
    event.preventDefault();
    return;
  }
  // Report first so a hostile `event.reason` (throwing toString / circular)
  // can't take down the handler before `reportClientError` runs. Pass the
  // reason as a separate console argument — no implicit String() coercion.
  reportClientError({ type: 'unhandledrejection', reason: event.reason });
  console.error('❌ Unhandled Promise Rejection:', event.reason);
  event.preventDefault();
});

// Handle global errors
window.addEventListener('error', (event) => {
  console.error(`💥 Global Error: ${event.message}`);
  reportClientError({
    type: 'error',
    message: event.message,
    error: event.error,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

// Data router (not a plain <BrowserRouter>) so `useBlocker` is available —
// it is the only way an editor can stop a sidebar link, a ⌘K jump, a voice
// `ui_navigate`, or the browser Back button from dropping an unsaved draft
// (#3958, see hooks/useUnsavedChangesGuard). The whole existing <Routes> tree
// stays mounted under one splat route, so no page needed rewriting; new pages
// keep adding a <Route> in App.jsx exactly as before.
const router = createBrowserRouter([
  {
    path: '*',
    errorElement: <RouteErrorFallback />,
    element: (
      <>
        <App />
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: 'rgb(var(--port-card) / var(--port-card-alpha, 1))',
              color: 'rgb(var(--port-text))',
              border: '1px solid rgb(var(--port-border) / var(--port-border-alpha, 1))',
              borderRadius: 'var(--port-radius-lg)',
              backdropFilter: 'var(--port-backdrop-filter)',
              boxShadow: 'var(--port-shadow-elevated)'
            }
          }}
        />
      </>
    ),
  },
]);

// The QR audience route is intentionally a no-bootstrap guest surface. Avoid
// the theme settings request on a password-gated install: its 401 redirect
// would otherwise replace the URL and discard the fragment credentials.
const isHostedAudienceRoute = window.location.pathname.replace(/\/+$/, '') === '/fableloom/join';
const app = isHostedAudienceRoute
  ? <RouterProvider router={router} />
  : (
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  );

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      {app}
    </ErrorBoundary>
  </React.StrictMode>
);
