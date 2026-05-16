/**
 * Build-ID derived from the built client bundle.
 *
 * Computed once at server boot from `client/dist/index.html` (the file
 * changes every Vite build because it embeds the bundle-hash filenames).
 * Used in two places:
 *
 *   - `server/index.js` — injects `<meta name="portos-build-id" content="...">`
 *     into the served index.html so the bundled JS can read its own build id.
 *   - `server/services/socket.js` — emits the current build id to every
 *     connecting socket. A client whose embedded id differs from the live
 *     server's id knows it's running stale code and can prompt to reload.
 *
 * During `npm run dev` (Vite dev server, no `client/dist`) the id falls
 * back to `'dev'` and the socket emission is a no-op match.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', '..', 'client', 'dist', 'index.html');

// Cache keyed on the index.html mtime — Vite rewrites this file every build,
// so a changed mtime means new chunk filenames inside. A pure module-level
// cache would keep serving the old stamped HTML (and reporting the old build
// id over the socket) after `npm run build`, so the browser would request
// chunk filenames that no longer exist on disk → 404 → black page.
let cached = null;

function compute() {
  if (!existsSync(INDEX_PATH)) {
    return { id: 'dev', html: null, mtimeMs: 0 };
  }
  const mtimeMs = statSync(INDEX_PATH).mtimeMs;
  const html = readFileSync(INDEX_PATH, 'utf8');
  const id = createHash('sha256').update(html).digest('hex').slice(0, 12);
  // Inject the meta tag once. Idempotent: replace if already present
  // (defensive — Vite rewrites the whole file so the marker shouldn't survive
  // a rebuild, but checking keeps the function safe to call repeatedly).
  const META = `<meta name="portos-build-id" content="${id}">`;
  const META_RE = /<meta name="portos-build-id" content="[^"]*">/;
  const stamped = META_RE.test(html)
    ? html.replace(META_RE, META)
    : html.replace('</head>', `  ${META}\n  </head>`);
  return { id, html: stamped, mtimeMs };
}

function ensureFresh() {
  if (!existsSync(INDEX_PATH)) {
    if (!cached || cached.id !== 'dev') cached = { id: 'dev', html: null, mtimeMs: 0 };
    return cached;
  }
  const mtimeMs = statSync(INDEX_PATH).mtimeMs;
  if (!cached || cached.mtimeMs !== mtimeMs) cached = compute();
  return cached;
}

export function getBuildId() {
  return ensureFresh().id;
}

export function getStampedIndexHtml() {
  return ensureFresh().html;
}
