/**
 * The three.js renderer's vendored dependency set (#10464).
 *
 * A Code Animation that chooses the `three` renderer imports `three` and a small
 * allowlist of `three/addons/*` modules. The host never lets the page reach a
 * CDN: it copies these files next to the staged HTML under `vendor/`, hashes
 * them (`dependencies.json`, the same shape music-video documents record) and
 * points an import map at them. The render containment serves only files inside
 * the staged directory, so nothing outside this allowlist can be imported.
 */

import { createHash } from 'crypto';
import { createRequire } from 'module';
import { readFile } from 'fs/promises';
import { dirname, join, posix } from 'path';

// Addon modules (under three/examples/jsm) a film may import. Every relative
// import inside them must itself be listed — readThreeVendor() enforces it.
export const THREE_ADDON_ALLOWLIST = Object.freeze([
  'environments/RoomEnvironment.js',
  'geometries/RoundedBoxGeometry.js',
  'postprocessing/BokehPass.js',
  'postprocessing/EffectComposer.js',
  'postprocessing/MaskPass.js',
  'postprocessing/OutputPass.js',
  'postprocessing/Pass.js',
  'postprocessing/RenderPass.js',
  'postprocessing/ShaderPass.js',
  'postprocessing/UnrealBloomPass.js',
  'shaders/BokehShader.js',
  'shaders/CopyShader.js',
  'shaders/LuminosityHighPassShader.js',
  'shaders/OutputShader.js',
  'utils/BufferGeometryUtils.js',
]);

export const THREE_VENDOR_DIRECTORY = 'vendor';
export const THREE_IMPORT_MAP = Object.freeze({
  imports: Object.freeze({
    three: `./${THREE_VENDOR_DIRECTORY}/three.module.js`,
    'three/addons/': `./${THREE_VENDOR_DIRECTORY}/addons/`,
  }),
});

const CORE_FILES = Object.freeze(['three.module.js', 'three.core.js']);
const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"\n;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|(?:^|\n)\s*import\s*['"](\.{1,2}\/[^'"]+)['"]/g;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The relative specifiers a vendored module imports, resolved against its own path. */
function relativeImportsOf(path, text) {
  const found = [];
  for (const match of text.matchAll(RELATIVE_IMPORT)) {
    found.push(posix.normalize(posix.join(posix.dirname(path), match[1] || match[2])));
  }
  return found;
}

let cached = null;

/**
 * Read the vendored files from the installed `three` package. Paths are relative
 * to the vendor directory: `three.module.js`, `three.core.js`, `LICENSE`, and
 * `addons/<group>/<Name>.js`. The result is process-cached; the package is fixed
 * for the life of the server.
 */
export function readThreeVendor() {
  cached ??= loadThreeVendor().catch((error) => {
    cached = null;
    throw error;
  });
  return cached;
}

async function loadThreeVendor() {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(dirname(require.resolve('three')));
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const sources = [
    ...CORE_FILES.map((name) => ({ path: name, from: join(packageRoot, 'build', name) })),
    { path: 'LICENSE', from: join(packageRoot, 'LICENSE') },
    ...THREE_ADDON_ALLOWLIST.map((name) => ({ path: `addons/${name}`, from: join(packageRoot, 'examples', 'jsm', name) })),
  ];
  const files = await Promise.all(sources.map(async ({ path, from }) => {
    const data = await readFile(from);
    return { path, data, sha256: sha256(data) };
  }));
  const known = new Set(files.map((file) => file.path));
  for (const file of files.filter((entry) => entry.path.endsWith('.js'))) {
    for (const target of relativeImportsOf(file.path, file.data.toString('utf8'))) {
      if (!known.has(target)) throw new Error(`Vendored three module ${file.path} imports ${target}, which is not on the allowlist`);
    }
  }
  return { version: pkg.version, files };
}

/**
 * The files a staged directory needs next to its index.html: the vendored
 * modules under `vendor/` plus `dependencies.json` recording each one's hash.
 * @returns {Promise<{ rel: string, data: Buffer }[]>}
 */
export async function threeStagedFiles() {
  const { version, files } = await readThreeVendor();
  const staged = files.map(({ path, data }) => ({ rel: `${THREE_VENDOR_DIRECTORY}/${path}`, data }));
  const manifest = {
    packages: [{ name: 'three', version, files: files.map(({ path, sha256: hash }) => ({ path: `${THREE_VENDOR_DIRECTORY}/${path}`, sha256: hash })) }],
    network: false,
  };
  staged.push({ rel: 'dependencies.json', data: Buffer.from(JSON.stringify(manifest)) });
  return staged;
}

const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
const IMPORT_MAP_TAG = /<script\b[^>]*type\s*=\s*["']?importmap["']?[^>]*>[\s\S]*?<\/script>/gi;
const BARE_THREE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]three(?:\/[^'"]*)?['"]/;

/** True when the page's script imports `three` (or one of its addons) by bare name. */
export function importsThree(html) {
  return BARE_THREE_IMPORT.test(String(html || ''));
}

/**
 * Replace any import map the page carries with the host's, inserted as the first
 * element of <head> (an import map only applies to modules loaded after it). The
 * model is told not to write one; the host's is authoritative either way.
 */
export function injectThreeImportMap(html) {
  const stripped = String(html).replace(IMPORT_MAP_TAG, '');
  const tag = `<script type="importmap">${scriptJson(THREE_IMPORT_MAP)}</script>`;
  const head = stripped.match(/<head[^>]*>/i);
  if (!head) return `${tag}${stripped}`;
  const at = head.index + head[0].length;
  return `${stripped.slice(0, at)}${tag}${stripped.slice(at)}`;
}
