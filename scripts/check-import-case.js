#!/usr/bin/env node

/**
 * Fail a pull request whose relative imports spell a path in a case that
 * differs from the tracked file.
 *
 * macOS (APFS) and Windows (NTFS) resolve `./Foo.js` to a tracked `foo.js`;
 * Linux does not. A pregate run on macOS therefore cannot see this one class
 * of Linux-only failure, so the impact job, which always runs, checks it here.
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
// A `/` after one of these words begins a regex literal, not a division.
const REGEX_PRECEDING_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
// `if (x) /re/.test(y)`: a `)` closing one of these headers is followed by a statement.
const CONTROL_HEADER_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
const COMPLETIONS = ['', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '/index.js', '/index.jsx', '/index.ts', '/index.tsx'];

/**
 * Classify every character of a module so specifier regexes can ignore text
 * that is not executable: comments and template-literal text are blanked in
 * `code` (newlines kept, so line anchors still work), and `inString` marks
 * characters inside a quoted string. Regex literals are skipped by a
 * previous-token heuristic; `${…}` inside a template is code again.
 */
function scanCode(source) {
  const code = source.split('');
  const inString = new Uint8Array(source.length);
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (code[i] !== '\n') code[i] = ' ';
  };
  const templates = []; // brace depth at which each open `${` resumes template text
  let depth = 0;
  let prev = ''; // last significant code character
  let prevAt = -1; // its index in source
  let i = 0;
  // `x++ / y`: a prefix ++/-- needs an operand, never a regex, so an adjacent
  // doubled +/- before `/` always ends an expression.
  const isPostfixStep = () => (prev === '+' || prev === '-') && prevAt > 0 && source[prevAt - 1] === prev;
  // The identifier ending at source[end], or '' when it is a property name (`a.return / 2`).
  const wordEndingAt = (end) => {
    let start = end;
    while (start > 0 && /[\w$]/.test(source[start - 1])) start -= 1;
    if (start > end) return '';
    let before = start - 1;
    while (before >= 0 && /\s/.test(source[before])) before -= 1;
    return before >= 0 && source[before] === '.' && source[before - 1] !== '.' ? '' : source.slice(start, end + 1);
  };
  const parens = []; // per open `(`: does it head an if/while/for/with?
  let closedControlHeader = false;
  const endsExpression = () => {
    if (prev === ')') return !closedControlHeader;
    if (/[\w$]/.test(prev)) return !REGEX_PRECEDING_KEYWORDS.has(wordEndingAt(prevAt));
    return false;
  };
  const readTemplate = (from) => {
    let j = from + 1;
    while (j < source.length) {
      if (source[j] === '\\') j += 2;
      else if (source[j] === '`') { blank(from, j + 1); return j + 1; }
      else if (source[j] === '$' && source[j + 1] === '{') {
        blank(from, j + 2);
        templates.push(depth);
        depth += 1;
        return j + 2;
      } else j += 1;
    }
    blank(from, source.length);
    return source.length;
  };
  // After readTemplate: a closed template is an operand ('`'); entering `${` starts a fresh expression, so a leading `/` is a regex ('{' is a regex-start context).
  const templateEnd = (end) => (source[end - 1] === '`' ? '`' : '{');
  while (i < source.length) {
    const ch = source[i];
    const two = source.slice(i, i + 2);
    if (two === '//') {
      let j = source.indexOf('\n', i);
      if (j < 0) j = source.length;
      blank(i, j);
      i = j;
    } else if (two === '/*') {
      let j = source.indexOf('*/', i + 2);
      j = j < 0 ? source.length : j + 2;
      blank(i, j);
      i = j;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      inString.fill(1, i, Math.min(j + 1, source.length));
      i = j + 1;
      prev = ch;
    } else if (ch === '`') {
      i = readTemplate(i);
      prev = templateEnd(i);
    } else if (ch === '/' && (prev === '' || '(,=:[!&|?{;+-*%<>~^'.includes(prev) || !endsExpression() && (prev === ')' || /[\w$]/.test(prev))) && !isPostfixStep()) {
      // `}` is deliberately not a regex start: it usually ends an object/function expression (`{} / d`), and mis-scanning a rare regex statement after a block is safer than dropping later imports from the check.
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) {
        if (source[j] === '\\') j += 1;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        j += 1;
      }
      inString.fill(1, i, Math.min(j + 1, source.length));
      i = j + 1;
      prev = '/';
    } else {
      if (ch === '(') parens.push(/[\w$]/.test(prev) && CONTROL_HEADER_KEYWORDS.has(wordEndingAt(prevAt)));
      else if (ch === ')') closedControlHeader = parens.pop() === true;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (templates.length > 0 && templates[templates.length - 1] === depth) {
          templates.pop();
          i = readTemplate(i);
          prev = templateEnd(i);
          continue;
        }
      }
      if (!/\s/.test(ch)) { prev = ch; prevAt = i; }
      i += 1;
    }
  }
  return { code: code.join(''), inString };
}

/** Every relative specifier in a module's executable code, in source order. */
export function relativeSpecifiers(source) {
  const { code, inString } = scanCode(source);
  const found = [...staticImportSpecifiersFromSource(code)];
  for (const re of [DYNAMIC_IMPORT_RE, NEW_URL_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(code)) !== null) if (!inString[match.index]) found.push(match[1]);
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
