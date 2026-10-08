import { PREVIEW_DOCUMENT_BASE, inlineDocumentModule, previewDocumentPath } from './documentModules.js';
import { musicVideoMediaMode } from '../../lib/musicVideoMediaPolicy.js';
/**
 * Music Video — the in-app live preview of a composition document.
 *
 * The preview runs in an opaque-origin `<iframe sandbox="allow-scripts"
 * srcdoc>` that can reach nothing on the network (its CSP allows only inline
 * code and data:/blob: assets), so it can never call PortOS with the user's
 * session. The server therefore hands the client ONE self-contained page:
 *
 *   - the document's own scripts and stylesheets inlined, and every file its
 *     CSS or `<img>` tags name inlined as a data: URL;
 *   - `window.PORTOS_MV` built exactly as a render builds it (portos-mv.js);
 *   - a bootstrap that bridges the large media (scene takes, shipped video and
 *     images) on demand: the PortOS page posts the manifest of keys
 *     (`portos-mv:manifest`, resolving `window.PORTOS_MV_ASSETS` to
 *     `{ 'media/…': 'media/…' }`); the first relative media `src` naming a key
 *     asks the page for that one file (`portos-mv:request` →
 *     `portos-mv:asset` with a Blob the page fetched on the user's behalf) and
 *     then points at its blob: URL. Past PREVIEW_MEDIA_BUDGET_BYTES, URLs idle
 *     for a few seconds and no longer playing in a media element are revoked.
 *     It also answers `portos-mv:seek` messages.
 *
 * `assets` lists what the client may fetch when asked: `{ key, url }` with
 * `url` a same-origin PortOS path. The page never fetches an unlisted key.
 */

import { readFile } from 'fs/promises';
import { narrativeFrameState } from '../../lib/musicVideoNarrativeEvents.js';
import { extname } from 'path';
import { loadHistory } from '../videoGen/history.js';
import { readDocumentFiles, documentMimeType } from './compositionDocument.js';
import {
  buildDocumentData, documentRenderClock, documentSongDuration, resolveSceneMedia,
  DOCUMENT_FRAME_SIZES, documentAspect,
} from './documentRender.js';

// Inline (data: URL) budget for files referenced from HTML/CSS: fonts, small images.
const INLINE_FILE_MAX = 4 * 1024 * 1024;
const INLINE_TOTAL_MAX = 24 * 1024 * 1024;
const BRIDGED = new Set(['.mp4', '.mov', '.webm', '.mp3', '.wav', '.png', '.jpg', '.jpeg', '.webp', '.gif']);
// Blob bytes the preview keeps object URLs for before revoking idle ones (a phone tab's memory is the limit).
export const PREVIEW_MEDIA_BUDGET_BYTES = 64 * 1024 * 1024;
const PREVIEW_MEDIA_IDLE_MS = 5000;

export const PREVIEW_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline' data:", "style-src 'unsafe-inline'",
  'img-src data: blob:', 'media-src data: blob:', 'font-src data: blob:',
  "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'",
  "frame-src 'none'", "worker-src 'none'", "manifest-src 'none'",
].join('; ');

