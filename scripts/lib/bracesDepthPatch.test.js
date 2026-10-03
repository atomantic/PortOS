import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { applyBracesDepthPatch, BRACES_MAX_DEPTH } from './bracesDepthPatch.js';
import { patchInstalledDependencies, rebuildTrusted, runCli } from '../trusted-rebuilds.js';

const require = createRequire(import.meta.url);
// CI installs the server tree only. Follow PM2's actual chokidar consumer,
// rather than assuming a root install or the server's unrelated chokidar 5.
const pm2Require = createRequire(require.resolve('pm2/package.json', { paths: [fileURLToPath(new URL('../../server/', import.meta.url))] }));
const watcherRequire = createRequire(pm2Require.resolve('chokidar'));
const bracesRequire = createRequire(watcherRequire.resolve('braces/package.json'));
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

const install = () => {
  const dir = mkdtempSync(join(tmpdir(), 'braces-depth-patch-'));
  dirs.push(dir);
  const modules = join(dir, 'node_modules');
  mkdirSync(modules);
  for (const name of ['braces', 'fill-range', 'to-regex-range', 'is-number']) {
    cpSync(dirname(bracesRequire.resolve(`${name}/package.json`)), join(modules, name), { recursive: true });
  }
  return { dir, modules, braces: () => require(join(modules, 'braces')) };
};

describe('PM2 braces depth mitigation (#9906)', () => {
  it('refuses deep brace, parenthesis and malformed patterns with a bounded error, then remains usable', () => {
    const f = install();
    patchInstalledDependencies(f.dir);
    const braces = f.braces();
    const deep = '{'.repeat(4000) + 'a,b' + '}'.repeat(4000);
    for (const input of [deep, '('.repeat(4000) + 'x' + ')'.repeat(4000), '{'.repeat(4000)]) {
      for (const method of ['parse', 'compile', 'expand', 'stringify']) {
        expect(() => braces[method](input)).toThrowError(expect.objectContaining({ code: 'EBRACESDEPTH' }));
      }
    }
    expect(braces.expand('src/{client,server}/{a..c}.js')).toEqual([
      'src/client/a.js', 'src/client/b.js', 'src/client/c.js',
      'src/server/a.js', 'src/server/b.js', 'src/server/c.js',
    ]);
    expect(braces.compile('src/{client,server}/*.js')).toBe('src/(client|server)/*.js');
    // Quoted, escaped and bracketed literals must not spend nesting depth.
    const literal = '{'.repeat(100);
    expect(braces.stringify(`"${literal}"`)).toBe(literal);
    expect(braces.stringify('\\{'.repeat(100))).toBe(literal);
    expect(braces.stringify(`[${literal}]`)).toBe(`[${literal}]`);
    expect(braces.stringify('{a')).toBe('{a');
  });

  it('guards externally supplied ASTs as well as parser input', () => {
    const f = install();
    applyBracesDepthPatch(f.modules);
    const braces = f.braces();
    const ast = () => {
      let node = { type: 'text', value: 'x' };
      for (let i = 0; i < BRACES_MAX_DEPTH + 2; i++) node = { type: 'root', nodes: [node] };
      return node;
    };
    for (const method of ['compile', 'expand', 'stringify']) {
      expect(() => braces[method](ast())).toThrowError(expect.objectContaining({ code: 'EBRACESDEPTH' }));
    }
  });

  it('patches idempotently through both managed rebuild and rebuild-free CLI paths', () => {
    const f = install();
    expect(rebuildTrusted(f.dir, 'client')).toBe(true);
    const file = join(f.modules, 'braces', 'lib', 'compile.js');
    const once = readFileSync(file, 'utf8');
    expect(runCli(['browser', f.dir])).toBe(0);
    expect(applyBracesDepthPatch(f.modules)).toBe('already-patched');
    expect(readFileSync(file, 'utf8')).toBe(once);
  });

  it('fails the install before writing when any upstream walker is unfamiliar', () => {
    const f = install();
    const compile = join(f.modules, 'braces', 'lib', 'compile.js');
    const parse = join(f.modules, 'braces', 'lib', 'parse.js');
    const original = readFileSync(parse, 'utf8');
    writeFileSync(compile, 'module.exports = () => "foreign";');
    expect(() => runCli(['browser', f.dir])).toThrow('Unrecognized braces compile.js');
    expect(readFileSync(parse, 'utf8')).toBe(original);
    writeFileSync(join(f.modules, 'braces', 'package.json'), '{"version":"4.0.0"}');
    expect(() => applyBracesDepthPatch(f.modules)).toThrow('Unrecognized braces release');
  });
});
