/**
 * Test memo key contract: what moves a key, what must not, and every way a
 * test fails closed. Runs over an in-memory tree so each case names exactly
 * the input it exercises.
 */

import { describe, expect, it } from 'vitest';
import { ALWAYS_RUN_TESTS } from '../ci-test-plan.js';
import {
  DIRECTORY_INPUT_LIMIT,
  TEST_MEMO_NEVER,
  computeTestMemoKeys,
  extractFileFacts,
  relatedTests,
  tokenize,
} from './testMemo.js';

/** An in-memory `fs` for the analyzer: `{ 'repo/relative/path': 'content' }`. */
function memoryFs(files) {
  const names = Object.keys(files);
  return {
    read: (rel) => (rel in files ? Buffer.from(files[rel]) : null),
    kind: (rel) => (rel in files ? 'file' : rel === '' || names.some((name) => name.startsWith(`${rel}/`)) ? 'dir' : null),
    list: (rel) => [...new Set(names.filter((name) => rel === '' || name.startsWith(`${rel}/`))
      .map((name) => name.slice(rel === '' ? 0 : rel.length + 1).split('/')[0]))],
  };
}

const BASE = {
  'server/vitest.config.js': "import { vitestCiPool } from '../scripts/vitestCiPool.js';\nexport default {};\n",
  'server/vitest.setup.js': 'export const setup = true;\n',
  'scripts/vitestCiPool.js': 'export const vitestCiPool = () => ({});\n',
  'server/package.json': '{"name":"server"}',
  'server/package-lock.json': '{}',
  'server/node_modules/vitest/package.json': '{"name":"vitest","version":"5.0.4"}',
  'server/node_modules/zod/package.json': '{"name":"zod","version":"3.0.0"}',
};

const TREE = {
  ...BASE,
  'server/lib/a.js': "import { z } from 'zod';\nexport const a = 1;\n",
  'server/lib/b.js': "export const load = () => import('./lazy.js');\n",
  'server/lib/lazy.js': 'export const lazy = 1;\n',
  'server/lib/mocked.js': 'export const real = 1;\n',
  'server/lib/unrelated.js': 'export const unrelated = 1;\n',
  'server/lib/fixture.txt': 'fixture v1\n',
  'server/lib/a.test.js': [
    "import { it } from 'vitest';",
    "import { a } from './a.js';",
    "import { load } from './b.js';",
    "vi.mock('./mocked.js', () => ({ real: 2 }));",
    "const text = readFileSync(new URL('./fixture.txt', import.meta.url), 'utf8');",
    'it(\'a\', () => {});',
  ].join('\n'),
  'server/lib/plain.test.js': "import { it } from 'vitest';\nimport { unrelated } from './unrelated.js';\nit('plain', () => {});\n",
};

const ENV = { NODE_ENV: 'test', CI: 'true' };
const options = (files, extra = {}) => ({ fs: memoryFs(files), workspace: 'server', env: ENV, platform: 'linux', arch: 'x64', nodeVersion: '24.1.0', ...extra });
const keyOf = (files, test = 'server/lib/a.test.js', extra = {}) => computeTestMemoKeys([test], options(files, extra)).get(test);