const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
// A script body can hold anything except its own closing tag.
const inlineScript = (source) => source.replace(/<\/(script)/gi, '<\\/$1');
const cleanRef = (ref) => {
  const value = String(ref || '').trim().replace(/^['"]|['"]$/g, '').replace(/^\.\//, '').split(/[?#]/)[0];
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/') || value.startsWith('//')) return null;
  try { return decodeURIComponent(value); } catch { return value; }
};

// Runs before any document script: asset bridge, relative-src mapping, seek/layout messages.
const BOOTSTRAP = `(() => {
  // CSP does not block ICE/STUN. Match the render host before document code runs.
  for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker', 'WebSocket']) {
    Object.defineProperty(globalThis, key, { configurable: false, writable: false,
      value: function() { throw new Error(key + ' is disabled in compositions'); } });
  }
  // Media arrives on demand: the parent posts a manifest of bridged keys, and the first relative src
  // naming one asks the parent for that file alone, so a phone never holds every take and atlas at once.
  const map = new Map(); // key → { url, size, used, media: Set<WeakRef> } for files received
  const waiting = new Map(); // key → callbacks awaiting the parent's answer
  const assigned = new WeakMap(); // element → token of its latest src assignment (a stale answer must not win)
  let keys = null; // the manifest; null until the parent posts it
  let resolveAssets;
  window.PORTOS_MV_PREVIEW = true;
  window.PORTOS_MV_ASSETS = new Promise((resolve) => { resolveAssets = resolve; });
  // Bundler asset URLs resolved against an inlined module's stand-in import.meta.url (documentModules.js)
  // land under this origin; they name document files just like a relative src does.
  const DOC_BASE = ${JSON.stringify(PREVIEW_DOCUMENT_BASE)};
  const local = (value) => (${previewDocumentPath.toString()})(value, DOC_BASE);
  // A stand-in-base URL is already a decoded document path (a literal ? or # in it is part of the name);
  // anything else is a relative src whose query and hash are not.
  const keyOf = (value) => { const path = local(value); return path !== value ? String(path) : String(value).replace(/^\\.\\//, '').split(/[?#]/)[0]; };
  const relative = (value) => { value = local(value); return typeof value === 'string' && value && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('/'); };
  const post = (message) => parent.postMessage(message, '*');
  // Received files past this many bytes are revoked once idle and no media element still plays them;
  // a later src asks the parent again (its own bounded cache usually answers without a refetch).
  const BUDGET_BYTES = ${PREVIEW_MEDIA_BUDGET_BYTES};
  const IDLE_MS = ${PREVIEW_MEDIA_IDLE_MS};
  const inUse = (entry) => {
    for (const ref of entry.media) {
      const el = ref.deref();
      if (el && (el.getAttribute('src') === entry.url || el.currentSrc === entry.url)) return true;
      entry.media.delete(ref);
    }
    return false;
  };
  const sweep = () => {
    let total = 0;
    for (const entry of map.values()) total += entry.size;
    const now = performance.now();
    for (const [key, entry] of [...map].sort((a, b) => a[1].used - b[1].used)) {
      if (total <= BUDGET_BYTES) return;
      if (now - entry.used < IDLE_MS || inUse(entry)) continue;
      URL.revokeObjectURL(entry.url);
      map.delete(key);
      total -= entry.size;
    }
  };
  // Calls back with the file's entry (null when the parent has none), asking the parent at most once at a time.
  const request = (key, callback) => {
    const entry = map.get(key);
    if (entry) { entry.used = performance.now(); return callback(entry); }
    if (!waiting.has(key)) { waiting.set(key, []); post({ type: 'portos-mv:request', key }); }
    waiting.get(key).push(callback);
  };
  const apply = (el, desc, value, token) => {
    const key = keyOf(value);
    if (!keys.has(key)) return desc.set.call(el, value);
    request(key, (entry) => {
      if (assigned.get(el) !== token) return;
      if (!entry) return desc.set.call(el, value);
      if (el instanceof HTMLMediaElement || el instanceof HTMLSourceElement) entry.media.add(new WeakRef(el));
      desc.set.call(el, entry.url);
    });
  };
  // A promise of a bridged file's blob: URL (null when unavailable), for uses other than a media src.
  // An idle URL can be revoked later, so ask again for each new use.
  window.PORTOS_MV_ASSET = (value) => window.PORTOS_MV_ASSETS.then(() => new Promise((resolve) => {
    const key = keyOf(value);
    if (!keys.has(key)) return resolve(null);
    request(key, (entry) => resolve(entry ? entry.url : null));
  }));
  const pending = [];
  for (const Ctor of [HTMLMediaElement, HTMLImageElement, HTMLSourceElement]) {
    const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, 'src');
    if (!desc || !desc.set) continue;
    Object.defineProperty(Ctor.prototype, 'src', { configurable: true, enumerable: desc.enumerable,
      get() { return desc.get.call(this); },
      set(value) {
        const token = {};
        assigned.set(this, token);
        if (!relative(value)) return desc.set.call(this, value);
        if (!keys) { pending.push([this, desc, value, token]); return; }
        apply(this, desc, value, token);
      } });
  }
  const contract = () => {
    const c = globalThis.portosComposition;
    return c ? { durationSec: c.durationSec, fps: c.fps, width: c.width, height: c.height, formats: c.formats || null, layout: typeof c.layout === 'function' } : null;
  };
  let seeking = Promise.resolve();
  addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'portos-mv:manifest' && !keys) {
      keys = new Set((Array.isArray(message.keys) ? message.keys : []).map((key) => String(key).replace(/^\\.\\//, '')));
      for (const [el, desc, value, token] of pending.splice(0)) if (assigned.get(el) === token) apply(el, desc, value, token);
      resolveAssets(Object.freeze(Object.fromEntries([...keys].map((key) => [key, key]))));
    } else if (message.type === 'portos-mv:asset' && waiting.has(String(message.key))) {
      const key = String(message.key);
      const callbacks = waiting.get(key);
      waiting.delete(key);
      if (message.blob instanceof Blob) map.set(key, { url: URL.createObjectURL(message.blob), size: message.blob.size, used: performance.now(), media: new Set() });
      const entry = map.get(key) || null;
      for (const callback of callbacks) callback(entry);
      sweep();
    } else if (message.type === 'portos-mv:seek') {
      const t = Number(message.t) || 0;
      seeking = seeking.then(() => globalThis.portosComposition?.seek(t)).then(
        () => post({ type: 'portos-mv:seeked', t }),
        (error) => post({ type: 'portos-mv:error', message: String(error && error.message || error) }),
      );
    }
  });
  addEventListener('error', (event) => post({ type: 'portos-mv:error', message: String(event.message || 'Script error') }));
  addEventListener('load', () => {
    const c = contract();
    const want = window.PORTOS_MV && window.PORTOS_MV.render;
    if (c && want && c.layout && (c.width !== want.width || c.height !== want.height)) {
      try { globalThis.portosComposition.layout({ width: want.width, height: want.height }); } catch (error) { post({ type: 'portos-mv:error', message: String(error.message || error) }); }
    }
    post({ type: 'portos-mv:loaded', contract: c });
  });
})();`;

/**
 * The preview page and the assets to post into it:
 * `{ html, assets: [{ key, url, bytes }], width, height, fps, durationSec }`.
 */
export async function buildDocumentPreview(project, { draft = false } = {}) {
  const files = await readDocumentFiles(project);
  const songDurationSec = documentSongDuration(project) || 0;
  const clock = documentRenderClock(songDurationSec);
  const frame = DOCUMENT_FRAME_SIZES[documentAspect(project)];
  const history = (project.scenes || []).some((s) => s?.videoHistoryId) ? await loadHistory() : [];
  const media = await resolveSceneMedia(project, { history, strictLayers: project.composition?.document?.source?.kind === 'generated' });
  const data = buildDocumentData(project, { media, frame, clock, songDurationSec,
    generated: project.composition?.document?.source?.kind === 'generated' });

  let inlined = 0;
  const dataUrl = async (rel) => {
    const file = files.get(rel);
    if (!file || file.size > INLINE_FILE_MAX || inlined + file.size > INLINE_TOTAL_MAX) return null;
    inlined += file.size;
    return `data:${documentMimeType(rel)};base64,${(await readFile(file.abs)).toString('base64')}`;
  };
  const rewriteCss = async (css) => {
    const refs = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)];
    let out = css;
    for (const match of refs) {
      const rel = cleanRef(match[2]);
      const url = rel ? await dataUrl(rel) : null;
      if (url) out = out.split(match[0]).join(`url("${url}")`);
    }
    return out;
  };

  let html = await readFile(files.get('index.html').abs, 'utf8');
  // <link rel=stylesheet href=…> → <style>
  for (const match of [...html.matchAll(/<link\b[^>]*>/gi)]) {
    const tag = match[0];
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const rel = cleanRef(/href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(tag)?.[1]);
    const file = rel && files.get(rel);
    if (!file) continue;
    html = html.split(tag).join(`<style>${await rewriteCss(await readFile(file.abs, 'utf8'))}</style>`);
  }
  // <script src=…></script> → inline; portos-mv.js becomes the preview data.
  for (const match of [...html.matchAll(/<script\b([^>]*)\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)([^>]*)>\s*<\/script>/gi)]) {
    const rel = cleanRef(match[2]);
    if (!rel) continue;
    if (rel === 'portos-mv.js') { html = html.split(match[0]).join(''); continue; }
    const file = files.get(rel);
    if (!file) continue;
    const isModule = /type\s*=\s*['"]module['"]/i.test(match[1] + match[3]);
    html = html.split(match[0]).join(isModule
      ? `<script type="module">import ${JSON.stringify(await inlineDocumentModule(rel, files))};</script>`
      : `<script${match[1]}${match[3]}>${inlineScript(await readFile(file.abs, 'utf8'))}</script>`);
  }
  // Inline entry modules need the same local graph resolution as src modules.
  for (const [index, match] of [...html.matchAll(/<script\b[^>]*type\s*=\s*['"]module['"][^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
    if (/^import "data:text\/javascript;base64,/.test(match[1])) continue;
    const entry = `__inline-${index}.js`;
    const graph = new Map(files); graph.set(entry, { data: Buffer.from(match[1]) });
    const url = await inlineDocumentModule(entry, graph);
    html = html.split(match[0]).join(`<script type="module">import ${JSON.stringify(url)};</script>`);
  }
  // Inline <style> blocks and style="" attributes, then <img src>.
  for (const match of [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]) {
    const next = await rewriteCss(match[1]);
    if (next !== match[1]) html = html.split(match[0]).join(match[0].replace(match[1], () => next));
  }
  for (const match of [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*("[^"]*"|'[^']*')/gi)]) {
    const rel = cleanRef(match[1]);
    const url = rel ? await dataUrl(rel) : null;
    if (url) html = html.split(match[0]).join(match[0].replace(match[1], () => `"${url}"`));
  }
  const mode = musicVideoMediaMode(project);
  const csp = PREVIEW_CSP.replace('img-src data: blob:', mode === 'code-only' ? "img-src 'none'" : 'img-src data: blob:').replace('media-src data: blob:', mode !== 'code-images-video' ? "media-src 'none'" : 'media-src data: blob:');
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}"><script>${BOOTSTRAP}</script><script>window.PORTOS_MV = ${scriptJson(data)};window.PORTOS_MV_EVENT_STATE = ${narrativeFrameState.toString()};</script>`;
  const at = html.match(/<head[^>]*>/i);
  html = at ? `${html.slice(0, at.index + at[0].length)}${head}${html.slice(at.index + at[0].length)}` : `${head}${html}`;

  const assets = [];
  for (const scene of data.scenes) {
    const m = scene.media && media.get(scene.sceneId);
    if (!m) continue;
    const name = m.path.split(/[\\/]/).pop();
    assets.push({ key: scene.media.src, url: `/data/${m.kind === 'video' ? 'videos' : 'images'}/${encodeURIComponent(name)}`, bytes: null });
  }
  for (const [rel, file] of files) {
    // Media is posted even when CSS or an <img> tag already inlined it as data:, because document code
    // can also reach the same file through a relative src or a bundler URL (new URL(…, import.meta.url)).
    if (!BRIDGED.has(extname(rel).toLowerCase())) continue;
    assets.push({ key: rel, url: `/api/music-video/${encodeURIComponent(project.id)}/composition/document/file?path=${encodeURIComponent(rel)}${draft ? '&draft=1' : ''}`, bytes: file.size });
  }
  return { html, assets, width: frame.width, height: frame.height, fps: clock.fps, durationSec: clock.durationSec };
}
