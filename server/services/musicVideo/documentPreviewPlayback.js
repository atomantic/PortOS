/** A narrowly recognized, disposable preview adaptation. Never used by exports. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLayeredPreviewPlayback } from './previewPlaybackRuntime.js';

const ROOT = fileURLToPath(new URL('./documentTemplates/', import.meta.url));
const ENGINE_SHA256 = '0cc9d52c4bbf82cec93b418e41e7cfe49a89f6feb0602c02ecdee6f00f9cf307';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (directory, name) => readFile(join(directory, name));

const BRIDGE = `
  let previewBack = null;
  (${installLayeredPreviewPlayback.toString()})({
    ready, duration: DURATION, fps: FPS,
    state: eventState, scene: sceneAt, source: sourceFor,
    playback: on => globalThis.__portosFilmLook?.playback(on),
    needsSource: scene => !cardFor(scene),
    videos: () => [...videos.values()].map(entry => entry.el),
    publish(songTime, t, scene, source, state, valid) {
      if (!previewBack) previewBack = document.createElement('canvas');
      if (previewBack.width !== W) previewBack.width = W;
      if (previewBack.height !== H) previewBack.height = H;
      const front = canvas, frontContext = ctx;
      const backContext = previewBack.getContext('2d');
      // Reset clip, transform and save stack even after a failed authored draw.
      backContext.reset();
      try { canvas = previewBack; ctx = backContext; render(t, scene, source, state); }
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
    },
  });
`;

/** `directory` is the caller's already-owned staged composition copy. */
export async function adaptStagedDocumentPreview(directory, { scenes = [] } = {}) {
  const declined = (reason) => ({ adapted: false, reason });
  let original, index, template;
  try {
    [original, index, template] = await Promise.all([read(directory, 'engine.js'), read(directory, 'index.html'), read(join(ROOT, 'layered'), 'index.html')]);
  } catch { return declined('unrecognized-entrypoint'); }
  if (digest(original) !== ENGINE_SHA256) return declined('unrecognized-engine');
  // Photo selection changes within a scene; retain exact seek until the
  // cooperative image owner supports changing sources at those boundaries.
  if (scenes.some(scene => scene.photoSequence)) return declined('photo-sequence-exact-seek');
  const marker = '<script src="engine.js"></script>';
  const generatedIndex = template.toString().replace(marker, '<script src="generated.js"></script>\n' + marker);
  if (!index.equals(template) && index.toString() !== generatedIndex) return declined('custom-entrypoint');
  // General authored JavaScript is not a complete-frame publication contract.
  // Generated/custom/older engines keep deterministic exact seek unchanged.
  if (!index.equals(template)) return declined('generated-contract-not-admitted');
  // Only the host's already-staged metadata is authority for source cadence.
  // A source period >=100 ms cannot satisfy the live frame freshness bound.
  if (scenes.some(scene => scene.media?.kind === 'video'
    && (!Number.isFinite(scene.media.fps) || scene.media.fps <= 10))) return declined('unsupported-video-fps');
  // The complete executable/style helper graph must match, not only engine.js.
  const helpers = [
    ['cameraRig.js', join(ROOT, 'layered')],
    ['lyricType.js', join(ROOT, 'shared')], ['lyricType.css', join(ROOT, 'shared')],
    ['musicVideoImageEffects.js', fileURLToPath(new URL('../../lib/', import.meta.url))],
  ];
  try {
    for (const [name, root] of helpers) if (!(await read(directory, name)).equals(await read(root, name))) return declined('custom-helper');
    // Font bytes affect exact parity too; only canonical entrypoint/CSS names apply.
    const css = `${template}\n${await read(join(ROOT, 'shared'), 'lyricType.css')}`;
    for (const match of css.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
      const name = match[1];
      const root = name.includes('archivo') || name.includes('ibm-plex-mono-500') ? join(ROOT, 'shared') : join(ROOT, 'layered');
      if (!(await read(directory, name)).equals(await read(root, name))) return declined('custom-font');
    }
  } catch { return declined('missing-helper'); }
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
