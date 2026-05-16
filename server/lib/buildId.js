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

import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', '..', 'client', 'dist', 'index.html');

let cached = null;

function compute() {
  if (!existsSync(INDEX_PATH)) {
    return { id: 'dev', html: null };
  }
  const html = readFileSync(INDEX_PATH, 'utf8');
  const id = createHash('sha256').update(html).digest('hex').slice(0, 12);
  // Inject the meta tag once at boot. Idempotent: if a previous boot already
  // injected (unlikely — Vite rewrites index.html on every build), regex
  // replace instead of double-inserting.
  const META = `<meta name="portos-build-id" content="${id}">`;
  const META_RE = /<meta name="portos-build-id" content="[^"]*">/;
  const stamped = META_RE.test(html)
    ? html.replace(META_RE, META)
    : html.replace('</head>', `  ${META}\n  </head>`);
  return { id, html: stamped };
}

export function getBuildId() {
  if (!cached) cached = compute();
  return cached.id;
}

export function getStampedIndexHtml() {
  if (!cached) cached = compute();
  return cached.html;
}
