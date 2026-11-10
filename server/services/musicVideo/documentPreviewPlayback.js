/** A narrowly recognized, disposable preview adaptation. Never used by exports. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLayeredPreviewPlayback } from './previewPlaybackRuntime.js';

const ROOT = fileURLToPath(new URL('./documentTemplates/', import.meta.url));
const ENGINE_SHA256 = '4ee3ae7c78bce6d9dde36a1f2336c7bfd899918f359b6a9906b619c07a0bfb1b';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (directory, name) => readFile(join(directory, name));

const BRIDGE = `
  let previewBack = null, previewHeld = null;
  const heldFits = (scene, held) => held?.scene === scene && held.canvas.width === W && held.canvas.height === H;
  (${installLayeredPreviewPlayback.toString()})({
    ready, duration: DURATION, fps: FPS,
    state: eventState, scene: sceneAt,
    source(scene, t) {
      // A live step must not wait on a cold decode: warm the next photos too.
      const sequence = scene?.photoSequence, photos = scene?.media?.photos;
      if (sequence && photos?.length && imageEffects) {
        const at = imageEffects.photoSequenceIndex(sequence, t, { fps: FPS });
        for (let ahead = 1; ahead <= Math.min(3, photos.length - 1); ahead++) loadImage(photos[(at + ahead) % photos.length].src).catch(() => {});
      }
      return sourceFor(scene, t);
    },
    sourceKey(scene, t) {
      const sequence = scene?.photoSequence;
      if (!sequence || !scene.media?.photos || !imageEffects) return null;
      return sequence.stacked
        ? imageEffects.photoSequenceLayers(sequence, t, { fps: FPS }).map(layer => layer.step).join(',')
        : String(imageEffects.photoSequenceIndex(sequence, t, { fps: FPS }));
    },
    // A wipe's held outgoing frame: the exact seek's outgoingLayer, drawn off
    // screen once per wipe instead of on the visible canvas every frame.
    async layers(scene, t) {
      const wipe = wipeAt(scene, t);
      if (!wipe) return null;
      if (heldFits(scene, previewHeld)) return previewHeld;
      const fromSource = cardFor(wipe.from) ? null : await sourceFor(wipe.from, wipe.fromT);
      const held = document.createElement('canvas');
      held.width = W; held.height = H;
      const front = canvas, frontContext = ctx;
      try {
        canvas = held; ctx = held.getContext('2d');
        drawSceneLayer(wipe.fromT, wipe.from, fromSource, eventState(wipe.fromT), sectionFunction(wipe.fromT));
      } finally { canvas = front; ctx = frontContext; }
      previewHeld = { scene, canvas: held };
      return previewHeld;
    },
    layersReady: (scene, t, layers) => !wipeAt(scene, t) || heldFits(scene, layers),
    playback: on => globalThis.__portosFilmLook?.playback(on),
    needsSource: scene => !cardFor(scene),
    videos: () => [...videos.values()].map(entry => entry.el),
    publish(songTime, t, scene, source, state, valid, layers) {
      const wipe = wipeAt(scene, t);
      // layersReady reloads such an item first; never paint the cut unwiped.
      if (wipe && !heldFits(scene, layers)) throw new Error('Preview wipe has no held frame');
      if (!previewBack) previewBack = document.createElement('canvas');
      if (previewBack.width !== W) previewBack.width = W;
      if (previewBack.height !== H) previewBack.height = H;
      const front = canvas, frontContext = ctx;
      const backContext = previewBack.getContext('2d');
      // Reset clip, transform and save stack even after a failed authored draw.
      backContext.reset();
      try { canvas = previewBack; ctx = backContext; render(t, scene, source, state, false, wipe ? { ...wipe, held: layers.canvas } : null); }
      finally { canvas = front; ctx = frontContext; }
      if (!valid()) return false;
      // Fonts and sources are already prepared. Every visible update is in this
      // synchronous task; no async work is permitted between these commits.
      globalThis.__portosFilmLook?.frame(Math.round(songTime * FPS));
      globalThis.__portosTitleCard?.draw(songTime);
      frontContext.save();
      try {
        frontContext.resetTransform(); frontContext.globalAlpha = 1;
        frontContext.globalCompositeOperation = 'copy'; frontContext.filter = 'none';
        frontContext.drawImage(previewBack, 0, 0);
      } finally { frontContext.restore(); }
      return true;
    },
    dispose() {
      for (const entry of videos.values()) { entry.el.pause(); entry.el.removeAttribute('src'); entry.el.load(); }
      videos.clear(); images.clear();
      if (previewBack) { previewBack.width = 0; previewBack.height = 0; previewBack = null; }
      previewHeld = null;
    },
  });
`;

// The shipped engine and entrypoint, or why `directory` does not hold them.
async function shippedEntrypoint(directory) {
  let original, index, template;
  try {
    [original, index, template] = await Promise.all([read(directory, 'engine.js'), read(directory, 'index.html'), read(join(ROOT, 'layered'), 'index.html')]);
  } catch { return { reason: 'unrecognized-entrypoint' }; }
  if (digest(original) !== ENGINE_SHA256) {
    // An older shipped engine plays only by exact per-frame seeks; the player offers its one-tap update.
    const { isUpgradableLayeredEngine } = await import('./compositionDocument.js');
    return { reason: 'unrecognized-engine', ...(isUpgradableLayeredEngine(original) ? { upgradable: true } : {}) };
  }
  const marker = '<script src="engine.js"></script>';
  const generatedIndex = template.toString().replace(marker, '<script src="generated.js"></script>\n' + marker);
  if (!index.equals(template) && index.toString() !== generatedIndex) return { reason: 'custom-entrypoint' };
  // General authored JavaScript is not a complete-frame publication contract.
  // Generated/custom/older engines keep deterministic exact seek unchanged.
  if (!index.equals(template)) return { reason: 'generated-contract-not-admitted' };
  return { original, template };
}

// Why the executable/style helper graph differs from the shipped one, or null.
// The whole graph must match, not only engine.js.
async function shippedHelpersMismatch(directory, template) {
  const helpers = [
    ['cameraRig.js', join(ROOT, 'layered')],
    ['lyricType.js', join(ROOT, 'shared')], ['lyricType.css', join(ROOT, 'shared')],
    ['musicVideoImageEffects.js', fileURLToPath(new URL('../../lib/', import.meta.url))],
  ];
  try {
    for (const [name, root] of helpers) if (!(await read(directory, name)).equals(await read(root, name))) return 'custom-helper';
    // Font bytes affect exact parity too; only canonical entrypoint/CSS names apply.
    const css = `${template}\n${await read(join(ROOT, 'shared'), 'lyricType.css')}`;
    for (const match of css.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
      const name = match[1];
      const root = name.includes('archivo') || name.includes('ibm-plex-mono-500') ? join(ROOT, 'shared') : join(ROOT, 'layered');
      if (!(await read(directory, name)).equals(await read(root, name))) return 'custom-font';
    }
  } catch { return 'missing-helper'; }
  return null;
}

/**
 * Whether `directory` holds the unmodified shipped layered template: current
 * engine, entrypoint, helpers and fonts, with no authored code. Such a document
 * adds nothing a page may not run, so its scenes can play in the viewer's own
 * browser. Reads only. `{ shipped: true }` or `{ shipped: false, reason, upgradable? }`.
 */
