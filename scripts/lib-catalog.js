#!/usr/bin/env node

/**
 * Print the shared-module catalog, derived on demand from module headers.
 *
 * Every module directly inside a catalog directory (`CATALOG_DIRS`) opens with
 * a comment whose first paragraph is a one-sentence summary of at most
 * `SUMMARY_MAX` characters. Longer rationale follows in the same comment, next
 * to the code it describes. Nothing is checked in: each directory's
 * `moduleSummaries.test.js` fails on a missing or over-length summary, and this
 * script prints `path — summary — exported names` for every module whose path,
 * exports or header matches all of the given terms (case-insensitive).
 *
 *   node scripts/lib-catalog.js [term ...] [--dir <catalog dir>]
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

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

const isModuleFile = (name) => /\.jsx?$/.test(name) && !/\.test\.jsx?$/.test(name);

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

/** One entry per module directly inside `dir` (repo-relative). */
export function catalogDir(dir, root = ROOT) {
  return readdirSync(join(root, dir))
    .filter(isModuleFile)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
    .map((name) => {
      const source = readFileSync(join(root, dir, name), 'utf8');
      return {
        path: `${dir}/${name}`,
        summary: moduleSummary(source),
        exports: exportedNames(source),
        header: (leadingCommentLines(source) ?? []).join(' '),
      };
    });
}

/** Modules in `dir` whose summary is missing or longer than `SUMMARY_MAX`. */
export function summaryProblems(dir, root = ROOT) {
  return catalogDir(dir, root)
    .filter(({ summary }) => !summary || summary.length > SUMMARY_MAX)
    .map(({ path, summary }) => (summary
      ? `${path}: summary is ${summary.length} chars (max ${SUMMARY_MAX}); split the first header paragraph`
      : `${path}: missing header — open the file with a one-sentence summary comment`));
}

export function searchCatalog(terms, { dirs = CATALOG_DIRS, root = ROOT } = {}) {
  const needles = terms.map((term) => term.toLowerCase());
  return dirs.flatMap((dir) => catalogDir(dir, root)).filter((entry) => {
    const haystack = `${entry.path} ${entry.exports.join(' ')} ${entry.header}`.toLowerCase();
    return needles.every((needle) => haystack.includes(needle));
  });
}

export const formatEntry = ({ path, summary, exports }) => `${path} — ${summary || '(no summary)'} — ${exports.join(', ') || '(no exports)'}`;

if (isDirectlyInvoked(import.meta.url)) {
  const args = process.argv.slice(2);
  const dirs = [];
  const terms = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') dirs.push(args[++i]?.replace(/\/+$/, ''));
    else terms.push(args[i]);
  }
  const unknown = dirs.filter((dir) => !CATALOG_DIRS.includes(dir));
  if (unknown.length) {
    console.error(`❌ Not a catalog directory: ${unknown.join(', ')} (one of ${CATALOG_DIRS.join(', ')})`);
    process.exit(2);
  }
  const matches = searchCatalog(terms, dirs.length ? { dirs } : {});
  for (const entry of matches) console.log(formatEntry(entry));
  if (!matches.length) process.exitCode = 1;
}
