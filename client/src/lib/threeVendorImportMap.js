// Inlines the vendored three.js modules (GET /api/code-animation/vendor/three)
// into a Code Animation page so the sandboxed preview can import them. The
// preview iframe has an opaque origin and a CSP with no network, so it cannot
// load ./vendor/*.js; data: URLs in an import map can. Relative imports inside
// the vendored files are rewritten to bare ids the same map resolves.
// importsThree mirrors server/services/codeAnimation/threeVendor.js.

const BARE_THREE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]three(?:\/[^'"]*)?['"]/;
const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;
const ADDON_PREFIX = 'addons/';
const VENDOR_ID_PREFIX = 'three-vendor/';
const IMPORT_MAP_TAG = /<script\b[^>]*type\s*=\s*["']?importmap["']?[^>]*>[\s\S]*?<\/script>/gi;

/** True when the page's script imports `three` (or one of its addons) by bare name. */
export const importsThree = (html) => BARE_THREE_IMPORT.test(String(html || ''));

const dataUrl = (text) => `data:text/javascript;charset=utf-8,${encodeURIComponent(text)}`;

function normalizePath(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

function rewriteRelativeImports(path, text) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return text.replace(RELATIVE_SPECIFIER, (_match, lead, quote, specifier) =>
    `${lead}${quote}${VENDOR_ID_PREFIX}${normalizePath(dir ? `${dir}/${specifier}` : specifier)}${quote}`);
}

/**
 * The import map for a vendor bundle `[{ path, text }]`: `three`, every
 * `three/addons/<name>` the model may import, and the `three-vendor/<path>` ids
 * the vendored files use between themselves.
 */
export function buildThreeImportMap(files) {
  const imports = {};
  for (const { path, text } of files) {
    const url = dataUrl(rewriteRelativeImports(path, text));
    imports[`${VENDOR_ID_PREFIX}${path}`] = url;
    if (path === 'three.module.js') imports.three = url;
    if (path.startsWith(ADDON_PREFIX)) imports[`three/${path}`] = url;
  }
  return { imports };
}

// `<` is escaped so no module text can close the script element early.
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

/** The page with any import map it carries replaced by one that inlines `files`. */
export function inlineThreeVendor(html, files) {
  const stripped = String(html).replace(IMPORT_MAP_TAG, '');
  const tag = `<script type="importmap">${scriptJson(buildThreeImportMap(files))}</script>`;
  const head = stripped.match(/<head[^>]*>/i);
  if (!head) return `${tag}${stripped}`;
  const at = head.index + head[0].length;
  return `${stripped.slice(0, at)}${tag}${stripped.slice(at)}`;
}
