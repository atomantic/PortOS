// Service-worker registration: an offline-capable app shell and low-bandwidth asset caching (`client/public/sw.js`, served at `/sw.js` so its scope is `/`).
//
// `registerServiceWorker()` registers only in a production secure context (HTTPS or localhost), no-ops over plain-HTTP Tailnet (`navigator.serviceWorker` only exists in a secure context; `npm run setup:cert` flips the app to HTTPS and the worker activates) and tears down any stale SW in dev;
// `unregisterServiceWorkers()` is the teardown. Called once from `main.jsx`; side-effect-free at import time so tests stay inert. A progressive enhancement: the app is fully functional without it.

const SW_URL = '/sw.js';

// True only under the Vite dev server, where a caching SW would fight hot-module reload. `import.meta.hot` is the HMR handle the dev server injects (a production build replaces it with `undefined`). NOT gated on `import.meta.env.PROD`: Vite derives that from
// `NODE_ENV`, so a build shell exporting `NODE_ENV=development` would silently disable the SW in a real production bundle.
function isDevServer() {
  return Boolean(import.meta.hot);
}

function swSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * Register the PortOS service worker in production secure contexts, and tear
 * down any previously-registered worker everywhere else (notably the dev
 * server, so a stale prod SW can't shadow `npm run dev`).
 *
 * Registration is deferred to the window `load` event so it never competes
 * with first paint for bandwidth — the whole point is a faster first load.
 * @returns {void}
 */
export function registerServiceWorker() {
  if (!swSupported()) return;

  if (isDevServer()) {
    // Dev server over a secure context: make sure no production SW is lingering
    // from a previous `npm start` on the same origin (it would shadow HMR).
    unregisterServiceWorkers();
    return;
  }

  const register = () => {
    navigator.serviceWorker.register(SW_URL).catch((err) => {
      // A registration failure is non-fatal — the app runs uncached.
      console.warn(`⚠️ Service worker registration failed: ${err?.message || err}`);
    });
  };

  // swSupported() already guaranteed a browser context (navigator.serviceWorker
  // exists only in a secure browser context), so window/document are present.
  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }
}

/**
 * Unregister every service worker for this origin. Used to disable caching in
 * dev, or as an escape hatch if the SW ever needs to be pulled.
 * @returns {Promise<void>}
 */
export async function unregisterServiceWorkers() {
  if (!swSupported() || !navigator.serviceWorker.getRegistrations) return;
  const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
  await Promise.all(registrations.map((reg) => reg.unregister().catch(() => {})));
}
