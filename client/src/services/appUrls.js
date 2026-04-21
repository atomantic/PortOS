import { PORTOS_APP_ID } from './apiCore';

/**
 * Compute possible launch URLs for an app based on current page context.
 * Returns `{ https, http, dev }` — any may be null. Callers pick whichever
 * fits (tile uses the first non-null; detail view renders buttons for each).
 *
 * Self-app (`portos-default`) returns `{ http: origin }` only: the active
 * session's URL already has the correct scheme and port, so rewriting would
 * point at the wrong listener (HTTPS-only 5555 vs loopback-HTTP 5553).
 */
export function getLaunchUrls(app) {
  if (!app) return { https: null, http: null, dev: null };
  if (app.uiUrl) return { https: null, http: app.uiUrl, dev: null };
  const hostname = window.location.hostname;
  const protocol = window.location.protocol;
  const dev = app.devUiPort ? `${protocol}//${hostname}:${app.devUiPort}` : null;
  // Self-app: primary URL is the active origin (right scheme + port); dev still
  // reflects the Vite dev server on a separate port.
  if (app.id === PORTOS_APP_ID) {
    return { https: null, http: window.location.origin, dev };
  }
  return {
    https: app.tlsPort ? `https://${hostname}:${app.tlsPort}` : null,
    http: app.uiPort ? `${protocol}//${hostname}:${app.uiPort}` : null,
    dev
  };
}

/** Pick the single best URL (HTTPS > HTTP > null) — for tile-style single-click launch. */
export function getPrimaryLaunchUrl(app) {
  const { https, http } = getLaunchUrls(app);
  return https || http;
}
