/** A narrowly recognized, disposable preview adaptation. Never used by exports. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLayeredPreviewPlayback } from './previewPlaybackRuntime.js';

const ROOT = fileURLToPath(new URL('./documentTemplates/', import.meta.url));
const ENGINE_SHA256 = 'ecf110208a0861eb35a39ca559997eca647b922b49c1ca5d5bddc35b2f37bd61';
// This graph retains its older lyrics and intentionally has no image-effects module.
const HISTORICAL_GRAPH = {
  'engine.js': '9581bb2d190e62ea2eb6a709bc989b1f913c501236554cd0301379877dc8a5fc',
  'index.html': 'a5a384bf17ad9858bfe5ce0c960fd5c194ebfbf581d8f4994694df48bec09936',
  'cameraRig.js': '508b9bbad6490903f53c0928fb24a62812caf17800ded5c7248bf7b7740b95a2',
  'lyricType.js': 'f2f2cc5094a6407226b5f5d62c6788ccc7220a8e13ad6b81415422d3efa3f961',
  'lyricType.css': 'b48f2ac170e4c53cda88dc44d78a03e5862bc67e04b0244602e1a39098c0054c',
  'fonts/big-shoulders-stencil-display-900.woff2': 'd071c3ae576a9d0e149af9f8dea74a5cee7a403b53d543b2f4d984cd65ebcb8b',
  'fonts/ibm-plex-mono-400.woff2': '08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7',
  'fonts/ibm-plex-mono-600.woff2': '0d1f0b8d0722224e32e9f28261bdc86c79115be73444ae5eceb73976a1bcdf83',
  'fonts/ibm-plex-sans-condensed-500.woff2': 'e3b4fd97fd20bc70fda66d8d5f0745d8d6958068a024cb4724bbc1ffb6cbc183',
  'fonts/ibm-plex-sans-condensed-700.woff2': '4768878c107d92c528a65bba206a87cdcf2c694514e75907fb91772cf8a388a5',
  'fonts/archivo-variable.woff2': 'e3a28eade21a900c7155a247757f4b2834c07bb7ef07ad7efa55cebaac1e8f5e',
  'fonts/ibm-plex-mono-500.woff2': '01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22',
};
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
  const historical = digest(original) === HISTORICAL_GRAPH['engine.js'];
  if (!historical && digest(original) !== ENGINE_SHA256) return declined('unrecognized-engine');
  const marker = '<script src="engine.js"></script>';
  const generatedIndex = template.toString().replace(marker, '<script src="generated.js"></script>\n' + marker);
  if (historical) {
    if (digest(index) !== HISTORICAL_GRAPH['index.html']) return declined('custom-entrypoint');
  } else {
    if (!index.equals(template) && index.toString() !== generatedIndex) return declined('custom-entrypoint');
    if (!index.equals(template)) return declined('generated-contract-not-admitted');
  }
  // Only the host's already-staged metadata is authority for source cadence.
  // A source period >=100 ms cannot satisfy the live frame freshness bound.
  if (scenes.some(scene => scene.media?.kind === 'video'
    && (!Number.isFinite(scene.media.fps) || scene.media.fps <= 10))) return declined('unsupported-video-fps');
  try {
    if (historical) {
      for (const [name, expected] of Object.entries(HISTORICAL_GRAPH)) {
        const bytes = name === 'engine.js' ? original : name === 'index.html' ? index : await read(directory, name);
        if (digest(bytes) !== expected) return declined(name.startsWith('fonts/') ? 'custom-font' : 'custom-helper');
      }
    } else {
      const helpers = [
        ['cameraRig.js', join(ROOT, 'layered')],
        ['lyricType.js', join(ROOT, 'shared')], ['lyricType.css', join(ROOT, 'shared')],
        ['musicVideoImageEffects.js', fileURLToPath(new URL('../../lib/', import.meta.url))],
      ];
      for (const [name, root] of helpers) if (!(await read(directory, name)).equals(await read(root, name))) return declined('custom-helper');
      const css = `${template}\n${await read(join(ROOT, 'shared'), 'lyricType.css')}`;
      for (const match of css.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
        const name = match[1];
        const root = name.includes('archivo') || name.includes('ibm-plex-mono-500') ? join(ROOT, 'shared') : join(ROOT, 'layered');
        if (!(await read(directory, name)).equals(await read(root, name))) return declined('custom-font');
      }
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
