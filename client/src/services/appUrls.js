import { PORTOS_APP_ID } from './apiCore';

/**
 * Compute possible launch URLs for an app based on current page context.
 * Returns `{ https, http, dev }` — any may be null. Callers pick whichever
 * fits (tile uses the first non-null; detail view renders buttons for each).
 *
 * Self-app (`portos-default`) returns `{ http: origin, dev: null }`: the active
 * session's URL already has the correct scheme and port, and production does
 * not serve a separate Vite UI for the management entry.
 */
export function getLaunchUrls(app) {
  if (!app) return { https: null, http: null, dev: null };
  if (app.uiUrl) return { https: null, http: app.uiUrl, dev: null };
  const hostname = window.location.hostname;
  // Non-TLS launch URLs always use http:// regardless of how PortOS itself is served —
  // inheriting window.location.protocol produced https:// links to plain-HTTP app ports
  // (e.g., uiPort, devUiPort) whenever PortOS was served over HTTPS, which doesn't work.
  //
  // A port serves ONE scheme. When an app terminates TLS on the same port it lists as
  // its uiPort/devUiPort (the common shape for a single-listener dev server that reads
  // the shared Tailscale cert), the plain-HTTP variant is that same TLS-only listener
  // and can never answer http://. Suppress those so we don't render a launch button
  // that is guaranteed to fail — the https one already covers that port.
  const tlsPort = app.tlsPort || null;
  const httpPort = (port) => (port && port !== tlsPort ? port : null);
  const devPort = app.id === PORTOS_APP_ID ? null : httpPort(app.devUiPort);
  const dev = devPort ? `http://${hostname}:${devPort}` : null;
  // Self-app: primary URL is the active origin (right scheme + port).
  if (app.id === PORTOS_APP_ID) {
    return { https: null, http: window.location.origin, dev: null };
  }
  const uiPort = httpPort(app.uiPort);
  return {
    https: tlsPort ? `https://${hostname}:${tlsPort}` : null,
    http: uiPort ? `http://${hostname}:${uiPort}` : null,
    dev
  };
}

/** Pick the single best URL (HTTPS > HTTP > null) — for tile-style single-click launch. */
export function getPrimaryLaunchUrl(app) {
  const { https, http } = getLaunchUrls(app);
  return https || http;
}
