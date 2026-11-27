import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDiskFs, createTestMemoAnalyzer, relatedTests } from '../lib/testMemo.js';
import { collectionFixtureSources } from './collectionFixtureSources.js';

const SUITE = 'scripts/perf/collectionFixture.db.test.js';
const HELPER = 'scripts/perf/collectionFixtureSources.js';
const SOURCE = 'server/src/entry.js';
const original = 'export const value = 1;\n';
let scratch;
let root;

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (file, content) => {
  const absolute = join(root, file);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
};
const verdict = () => {
  const analyze = createTestMemoAnalyzer({
    fs: createDiskFs(root, fs, path, { collectionFixtureSources: () => {
      try { return collectionFixtureSources(root); } catch { return null; }
    } }),
    workspaceRel: 'server',
  });
  return analyze.analyzeTest(SUITE, { baseClosure: analyze.workspaceBase([]), recorded: [HELPER] });
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'collection-fixture-index-'));
  root = join(scratch, 'repo');
  mkdirSync(root);
  git('init', '--template=');
  put(SUITE, "import './collectionFixtureSources.js';\n");
  put(HELPER, readFileSync(new URL('./collectionFixtureSources.js', import.meta.url)));
  put(SOURCE, original);
  put('lib/additional.js', 'export const additional = true;\n');
  git('add', '--', SOURCE, 'lib/additional.js');
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

it('keys indexed members and their working bytes without taking unrelated or untracked files', () => {
  const start = verdict();
  expect(start.floor).toMatchObject({ memoizable: true });
  expect(start.recorded).toMatchObject({ memoizable: true });
  expect(collectionFixtureSources(root).entries.map(({ file }) => file)).toEqual(['lib/additional.js', SOURCE]);
  put('docs/outside.md', 'outside source');
  put('server/no.test.js', 'excluded test');
  git('add', '--', 'docs/outside.md', 'server/no.test.js');
  put('server/untracked.js', original);
  expect(verdict().floor.key).toBe(start.floor.key);
  expect(verdict().recorded.key).toBe(start.recorded.key);

  put(SOURCE, 'export const value = 2;\n');
  expect(verdict().floor.key).not.toBe(start.floor.key);
  expect(verdict().recorded.key).not.toBe(start.recorded.key);
  git('add', '--', SOURCE);
  put(SOURCE, original);
  expect(verdict().floor.key).not.toBe(start.floor.key);
  git('add', '--', SOURCE);
  expect(verdict().floor.key).toBe(start.floor.key);

  git('add', '--', 'server/untracked.js');
  expect(verdict().floor.key).not.toBe(start.floor.key);
  git('rm', '--cached', '--', 'server/untracked.js');
  expect(verdict().floor.key).toBe(start.floor.key);
  const analyzed = new Map([[SUITE, start]]);
  expect(relatedTests(analyzed, ['docs/outside.md'])).toEqual([]);
  expect(relatedTests(analyzed, ['server/src/deleted.js'])).toEqual([SUITE]);
});

it('keys the staged and working modes independently', () => {
  const start = verdict().floor.key;
  git('update-index', '--chmod=+x', '--', SOURCE);
  expect(verdict().floor.key).not.toBe(start);
  git('update-index', '--chmod=-x', '--', SOURCE);
  expect(verdict().floor.key).toBe(start);
  if (process.platform !== 'win32') {
    fs.chmodSync(join(root, SOURCE), 0o755);
    expect(verdict().floor.key).not.toBe(start);
  }
});

it('refuses unsupported index modes and unreadable working files', () => {
  const blob = git('rev-parse', ':' + SOURCE);
  git('update-index', '--cacheinfo', '120000,' + blob + ',' + SOURCE);
  expect(() => collectionFixtureSources(root)).toThrow('Unsupported collection fixture index entry');
  expect(verdict().floor).toMatchObject({ memoizable: false, key: null });

  git('update-index', '--cacheinfo', '100644,' + blob + ',' + SOURCE);
  rmSync(join(root, SOURCE));
  expect(verdict().floor).toMatchObject({ memoizable: false, key: null });
});

it('refuses a symlinked source directory even when it contains matching bytes', () => {
  const external = join(scratch, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'entry.js'), original);
  rmSync(join(root, 'server/src'), { recursive: true });
  symlinkSync(external, join(root, 'server/src'), 'junction');
  expect(() => collectionFixtureSources(root)).toThrow('Collection fixture source directories must be physical');
  expect(verdict().floor).toMatchObject({ memoizable: false, key: null });
  expect(verdict().recorded).toMatchObject({ memoizable: false, key: null });
});

it('refuses a changed source collector until its memo contract has been reviewed', () => {
  fs.appendFileSync(join(root, HELPER), '\n// Contract changed\n');
  expect(verdict().floor).toMatchObject({ memoizable: false, key: null });
});