describe('floor key', () => {
  const baseline = keyOf(TREE);

  it('is stable, memoizable, and invariant to an unrelated file', () => {
    expect(baseline.floor.memoizable).toBe(true);
    expect(keyOf(TREE).floor.key).toBe(baseline.floor.key);
    expect(keyOf({ ...TREE, 'server/lib/unrelated.js': 'export const unrelated = 2;\n' }).floor.key).toBe(baseline.floor.key);
  });

  it('changes with a static, dynamic or mocked closure member, a fixture, a package version, or a gating env var', () => {
    const variants = {
      'static member': { ...TREE, 'server/lib/a.js': "import { z } from 'zod';\nexport const a = 2;\n" },
      'dynamic member': { ...TREE, 'server/lib/lazy.js': 'export const lazy = 2;\n' },
      'mocked member': { ...TREE, 'server/lib/mocked.js': 'export const real = 3;\n' },
      fixture: { ...TREE, 'server/lib/fixture.txt': 'fixture v2\n' },
      'package version': { ...TREE, 'server/node_modules/zod/package.json': '{"name":"zod","version":"3.1.0"}' },
      'workspace config': { ...TREE, 'server/vitest.setup.js': 'export const setup = false;\n' },
    };
    const keys = new Set([baseline.floor.key]);
    for (const [label, files] of Object.entries(variants)) {
      const key = keyOf(files).floor.key;
      expect(key, label).not.toBe(baseline.floor.key);
      keys.add(key);
    }
    expect(keys.size).toBe(Object.keys(variants).length + 1);
    expect(keyOf(TREE, 'server/lib/a.test.js', { env: { ...ENV, PORTOS_TEST_QUIET: '1' } }).floor.key).not.toBe(baseline.floor.key);
    expect(keyOf(TREE, 'server/lib/a.test.js', { platform: 'win32' }).floor.key).not.toBe(baseline.floor.key);
    expect(keyOf(TREE, 'server/lib/a.test.js', { nodeVersion: '24.1.1' }).floor.key).not.toBe(baseline.floor.key);
  });

  it('fails closed on a non-literal import, a git spawn, the never marker, a missing package, and the curated lists', () => {
    const cases = {
      'import(variable)': ["import { it } from 'vitest';", 'const m = await import(process.env.MODULE);', 'it(\'x\', () => {});'],
      'git spawn': ["import { it } from 'vitest';", "import { execFileSync } from 'node:child_process';", "execFileSync('git', ['status']);", 'it(\'x\', () => {});'],
      marker: ["import { it } from 'vitest';", '// test-memo: never', 'it(\'x\', () => {});'],
      'missing package': ["import { it } from 'vitest';", "import nope from 'not-installed';", 'it(\'x\', () => {});'],
      'import.meta.glob': ["import { it } from 'vitest';", "const all = import.meta.glob('./*.js');", 'it(\'x\', () => {});'],
      'repository state': ["import { it } from 'vitest';", "const head = readFileSync(new URL('../../.git/HEAD', import.meta.url));", 'it(\'x\', () => {});'],
    };
    for (const [label, lines] of Object.entries(cases)) {
      const info = keyOf({ ...TREE, 'server/lib/a.test.js': lines.join('\n') });
      expect(info.floor.memoizable, label).toBe(false);
      expect(info.floor.key, label).toBeNull();
    }
    const alwaysRun = ALWAYS_RUN_TESTS.find((path) => path.startsWith('server/'));
    expect(keyOf({ ...TREE, [alwaysRun]: "import { it } from 'vitest';\nit('x', () => {});\n" }, alwaysRun).floor).toMatchObject({ memoizable: false, reason: 'always-run guard' });
    const never = Object.keys(TEST_MEMO_NEVER).find((path) => path.startsWith('server/') && !ALWAYS_RUN_TESTS.includes(path));
    expect(keyOf({ ...TREE, [never]: "import { it } from 'vitest';\nit('x', () => {});\n" }, never).floor).toMatchObject({ memoizable: false, reason: TEST_MEMO_NEVER[never] });
  });

  it('fails closed on a directory input past the limit and accepts one under it', () => {
    const fixtures = {};
    for (let i = 0; i <= DIRECTORY_INPUT_LIMIT; i += 1) fixtures[`server/lib/fixtures/f${i}.json`] = '{}';
    const test = ["import { it } from 'vitest';", "const read = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');", 'it(\'x\', () => {});'].join('\n');
    expect(keyOf({ ...TREE, ...fixtures, 'server/lib/a.test.js': test }).floor).toMatchObject({ memoizable: false, reason: expect.stringContaining('directory input too large') });
    const small = { ...TREE, 'server/lib/fixtures/f0.json': '{}', 'server/lib/a.test.js': test };
    const before = keyOf(small).floor;
    expect(before.memoizable).toBe(true);
    expect(keyOf({ ...small, 'server/lib/fixtures/f0.json': '{"v":2}' }).floor.key).not.toBe(before.key);
  });

  it('keeps the git rule off product modules the test merely imports', () => {
    const files = { ...TREE, 'server/lib/a.js': "import { execFileSync } from 'node:child_process';\nexport const a = () => execFileSync('git', ['status']);\n" };
    expect(keyOf(files).floor.memoizable).toBe(true);
    expect(keyOf({ ...files, 'scripts/tool.js': files['server/lib/a.js'], 'server/lib/a.test.js': "import { it } from 'vitest';\nimport '../../scripts/tool.js';\nit('x', () => {});\n" }).floor)
      .toMatchObject({ memoizable: false, reason: 'spawns git' });
  });
});

