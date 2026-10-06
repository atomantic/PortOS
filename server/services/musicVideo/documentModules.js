/** Resolve a document's local ES module graph for the opaque preview iframe. */
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { parse } from '@babel/parser';
import { ServerError } from '../../lib/errorHandler.js';

/**
 * A data: module has no usable `import.meta.url`, so bundler asset URLs built from it — Vite's
 * `new URL('photo-abc.jpg', import.meta.url)` — throw "cannot be parsed as a URL" in the preview.
 * Each inlined module instead sees a stand-in base under this reserved origin, at its own path in
 * the document; the preview bootstrap maps URLs under it back to document files (see documentPreview.js).
 */
export const PREVIEW_DOCUMENT_BASE = 'https://document.portos.invalid/';

// `import.meta.url` member expressions anywhere in the module (computed `import.meta['url']` included).
function importMetaUrlRanges(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) importMetaUrlRanges(child, out); return out; }
  if (node.type === 'MemberExpression' && node.object?.type === 'MetaProperty'
    && node.object.meta?.name === 'import' && node.object.property?.name === 'meta'
    && ((!node.computed && node.property?.name === 'url') || (node.computed && node.property?.value === 'url'))) {
    out.push({ start: node.start, end: node.end });
    return out;
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'comments' || key.endsWith('Comments')) continue;
    const child = node[key];
    if (child && typeof child === 'object') importMetaUrlRanges(child, out);
  }
  return out;
}

export async function inlineDocumentModule(entry, files, stack = new Set(), cache = new Map()) {
  if (cache.has(entry)) return cache.get(entry);
  const file = files.get(entry);
  if (!file || stack.has(entry) || stack.size >= 32) throw new ServerError('Preview modules must form an acyclic local document graph', { status: 422, code: 'COMPOSITION_MODULE_INVALID' });
  const source = file.data ? file.data.toString('utf8') : await readFile(file.abs, 'utf8');
  const ast = parse(source, { sourceType: 'module' });
  const nextStack = new Set([...stack, entry]);
  const replacements = [];
  for (const node of ast.program.body) {
    if (!node.source || !['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) continue;
    const ref = node.source.value;
    if (!ref.startsWith('./') && !ref.startsWith('../')) throw new ServerError('Package modules must use local relative imports', { status: 422, code: 'COMPOSITION_MODULE_INVALID' });
    const key = posix.normalize(posix.join(posix.dirname(entry), ref));
    const url = await inlineDocumentModule(key, files, nextStack, cache);
    replacements.push({ start: node.source.start, end: node.source.end, value: JSON.stringify(url) });
  }
  const base = JSON.stringify(`${PREVIEW_DOCUMENT_BASE}${entry}`);
  for (const range of importMetaUrlRanges(ast.program)) replacements.push({ ...range, value: base });
  const expandedSize = replacements.reduce((size, item) => size + item.value.length - (item.end - item.start), source.length);
  if (expandedSize > 24 * 1024 * 1024) throw new ServerError('The expanded module graph exceeds the preview budget', { status: 413, code: 'COMPOSITION_MODULE_TOO_LARGE' });
  let output = source;
  for (const item of replacements.sort((a, b) => b.start - a.start)) output = output.slice(0, item.start) + item.value + output.slice(item.end);
  const url = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
  cache.set(entry, url);
  return url;
}