export async function shippedLayeredDocument(directory) {
  const entry = await shippedEntrypoint(directory);
  if (entry.reason) return { shipped: false, reason: entry.reason, ...(entry.upgradable ? { upgradable: true } : {}) };
  const reason = await shippedHelpersMismatch(directory, entry.template);
  return reason ? { shipped: false, reason } : { shipped: true };
}

/** `directory` is the caller's already-owned staged composition copy. */
export async function adaptStagedDocumentPreview(directory, { scenes = [] } = {}) {
  const declined = (reason) => ({ adapted: false, reason });
  const entry = await shippedEntrypoint(directory);
  if (entry.reason) return { ...declined(entry.reason), ...(entry.upgradable ? { upgradable: true } : {}) };
  const { original, template } = entry;
  // Only the host's already-staged metadata is authority for source cadence.
  // A source period >=100 ms cannot satisfy the live frame freshness bound.
  if (scenes.some(scene => scene.media?.kind === 'video'
    && (!Number.isFinite(scene.media.fps) || scene.media.fps <= 10))) return declined('unsupported-video-fps');
  const mismatch = await shippedHelpersMismatch(directory, template);
  if (mismatch) return declined(mismatch);
  let source = original.toString();
  for (const [from, to] of [
    ["  const canvas = document.getElementById('stage');", "  let canvas = document.getElementById('stage');"],
    ["  const ctx = canvas.getContext('2d');", "  let ctx = canvas.getContext('2d');"],
    ['\n})();\n', `${BRIDGE}\n})();\n`],
  ]) {
    if (source.split(from).length !== 2) return declined('bridge-site-mismatch');
    source = source.replace(from, () => to);
  }
  await writeFile(join(directory, 'engine.js'), source);
  return { adapted: true, adapterVersion: 1, originalEngineSha256: digest(original), stagedEngineSha256: digest(source),
    presentation: 'atomic-canvas-v1', mediaTiming: 'staged-output-v1', fps: 30 };
}
