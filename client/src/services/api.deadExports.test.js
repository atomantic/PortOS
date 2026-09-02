import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..');
const BARRELS = new Set(['api.js']);

// Deliberate keeps — a one-line, reviewed decision rather than silent
// accumulation. CLIENT_BUILD_ID is the build-injected identity on socket.js
// for the stale-client check; it has no UI importer by design.
const INTENTIONALLY_UNREFERENCED = Object.freeze(['CLIENT_BUILD_ID']);

const isTest = (name) => /\.test\.(js|jsx)$/.test(name);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(js|jsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const n1 = src[i + 1];
    if (c === '/' && n1 === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n1 === '*') {
      i += 2;
      while (i < n - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      continue;
    }
    if (c === '\'' || c === '"') {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        out += src[i];
        if (src[i] === '\\') { out += src[i + 1] || ''; i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '`') {
      out += c;
      i++;
      while (i < n) {
        out += src[i];
        if (src[i] === '\\') { out += src[i + 1] || ''; i += 2; continue; }
        if (src[i] === '`') { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function collectNamedExports(src) {
  const names = new Set();
  let m;
  const decl = /^export (?:async function|function|const|let|var|class) (\w+)/gm;
  while ((m = decl.exec(src))) names.add(m[1]);
  const braced = /^export \{([^}]+)\}/gm;
  while ((m = braced.exec(src))) {
    for (const part of m[1].split(',')) {
      const bit = part.trim();
      if (!bit) continue;
      const as = bit.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  return names;
}

function identFiles(files) {
  const map = new Map();
  const ident = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const seen = new Set();
    let m;
    while ((m = ident.exec(src))) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      let arr = map.get(m[0]);
      if (!arr) map.set(m[0], arr = []);
      arr.push(file);
    }
  }
  return map;
}

function exportModules() {
  return readdirSync(HERE)
    .filter((f) => !isTest(f) && (
      f === 'socket.js'
      || (f.startsWith('api') && f.endsWith('.js') && f !== 'api.js')
    ))
    .map((f) => join(HERE, f));
}

function findDeadExports({ extraModule } = {}) {
  const all = walk(SRC_ROOT);
  const sources = all.filter((f) => !isTest(f));
  const modules = exportModules();
  const corpus = sources.filter((f) => !BARRELS.has(relative(HERE, f)));
  const filesFor = identFiles(corpus);

  const dead = [];
  const consider = (file, src) => {
    for (const name of collectNamedExports(src)) {
      if (INTENTIONALLY_UNREFERENCED.includes(name)) continue;
      const hits = (filesFor.get(name) || []).filter((f) => f !== file);
      if (hits.length === 0) dead.push(`${relative(SRC_ROOT, file)}:${name}`);
    }
  };
  for (const file of modules) consider(file, readFileSync(file, 'utf8'));
  if (extraModule) consider(join(HERE, extraModule.file), extraModule.src);
  return dead;
}

describe('client API wrappers have callers', () => {
  it('lists no export referenced nowhere outside its module and the barrels', () => {
    const dead = findDeadExports();
    expect(dead, `caller-less wrappers:\n${dead.join('\n')}`).toEqual([]);
  });

  it('fails when a caller-less wrapper is added', () => {
    const src = 'export const definitelyUnusedApiWrapper5727 = () => {};\n';
    expect(collectNamedExports(src).has('definitelyUnusedApiWrapper5727')).toBe(true);
    const dead = findDeadExports({
      extraModule: { file: 'apiFake.js', src },
    });
    expect(dead.some((row) => row.endsWith(':definitelyUnusedApiWrapper5727'))).toBe(true);
  });

  it('allowlists CLIENT_BUILD_ID as the only intentional keep', () => {
    expect(INTENTIONALLY_UNREFERENCED).toEqual(['CLIENT_BUILD_ID']);
    const socketSrc = readFileSync(join(HERE, 'socket.js'), 'utf8');
    expect(collectNamedExports(socketSrc).has('CLIENT_BUILD_ID')).toBe(true);
  });
});
// @vitest-environment node
