/**
 * The host page a code shot or code layer renders in. The module is the film's
 * own ES module (`render(ctx, env)`); this page only calls it and reads the
 * pixels back. Screenshots are not used: the same song time must produce the
 * same bytes, and a screenshot does not. The page has no network URL.
 */

const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const PAGE_SCRIPT = `
const specSong = SONG;
const space = SPACE;
const entry = ENTRY;
const canvas = document.getElementById('portos-film');
const context2d = space === 'canvas' ? canvas.getContext('2d', { alpha: true, willReadFrequently: true }) : null;
let THREE = null;
let webgl = null;
function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}
try {
  const mod = await import(entry);
  if (typeof mod.render !== 'function') throw new Error('The code module must export render(ctx, env)');
  if (space === 'three') THREE = await import('three');
  const render = mod.render;
  globalThis.portosFilm.frame = async (spec) => {
    const env = { t: spec.t, localT: spec.localT, frame: spec.frame, song: specSong, width: spec.width, height: spec.height };
    if (space === 'canvas') {
      // Assigning the size, even unchanged, clears the bitmap and the 2D state.
      // A clip or transform from an earlier frame must not change this one.
      canvas.width = spec.width;
      canvas.height = spec.height;
    } else if (canvas.width !== spec.width || canvas.height !== spec.height) {
      canvas.width = spec.width;
      canvas.height = spec.height;
    }
    if (space === 'three') {
      if (!webgl) {
        webgl = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, preserveDrawingBuffer: true });
        webgl.setPixelRatio(1);
      }
      webgl.setSize(spec.width, spec.height, false);
      webgl.setClearColor(0x000000, spec.alpha ? 0 : 1);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(50, spec.width / Math.max(1, spec.height), 0.1, 1000);
      camera.position.z = 5;
      await render({ THREE, scene, camera, renderer: webgl }, env);
      webgl.render(scene, camera);
      const gl = webgl.getContext();
      const pixels = new Uint8Array(spec.width * spec.height * 4);
      gl.readPixels(0, 0, spec.width, spec.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const row = spec.width * 4;
      const flipped = new Uint8Array(pixels.length);
      for (let y = 0; y < spec.height; y += 1) flipped.set(pixels.subarray((spec.height - 1 - y) * row, (spec.height - y) * row), y * row);
      return toBase64(flipped);
    }
    context2d.setTransform(1, 0, 0, 1, 0, 0);
    context2d.clearRect(0, 0, spec.width, spec.height);
    await render(context2d, env);
    return toBase64(context2d.getImageData(0, 0, spec.width, spec.height).data);
  };
  globalThis.portosFilm.ready = true;
} catch (error) {
  globalThis.portosFilm.error = error && error.stack ? String(error.stack) : String(error);
}
`;

/** HTML for one code module. `three` vendors three.js and builds a fresh scene per frame. */
export function filmCodePage({ entry, space = 'canvas', song, width, height, three = false }) {
  const threeSpace = space === 'three';
  const importMap = three || threeSpace
    ? `<script type="importmap">${scriptJson({ imports: { three: './vendor/three.module.js', 'three/addons/': './vendor/addons/' } })}</script>`
    : '';
  const script = PAGE_SCRIPT
    .replace('const specSong = SONG;', `const specSong = ${scriptJson(song ?? null)};`)
    .replace('const space = SPACE;', `const space = ${scriptJson(threeSpace ? 'three' : 'canvas')};`)
    .replace('const entry = ENTRY;', `const entry = ${scriptJson(`./${entry}`)};`);
  const w = Number(width);
  const h = Number(height);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${importMap}</head><body>`
    + `<canvas id="portos-film" width="${w}" height="${h}"></canvas>`
    + '<script>globalThis.portosFilm={ready:false,error:null};</script>'
    + `<script type="module">${script}</script></body></html>`;
}
