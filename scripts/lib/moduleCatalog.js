/** Defines module catalog directories and parses source headers and export names. */

export const CATALOG_DIRS = Object.freeze([
  'server/lib',
  'server/lib/acp',
  'server/lib/agent',
  'server/lib/catalog',
  'server/lib/cos',
  'server/lib/musicVideo',
  'server/lib/persistent',
  'server/lib/provider',
  'server/lib/schemaVersions',
  'client/src/lib',
  'client/src/hooks',
  'client/src/utils',
  'client/src/services',
]);

export const SUMMARY_MAX = 200;

// Lines that may precede the header without being it: shebangs, tool
// directives and string directives.
const DIRECTIVE_RE = /^(?:#!|\/\/\s*(?:@vitest|biome-ignore|eslint|@ts-|prettier|@jsx)|\/\*\s*(?:eslint|global|@jsx)|['"]use )/;

/** The text lines of a source file's leading comment, or null when it has none. */
export function leadingCommentLines(source) {
  const lines = source.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || DIRECTIVE_RE.test(lines[i].trim()))) i++;
  const first = lines[i]?.trim() ?? '';
  if (first.startsWith('/*')) {
    let end = i;
    while (end < lines.length && !lines[end].includes('*/')) end++;
    const body = lines.slice(i, end + 1).join('\n').replace(/^\s*\/\*+!?/, '').replace(/\*\/[\s\S]*$/, '');
    return body.split('\n').map((line) => line.replace(/^\s*\* ?/, ''));
  }
  if (first.startsWith('//')) {
    const out = [];
    for (; i < lines.length && lines[i].trim().startsWith('//'); i++) out.push(lines[i].trim().replace(/^\/\/ ?/, ''));
    return out;
  }
  return null;
}

/** The header's first paragraph, whitespace-collapsed; '' when there is none. */
export function moduleSummary(source) {
  const text = leadingCommentLines(source);
  if (!text) return '';
  let i = 0;
  while (i < text.length && !text[i].trim()) i++;
  const para = [];
  for (; i < text.length && text[i].trim() && !/^@\w/.test(text[i].trim()); i++) para.push(text[i].trim());
  return para.join(' ').replace(/\s+/g, ' ').trim();
}

/** Top-level names a module exports, in source order. */
export function exportedNames(source) {
  const names = [];
  const add = (name) => { if (name && !names.includes(name)) names.push(name); };
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) add(m[1]);
  if (/^export\s+default\b/m.test(source)) add('default');
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) add(part.trim().split(/\s+as\s+/).pop()?.trim());
  }
  for (const m of source.matchAll(/^export\s+\*\s+as\s+([A-Za-z0-9_$]+)/gm)) add(m[1]);
  for (const m of source.matchAll(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/gm)) add(`* from ${m[1]}`);
  return names;
}
