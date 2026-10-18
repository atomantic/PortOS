#!/usr/bin/env node

/**
 * Fail a pull request whose relative imports spell a path in a case that
 * differs from the tracked file.
 *
 * macOS (APFS) and Windows (NTFS) resolve `./Foo.js` to a tracked `foo.js`;
 * Linux does not. A pregate run on macOS therefore cannot see this one class
 * of Linux-only failure, and the pregate attestation lets such a run stand in
 * for the Linux test jobs — so the impact job, which always runs, checks it
 * here instead (docs/GITHUB_ACTIONS.md "Pregate attestation").
 *
 * For every changed JavaScript module (or every tracked one, when no base is
 * known), each relative specifier — static `import`/`export … from`, a literal
 * dynamic `import('./x')`, and `new URL('./x', import.meta.url)` — is resolved
 * against `git ls-files` with exact spelling, trying the usual extension and
 * index completions. A specifier that matches a tracked path only
 * case-insensitively is a mismatch; one that matches nothing at all is left
 * to the module loader (an alias, a generated file, a package path).
 *
 *   node scripts/check-import-case.js [--base <sha>]   # default: $CI_BASE_SHA
 *
 * ZERO external dependencies — this runs before `npm ci` in the impact job.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticImportSpecifiersFromSource } from '../server/lib/staticImportGraph.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const MODULE_RE = /\.(?:[cm]?jsx?|tsx?)$/i;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const NEW_URL_RE = /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
const COMPLETIONS = ['', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '/index.js', '/index.jsx', '/index.ts', '/index.tsx'];

/** Every relative specifier in a module's source, in source order. */
export function relativeSpecifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found = [...staticImportSpecifiersFromSource(code)];
  for (const re of [DYNAMIC_IMPORT_RE, NEW_URL_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(code)) !== null) found.push(match[1]);
  }
  return found.filter((specifier) => specifier.startsWith('./') || specifier.startsWith('../'))
    .map((specifier) => specifier.split(/[?#]/)[0]);
}

/**
 * Case mismatches between a file's relative specifiers and the tracked tree.
 *
 * @param {string} file - repo-relative path of the importing module
 * @param {string} source - its text
 * @param {Set<string>} tracked - every `git ls-files` path, exact spelling
 * @param {Map<string, string[]>} [folded] - lowercase path → tracked spellings
 * @returns {Array<{file: string, specifier: string, resolved: string, tracked: string}>}
 */
export function importCaseMismatches(file, source, tracked, folded = foldTracked(tracked)) {
  const mismatches = [];
  for (const specifier of relativeSpecifiers(source)) {
    const target = posix.normalize(posix.join(posix.dirname(file), specifier));
    if (target.startsWith('../')) continue;
    const candidates = COMPLETIONS.map((completion) => `${target}${completion}`);
    if (candidates.some((candidate) => tracked.has(candidate))) continue;
    const insensitive = candidates.flatMap((candidate) => folded.get(candidate.toLowerCase()) ?? []);
    if (insensitive.length > 0) mismatches.push({ file, specifier, resolved: target, tracked: insensitive[0] });
  }
  return mismatches;
}

/** Lowercased path → the tracked spellings that fold to it. */
export function foldTracked(tracked) {
  const folded = new Map();
  for (const path of tracked) {
    const key = path.toLowerCase();
    folded.set(key, [...(folded.get(key) ?? []), path]);
  }
  return folded;
}

const gitOutput = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const gitLines = (args, cwd) => gitOutput(args, cwd).split('\n').filter(Boolean);

/**
 * Check the changed modules (or every tracked module) of a checkout.
 *
 * @param {{cwd?: string, baseSha?: string|null}} [options]
 * @returns {{checked: number, mismatches: Array<object>}}
 */
export function checkImportCase({ cwd = process.cwd(), baseSha = null } = {}) {
  const tracked = new Set(gitOutput(['ls-files', '-z'], cwd).split('\0').filter(Boolean));
  const folded = foldTracked(tracked);
  const changed = baseSha
    ? gitLines(['diff', '--name-only', '--diff-filter=ACMR', `${baseSha}...HEAD`], cwd).filter((path) => tracked.has(path))
    : [...tracked];
  const modules = changed.filter((path) => MODULE_RE.test(path) && !path.includes('/node_modules/'));
  const mismatches = modules.flatMap((file) => {
    let source;
    try {
      source = readFileSync(posix.join(cwd, file), 'utf8');
    } catch {
      return [];
    }
    return importCaseMismatches(file, source, tracked, folded);
  });
  return { checked: modules.length, mismatches };
}

function parseArgs(argv) {
  const options = { baseSha: process.env.CI_BASE_SHA || null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--base') {
      options.baseSha = argv[index + 1] || null;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argv[index]}.`);
    }
  }
  return options;
}

function main() {
  const { baseSha } = parseArgs(process.argv.slice(2));
  const { checked, mismatches } = checkImportCase({ cwd: dirname(dirname(fileURLToPath(import.meta.url))), baseSha });
  if (mismatches.length > 0) {
    console.error(`❌ ${mismatches.length} import path(s) differ from the tracked file only in case — Linux cannot resolve them:`);
    for (const { file, specifier, tracked } of mismatches) console.error(`  ${file}: '${specifier}' → tracked as ${tracked}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ Import case check: ${checked} module(s) ${baseSha ? 'changed since the base' : 'tracked'}, every relative import matches the tracked spelling.`);
}

if (isDirectlyInvoked(import.meta.url)) main();