describe('recorded key', () => {
  const recorded = ['server/lib/a.test.js', 'server/lib/a.js', 'server/lib/b.js'];
  const withRecord = (files, test = 'server/lib/a.test.js', loaded = recorded) => keyOf(files, test, { records: new Map([[test, loaded]]) });

  it('ignores modules the green run never loaded and moves with the ones it did', () => {
    const baseline = withRecord(TREE);
    expect(baseline.recorded.memoizable).toBe(true);
    expect(withRecord({ ...TREE, 'server/lib/lazy.js': 'export const lazy = 2;\n' }).recorded.key).toBe(baseline.recorded.key);
    expect(withRecord({ ...TREE, 'server/lib/mocked.js': 'export const real = 3;\n' }).recorded.key).toBe(baseline.recorded.key);
    expect(withRecord({ ...TREE, 'server/lib/b.js': "export const load = () => import('./lazy.js'); export const x = 1;\n" }).recorded.key).not.toBe(baseline.recorded.key);
    expect(withRecord({ ...TREE, 'server/lib/fixture.txt': 'v2' }).recorded.key).not.toBe(baseline.recorded.key);
  });

  it('survives an unresolved edge that only the floor key fails on', () => {
    const files = { ...TREE, 'server/lib/b.js': 'export const load = (name) => import(name);\n' };
    const info = withRecord(files);
    expect(info.floor.memoizable).toBe(false);
    expect(info.edgesResolved).toBe(false);
    expect(info.recorded.memoizable).toBe(true);
  });

  it('keeps JS a member reads as text, spawns, loads natively or runs as a worker, with their closures, even when the run never imported it', () => {
    const cases = {
      'text read': {
        test: ["import { it } from 'vitest';", "import { readFileSync } from 'node:fs';", "const src = readFileSync(new URL('../routes/x.js', import.meta.url), 'utf8');", 'it(\'g\', () => {});'],
        mutate: 'server/routes/x.js',
      },
      spawn: {
        test: ["import { it } from 'vitest';", "import { spawnSync } from 'node:child_process';", "import { join } from 'node:path';", "it('c', () => { spawnSync(process.execPath, [join(__dirname, '../routes/x.js')]); });"],
        mutate: 'server/routes/helper.js', // the spawned script's own import
      },
      'spawn target': {
        test: ["import { it } from 'vitest';", "import { fork } from 'node:child_process';", "it('c', () => { fork(new URL('../routes/x.js', import.meta.url)); });"],
        mutate: 'server/routes/x.js',
      },
      worker: {
        test: ["import { it } from 'vitest';", "import { Worker } from 'node:worker_threads';", "it('w', () => new Worker(new URL('../routes/x.js', import.meta.url)));"],
        mutate: 'server/routes/x.js',
      },
      createRequire: {
        test: ["import { it } from 'vitest';", "import { createRequire } from 'node:module';", "const require = createRequire(import.meta.url);", "const legacy = require('../routes/legacy.cjs');", 'it(\'u\', () => {});'],
        mutate: 'server/routes/legacy.cjs',
      },
      'createRequire under another name': {
        test: ["import { it } from 'vitest';", "import { createRequire } from 'node:module';", "const load = createRequire(import.meta.url);", "const legacy = load('../routes/legacy.cjs');", 'it(\'u\', () => {});'],
        mutate: 'server/routes/legacy.cjs',
      },
      'shared source reader': {
        test: ["import { it } from 'vitest';", "import { readServerSource } from './testHelper.js';", "it('r', () => readServerSource('routes/x.js'));"],
        mutate: 'server/routes/x.js',
      },
    };
    const files = {
      ...TREE,
      'server/routes/x.js': "import { h } from './helper.js';\nexport const x = h;\n",
      'server/routes/helper.js': 'export const h = 1;\n',
      'server/routes/legacy.cjs': 'module.exports = 1;\n',
      'server/lib/testHelper.js': "export const readServerSource = (rel) => rel;\n",
    };
    for (const [label, { test, mutate }] of Object.entries(cases)) {
      const tree = { ...files, 'server/lib/side.test.js': test.join('\n') };
      const loaded = ['server/lib/side.test.js', ...(label === 'shared source reader' ? ['server/lib/testHelper.js'] : [])];
      const before = withRecord(tree, 'server/lib/side.test.js', loaded);
      expect(before.recorded.memoizable, label).toBe(true);
      const after = withRecord({ ...tree, [mutate]: `${tree[mutate]}// changed\n` }, 'server/lib/side.test.js', loaded);
      expect(after.recorded.key, label).not.toBe(before.recorded.key);
      expect(after.floor.key, label).not.toBe(before.floor.key);
    }
    // Assembled so this file does not itself read as a tree scanner to scripts/repo-scan-guards.test.js.
    const unresolvable = { ...files, 'server/lib/side.test.js': ["import { it } from 'vitest';", "import { readServerSource } from './testHelper.js';", `it('r', () => ${'readServerSource'}(process.env.TARGET));`].join('\n') };
    expect(withRecord(unresolvable, 'server/lib/side.test.js', ['server/lib/side.test.js']).recorded).toMatchObject({ memoizable: false, reason: expect.stringContaining('readServerSource') });
  });

  it('is not memoizable when the loaded set reaches outside the repository', () => {
    const info = keyOf(TREE, 'server/lib/a.test.js', { records: new Map([['server/lib/a.test.js', [...recorded, '../outside/x.js']]]) });
    expect(info.recorded).toMatchObject({ memoizable: false, reason: expect.stringContaining('outside the repository') });
  });
});

