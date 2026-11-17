import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Vite compiles a template `import(`./dir/${name}.js`)` into a glob map of the
// files present at TRANSFORM time. Vitest's fs module cache keys that
// transform on the importing file's own content, so a module added to the
// directory later makes a warm-cache run throw "Unknown variable dynamic
// import" while a cold CI run passes (#13087). Callers must import by file URL
// with `/* @vite-ignore */` (see checkInfraBarrel.test.js) or use literals.
const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'data', 'coverage', '.cache']);

// Matches `import(` + template literal with an interpolation, but not data: URLs
// (those are not file lookups) and not calls already marked @vite-ignore.
const FILE_GLOB_IMPORT = /\bimport\(\s*(?!\/\*\s*@vite-ignore)`(?!data:)[^`]*\$\{/;

const listSources = (dir) => readdirSync(dir).flatMap((name) => {
  if (SKIP_DIRS.has(name) || name.startsWith('.')) return [];
  const full = join(dir, name);
  if (statSync(full).isDirectory()) return listSources(full);
  return name.endsWith('.js') ? [full] : [];
});

describe('template dynamic imports over a directory (#13087)', () => {
  it('matcher flags relative-path templates and ignores data URLs and @vite-ignore', () => {
    expect(FILE_GLOB_IMPORT.test('await import(`./x/${f}.js`)')).toBe(true);
    expect(FILE_GLOB_IMPORT.test('import(`data:text/javascript;base64,${s}`)')).toBe(false);
    expect(FILE_GLOB_IMPORT.test('import(/* @vite-ignore */ `./x/${f}.js`)')).toBe(false);
    expect(FILE_GLOB_IMPORT.test('import(`./literal.js`)')).toBe(false);
  });

  it('no server source resolves a directory through a template import()', () => {
    const offenders = listSources(SERVER_ROOT)
      .filter((file) => file !== fileURLToPath(import.meta.url))
      .filter((file) => FILE_GLOB_IMPORT.test(readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '')))
      .map((file) => relative(SERVER_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
