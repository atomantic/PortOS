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
 *   - a bootstrap that receives the large media (scene takes, shipped video
 *     and images) as Blobs the PortOS page fetched on the user's behalf and
 *     posted in (`portos-mv:assets`), exposes them as `window.PORTOS_MV_ASSETS`
 *     (a promise of `{ 'media/…': 'blob:…' }`), maps any relative media `src`
 *     a script sets onto them, and answers `portos-mv:seek` messages.
 *
 * `assets` lists what the client should fetch and post: `{ key, url }` with
 * `url` a same-origin PortOS path.
 */

import { readFile } from 'fs/promises';
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

export const PREVIEW_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
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
  const map = new Map();
  let resolved = false;
  let resolveAssets;
  window.PORTOS_MV_PREVIEW = true;
  window.PORTOS_MV_ASSETS = new Promise((resolve) => { resolveAssets = resolve; });
  const keyOf = (value) => String(value).replace(/^\\.\\//, '').split(/[?#]/)[0];
  const relative = (value) => typeof value === 'string' && value && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('/');
  const pending = [];
  for (const Ctor of [HTMLMediaElement, HTMLImageElement, HTMLSourceElement]) {
    const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, 'src');
    if (!desc || !desc.set) continue;
    Object.defineProperty(Ctor.prototype, 'src', { configurable: true, enumerable: desc.enumerable,
      get() { return desc.get.call(this); },
      set(value) {
        if (relative(value)) {
          const url = map.get(keyOf(value));
          if (url) return desc.set.call(this, url);
          if (!resolved) { pending.push([this, desc, value]); return; }
        }
        desc.set.call(this, value);
      } });
  }
  const post = (message) => parent.postMessage(message, '*');
  const contract = () => {
    const c = globalThis.portosComposition;
    return c ? { durationSec: c.durationSec, fps: c.fps, width: c.width, height: c.height, formats: c.formats || null, layout: typeof c.layout === 'function' } : null;
  };
  let seeking = Promise.resolve();
  addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'portos-mv:assets' && !resolved) {
      for (const [key, blob] of Object.entries(message.files || {})) {
        if (blob instanceof Blob) map.set(keyOf(key), URL.createObjectURL(blob));
      }
      resolved = true;
      for (const [el, desc, value] of pending.splice(0)) desc.set.call(el, map.get(keyOf(value)) || value);
      resolveAssets(Object.fromEntries(map));
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
  const inlinedKeys = new Set();
  const dataUrl = async (rel) => {
    const file = files.get(rel);
    if (!file || file.size > INLINE_FILE_MAX || inlined + file.size > INLINE_TOTAL_MAX) return null;
    inlined += file.size;
    inlinedKeys.add(rel);
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
    html = html.split(match[0]).join(`<script${match[1]}${match[3]}>${inlineScript(await readFile(file.abs, 'utf8'))}</script>`);
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
  const head = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><script>${BOOTSTRAP}</script><script>window.PORTOS_MV = ${scriptJson(data)};</script>`;
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
    if (inlinedKeys.has(rel) || !BRIDGED.has(extname(rel).toLowerCase())) continue;
    assets.push({ key: rel, url: `/api/music-video/${encodeURIComponent(project.id)}/composition/document/file?path=${encodeURIComponent(rel)}${draft ? '&draft=1' : ''}`, bytes: file.size });
  }
  return { html, assets, width: frame.width, height: frame.height, fps: clock.fps, durationSec: clock.durationSec };
}