describe('non-literal native require() in a product module', () => {
  const test = ["import { it } from 'vitest';", "import { start } from './boot.js';", "it('b', () => start());"].join('\n');
  const tree = (boot) => ({
    ...TREE,
    'server/lib/boot.js': boot,
    'server/lib/boot.test.js': test,
    'ecosystem.config.cjs': 'module.exports = { apps: [] };\n',
    'sub/ecosystem.config.cjs': 'module.exports = { apps: [1] };\n',
    'server/node_modules/native-driver/package.json': '{"name":"native-driver","version":"1.0.0"}',
  });
  const floor = (files) => keyOf(files, 'server/lib/boot.test.js').floor;

  it('keys every tracked file of the basename when the directory is unknown', () => {
    const boot = ["import { createRequire } from 'node:module';", "import { join } from 'node:path';", 'const require = createRequire(import.meta.url);', "const NAME = 'ecosystem.config.cjs';",
      'export const start = (root) => { const configPath = join(root.dir, NAME); return require(configPath); };'].join('\n');
    const base = floor(tree(boot));
    expect(base.memoizable).toBe(true);
    expect(floor({ ...tree(boot), 'ecosystem.config.cjs': 'module.exports = { apps: [2] };\n' }).key).not.toBe(base.key);
    expect(floor({ ...tree(boot), 'sub/ecosystem.config.cjs': 'module.exports = { apps: [2] };\n' }).key).not.toBe(base.key);
    // A non-literal basename is still unknown.
    expect(floor(tree(boot.replace("join(root.dir, NAME)", 'join(root.dir, root.name)')))).toMatchObject({ memoizable: false, reason: expect.stringContaining('non-literal') });
  });

  it('keys a package-name constant by the installed package version', () => {
    const boot = ["import { createRequire } from 'node:module';", 'const require = createRequire(import.meta.url);', "const DRIVER = 'native-driver';", 'export const start = () => require(DRIVER);'].join('\n');
    const base = floor(tree(boot));
    expect(base.memoizable).toBe(true);
    expect(floor({ ...tree(boot), 'server/node_modules/native-driver/package.json': '{"name":"native-driver","version":"2.0.0"}' }).key).not.toBe(base.key);
  });
});

describe('python sidecars, external tools and machine-local state', () => {
  it('hashes a python sidecar and its resolvable sibling imports, and keys the python version', () => {
    const files = {
      ...TREE,
      'scripts/tool.py': 'import os\nfrom _common import run\nimport _pins\n',
      'scripts/_common.py': 'def run(): pass\n',
      'scripts/_pins.py': 'PINS = 1\n',
      'scripts/tool.test.js': ["import { it } from 'vitest';", "import { spawnSync } from 'node:child_process';", "it('p', () => spawnSync(process.env.PORTOS_TEST_PYTHON || 'python3', [new URL('./tool.py', import.meta.url).pathname]));"].join('\n'),
    };
    const versions = { python: 'Python 3.12.1' };
    const key = (tree, extra = {}) => keyOf(tree, 'scripts/tool.test.js', { toolVersion: (tool) => versions[tool] ?? null, ...extra }).floor;
    const base = key(files);
    expect(base.memoizable).toBe(true);
    expect(key({ ...files, 'scripts/_common.py': 'def run(): return 1\n' }).key).not.toBe(base.key);
    expect(key({ ...files, 'scripts/_pins.py': 'PINS = 2\n' }).key).not.toBe(base.key);
    expect(key(files, { toolVersion: () => 'Python 3.13.0' }).key).not.toBe(base.key);
    expect(key({ ...files, 'scripts/tool.py': 'from .missing import x\n' }).memoizable).toBe(false);
    // `import a, b` names two siblings.
    expect(key({ ...files, 'scripts/tool.py': 'import _common, _pins\n', 'scripts/_pins.py': 'PINS = 3\n' }).key).not.toBe(key({ ...files, 'scripts/tool.py': 'import _common, _pins\n' }).key);
    // A test that never reaches python does not carry its version.
    expect(keyOf(TREE, 'server/lib/a.test.js', { toolVersion: () => 'Python 3.13.0' }).floor.key).toBe(keyOf(TREE).floor.key);
    // The interpreter resolved through the shared helper is python too; an unknown program given a .py file is not memoizable.
    const viaHelper = { ...files, 'server/lib/testHelper.js': "export const resolveTestPython = () => 'python3';\n",
      'scripts/tool.test.js': ["import { it } from 'vitest';", "import { spawnSync } from 'node:child_process';", "import { resolveTestPython } from '../server/lib/testHelper.js';", 'const pyBin = resolveTestPython();', "it('p', () => spawnSync(pyBin, [new URL('./tool.py', import.meta.url).pathname]));"].join('\n') };
    expect(key(viaHelper).key).not.toBe(key(viaHelper, { toolVersion: () => 'Python 3.13.0' }).key);
    const unknownProgram = { ...files, 'scripts/tool.test.js': ["import { it } from 'vitest';", "import { spawnSync } from 'node:child_process';", "it('p', () => spawnSync(process.env.INTERPRETER, [new URL('./tool.py', import.meta.url).pathname]));"].join('\n') };
    expect(key(unknownProgram)).toMatchObject({ memoizable: false, reason: expect.stringContaining('unknown program') });
  });

  it('follows importlib.import_module with a literal name and fails closed on a computed one', () => {
    const files = {
      ...TREE,
      'scripts/tool.py': "import importlib\nmod = importlib.import_module('_pins')\n",
      'scripts/_pins.py': 'PINS = 1\n',
      'scripts/tool.test.js': ["import { it } from 'vitest';", "import { spawnSync } from 'node:child_process';", "it('p', () => spawnSync('python3', [new URL('./tool.py', import.meta.url).pathname]));"].join('\n'),
    };
    const key = (tree) => keyOf(tree, 'scripts/tool.test.js', { toolVersion: () => 'Python 3.12.1' }).floor;
    expect(key(files).memoizable).toBe(true);
    expect(key({ ...files, 'scripts/_pins.py': 'PINS = 2\n' }).key).not.toBe(key(files).key);
    expect(key({ ...files, 'scripts/tool.py': 'import importlib\nmod = importlib.import_module(name)\n' })).toMatchObject({ memoizable: false, reason: expect.stringContaining('import_module') });
  });

  it('fails closed when the test or repository tooling reads the install data tree or the home directory, and ignores a product module doing so', () => {
    // The fixture sources spell the data directory from pieces so this file
    // does not itself trip lib/testDataIsolation.guards.test.js.
    const DATA = ['da', 'ta'].join('');
    const read = (rel) => ["import { it } from 'vitest';", "import { readFileSync } from 'node:fs';", "import { join } from 'node:path';", "import { homedir } from 'node:os';", `it('d', () => readFileSync(${rel}));`].join('\n');
    expect(keyOf({ ...TREE, 'server/lib/a.test.js': read(`join(__dirname, '../../${DATA}/settings.json')`) }).floor).toMatchObject({ memoizable: false, reason: expect.stringContaining('machine-local') });
    expect(keyOf({ ...TREE, 'server/lib/a.test.js': read("join(homedir(), '.portos', 'agent-key.json')") }).floor).toMatchObject({ memoizable: false, reason: expect.stringContaining('machine-local') });
    expect(keyOf({ ...TREE, 'server/lib/a.test.js': read("join(process.env.HOME, '.portos')") }).floor.memoizable).toBe(false);
    const product = { ...TREE, 'server/lib/a.js': `import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const a = () => readFileSync(join(__dirname, '..', '..', '${DATA}', 'settings.json'));\n` };
    expect(keyOf(product).floor.memoizable).toBe(true);
  });
});

describe('closure-based related selection', () => {
  it('follows static, dynamic and mock edges, JSON inputs, and treats unresolved edges as related to everything', () => {
    const withJson = { ...TREE, 'server/lib/plain.test.js': "import { it } from 'vitest';\nimport manifest from './manifest.json';\nit('plain', () => {});\n", 'server/lib/manifest.json': '{}' };
    expect(relatedTests(computeTestMemoKeys(['server/lib/a.test.js', 'server/lib/plain.test.js'], options(withJson)), ['server/lib/manifest.json'])).toEqual(['server/lib/plain.test.js']);
    const keys = computeTestMemoKeys(['server/lib/a.test.js', 'server/lib/plain.test.js'], options(TREE));
    expect(relatedTests(keys, ['server/lib/lazy.js'])).toEqual(['server/lib/a.test.js']);
    expect(relatedTests(keys, ['server/lib/mocked.js'])).toEqual(['server/lib/a.test.js']);
    expect(relatedTests(keys, ['server/lib/unrelated.js'])).toEqual(['server/lib/plain.test.js']);
    expect(relatedTests(keys, ['server/lib/nothing.js'])).toEqual([]);
    const unresolved = computeTestMemoKeys(['server/lib/a.test.js', 'server/lib/plain.test.js'],
      options({ ...TREE, 'server/lib/plain.test.js': "import { it } from 'vitest';\nconst m = await import(process.env.MODULE);\nit('x', () => {});\n" }));
    expect(relatedTests(unresolved, ['server/lib/nothing.js'])).toEqual(['server/lib/plain.test.js']);
  });
});

describe('extractFileFacts', () => {
  it('resolves anchored literals, directories, templates and spawned scripts', () => {
    const src = [
      "const here = dirname(fileURLToPath(import.meta.url));",
      "const ROOT = join(here, '..', '..');",
      "const fixtures = new URL('./fixtures/', import.meta.url);",
      "const text = readFileSync(`${ROOT}/docs/API.md`, 'utf8');",
      "const one = readFileSync(join(__dirname, 'x.json'));",
      "const any = readFileSync(join(fixtures.pathname, name));",
      "spawnSync(process.execPath, [join(ROOT, 'scripts', 'tool.js')], { cwd: ROOT });",
      "const tmp = readFileSync(join(tmpdir(), 'scratch.json'));",
      "const data = readFileSync(join(ROOT, 'data', 'settings.json'));",
    ].join('\n');
    const facts = extractFileFacts(src, { fileRel: 'server/lib/x.test.js', cwdRel: 'server' });
    expect(facts.paths).toEqual(expect.arrayContaining([
      { rel: 'docs/API.md', walk: false },
      { rel: 'server/lib/x.json', walk: false },
      { rel: 'scripts/tool.js', walk: true },
      { rel: 'data/settings.json', walk: false },
    ]));
    expect(facts.paths.map((p) => p.rel)).not.toContain('');
    expect(facts.dirs.map((d) => d.rel)).toContain('server/lib/fixtures');
    expect(facts.unresolvedEdges).toEqual([]);
    expect(facts.unresolvedInputs).toEqual([]);
    expect(facts.git).toBe(false);
  });

  it('reads static edges from tokens, so comments and strings cannot fake or hide one', () => {
    const src = [
      "// import ghost from './ghost.js';",
      "/* export * from './ghost2.js' */",
      "const prose = \"import x from './ghost3.js'\";",
      "import real from './real.js';",
      "export { r } from './reexport.js';",
      "import 'side';",
    ].join('\n');
    expect(extractFileFacts(src, { fileRel: 'server/lib/x.js', cwdRel: 'server' }).edges).toEqual([
      { spec: './real.js', kind: 'static' }, { spec: './reexport.js', kind: 'static' }, { spec: 'side', kind: 'static' },
    ]);
  });

  it('tokenizes JSX prose leniently and still fails closed on a broken template hole', () => {
    expect(() => tokenize("const a = <p>Don't use /sdapi/v1/* here, or `this`</p>;")).not.toThrow();
    expect(() => tokenize('const a = `unterminated ${hole')).toThrow();
  });
});
