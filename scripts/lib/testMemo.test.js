/**
 * Test memo key contract: what moves a key, what must not, and every way a
 * test fails closed. Runs over an in-memory tree so each case names exactly
 * the input it exercises.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAlwaysRunTests } from '../ci-test-plan.js';
import {
  DIRECTORY_INPUT_LIMIT,
  TEST_MEMO_NEVER,
  computeTestMemoKeys,
  extractFileFacts,
  literalExports,
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
    const alwaysRun = getAlwaysRunTests().find((path) => path.startsWith('server/'));
    expect(keyOf({ ...TREE, [alwaysRun]: "import { it } from 'vitest';\nit('x', () => {});\n" }, alwaysRun).floor).toMatchObject({ memoizable: false, reason: 'always-run guard' });
    const never = Object.keys(TEST_MEMO_NEVER).find((path) => path.startsWith('server/') && !getAlwaysRunTests().includes(path));
    expect(keyOf({ ...TREE, [never]: "import { it } from 'vitest';\nit('x', () => {});\n" }, never).floor).toMatchObject({ memoizable: false, reason: TEST_MEMO_NEVER[never] });
  });

  it('keeps tree scanners out of the memo', () => {
    const treeScanners = [
      'server/lib/apiRouteParity.test.js',
      'server/lib/apiAccessPolicy.guard.test.js',
      'server/lib/creativeLatitude.sources.guard.test.js',
      'server/lib/dispatchLabels.audit.guard.test.js',
      'server/lib/dynamicImportGlob.guard.test.js',
      'server/lib/promptSystemStages.test.js',
    ];
    for (const test of treeScanners) {
      const info = keyOf({ ...TREE, [test]: "import { it } from 'vitest';\nit('tree guard', () => {});\n" }, test);
      expect(info.floor.memoizable, test).toBe(false);
      expect(info.floor.key, test).toBeNull();
    }
  });

  it('fails closed on a directory input past the limit and accepts one under it', () => {
    const fixtures = {};
    for (let i = 0; i <= DIRECTORY_INPUT_LIMIT; i += 1) fixtures[`server/lib/fixtures/f${i}.json`] = '{}';
    // The helper is called with the directory's own entry names: a helper nothing calls reads nothing (#16602).
    const test = ["import { it } from 'vitest';", "import { readdirSync, readFileSync } from 'node:fs';", "const read = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');", "const all = readdirSync(join(__dirname, 'fixtures')).map(read);", 'it(\'x\', () => {});'].join('\n');
    expect(keyOf({ ...TREE, ...fixtures, 'server/lib/a.test.js': test }).floor).toMatchObject({ memoizable: false, reason: expect.stringContaining('directory input too large') });
    const small = { ...TREE, 'server/lib/fixtures/f0.json': '{}', 'server/lib/a.test.js': test };
    const before = keyOf(small).floor;
    expect(before.memoizable).toBe(true);
    expect(keyOf({ ...small, 'server/lib/fixtures/f0.json': '{"v":2}' }).floor.key).not.toBe(before.key);
  });

  // #16545: a suite that hands `client/` to Vite as its root reads the whole
  // tree. "Too large" kept it out of the memo forever; the repository listing
  // names the tree's files instead, and the key still moves with every one.
  describe('a directory past the limit that the repository listing can enumerate', () => {
    const CLIENT = {
      ...BASE,
      'client/vitest.config.js': 'export default {};\n',
      'client/src/test/setup.js': 'export const setup = true;\n',
      'client/package.json': '{"name":"client"}',
      'client/package-lock.json': '{}',
      'client/node_modules/vitest/package.json': '{"name":"vitest","version":"5.0.4"}',
      'client/src/App.jsx': "import { NAV } from '../../server/lib/nav.js';\nexport const App = () => NAV;\n",
      'client/src/index.css': 'body { margin: 0; }\n',
      'client/src/notes.md': 'notes\n',
      'client/src/guard.test.js': "// test-memo: never\nimport { execFileSync } from 'node:child_process';\nexecFileSync('git', ['status']);\n",
      'server/lib/nav.js': "export { NAV } from './navData.js';\n",
      'server/lib/navData.js': 'export const NAV = 1;\n',
      'server/lib/unrelated.js': 'export const unrelated = 1;\n',
    };
    for (let i = 0; i <= DIRECTORY_INPUT_LIMIT; i += 1) CLIENT[`client/src/components/C${i}.jsx`] = `export const C${i} = ${i};\n`;
    const suite = (name) => [
      "import { it } from 'vitest';",
      "const root = fileURLToPath(new URL('../..', import.meta.url));",
      `it('${name}', async () => { await createServer({ configFile: false, root, readdir: readdirSync(root) }); });`,
    ].join('\n');
    const one = 'client/src/pages/One.browser.test.js';
    const two = 'client/src/pages/Two.browser.test.js';
    const files = { ...CLIENT, [one]: suite('one'), [two]: suite('two') };
    const tracked = (tree) => Object.keys(tree).filter((rel) => !rel.includes('node_modules/'));
    const floorOf = (tree, test = one, extra = {}) => computeTestMemoKeys([test], options(tree, { workspace: 'client', listFiles: () => tracked(tree), ...extra })).get(test).floor;
    const baseline = floorOf(files);

    it('keys the suite instead of failing closed, and still fails closed without a listing', () => {
      expect(baseline.memoizable).toBe(true);
      expect(floorOf(files).key).toBe(baseline.key);
      for (const listFiles of [undefined, null, () => null]) {
        expect(floorOf(files, one, { listFiles })).toMatchObject({ memoizable: false, reason: `${one}: directory input too large: client` });
      }
    });

    it('moves the key when any file under client/src changes, appears or disappears', () => {
      // Every file, not a sample: a served tree has no file the suite provably cannot reach.
      const sources = tracked(files).filter((rel) => rel.startsWith('client/src/'));
      expect(sources.length).toBeGreaterThan(DIRECTORY_INPUT_LIMIT);
      const unmoved = sources.filter((rel) => floorOf({ ...files, [rel]: `${files[rel]}\n/* edited */\n` }).key === baseline.key);
      expect(unmoved).toEqual([]);
      expect(floorOf({ ...files, 'client/src/components/New.jsx': 'export const New = 1;\n' }).key).not.toBe(baseline.key);
      const { 'client/src/notes.md': removed, ...without } = files;
      expect(floorOf(without).key).not.toBe(baseline.key);
      // Still listed but gone from the working tree (an unstaged deletion): the set changed all the same.
      expect(floorOf(without, one, { listFiles: () => tracked(files) }).key).toBe(floorOf(without).key);
    });

    it('follows what the tree imports from outside it, and nothing else outside it', () => {
      expect(floorOf({ ...files, 'server/lib/nav.js': "export { NAV } from './navData.js'; // edited\n" }).key).not.toBe(baseline.key);
      expect(floorOf({ ...files, 'server/lib/navData.js': 'export const NAV = 2;\n' }).key).not.toBe(baseline.key);
      expect(floorOf({ ...files, 'server/lib/unrelated.js': 'export const unrelated = 2;\n' }).key).toBe(baseline.key);
    });

    it('leaves a file git ignores out of the key', () => {
      const listed = () => tracked(files);
      expect(floorOf({ ...files, 'client/src/scratch.log': 'one\n' }, one, { listFiles: listed }).key).toBe(baseline.key);
      expect(floorOf({ ...files, 'client/src/scratch.log': 'two\n' }, one, { listFiles: listed }).key).toBe(baseline.key);
    });

    it('gives two suites inside the same tree different keys', () => {
      // Their file sets are identical; an entry names one test, so a shared key would let only one of them ever hit.
      expect(floorOf(files, two).memoizable).toBe(true);
      expect(floorOf(files, two).key).not.toBe(baseline.key);
    });

    it('keeps failing closed when the directory is only the prefix of a path with a variable segment', () => {
      // Past the limit a prefix is never keyed from the listing. An unbounded read may land anywhere
      // (`read('../../server/lib/nav.js')` leaves the prefix, and a template URL names another
      // directory altogether), and a listed name is refused there as it always was.
      const HERE = 'const HERE = dirname(fileURLToPath(import.meta.url));';
      for (const read of [
        `${HERE}\nconst read = (p) => readFileSync(join(HERE, p), 'utf8');\nread(process.argv[2]);`,
        'const shipped = (name) => readFileSync(new URL(`../../../server/lib/${name}`, import.meta.url));\nshipped(process.argv[2]);',
        `${HERE}\nfor (const name of readdirSync(HERE)) readFileSync(join(HERE, name), 'utf8');`,
      ]) {
        const guessed = { ...files };
        for (let i = 0; i <= DIRECTORY_INPUT_LIMIT; i += 1) guessed[`client/src/pages/p${i}.json`] = '{}';
        guessed[one] = `import { it } from 'vitest';\nimport { readdirSync, readFileSync } from 'node:fs';\n${read}\nit('one', () => {});\n`;
        expect(floorOf(guessed), read).toMatchObject({ memoizable: false, reason: `${one}: directory input too large: client/src/pages` });
      }
    });

    it('keeps failing closed on the repository root, a nested repository, a spawned tree and a reader that can load it natively', () => {
      const rootReader = { ...files, [one]: suite('one').replace("'../..'", "'../../..'") };
      expect(floorOf(rootReader)).toMatchObject({ memoizable: false, reason: `${one}: directory input too large: <repo root>` });
      // A submodule is one listed entry whatever it holds, so the listing cannot vouch for the tree.
      const nested = { ...files, 'client/vendor/lib/index.js': 'export const vendored = 1;\n' };
      expect(floorOf(nested, one, { listFiles: () => [...tracked(files), 'client/vendor'] })).toMatchObject({ memoizable: false, reason: `${one}: directory input too large: client` });
      const spawned = { ...files, [one]: "import { it } from 'vitest';\nconst root = fileURLToPath(new URL('../../', import.meta.url));\nit('one', () => { spawnSync(root); });\n" };
      expect(floorOf(spawned)).toMatchObject({ memoizable: false, reason: `${one}: directory input too large: client` });
      const native = { ...files, [one]: `${suite('one')}\nconst load = createRequire(import.meta.url);\nconst plugin = load(pluginPath());\n` };
      const recordedNative = computeTestMemoKeys([one], options(native, { workspace: 'client', listFiles: () => tracked(native), records: new Map([[one, [one]]]) })).get(one).recorded;
      expect(recordedNative).toMatchObject({ memoizable: false, reason: `${one}: directory input too large: client` });
    });

    it('keys the tree for the test and for repository tooling, never for a product module the test imports', () => {
      // A library walker reads such a tree only when a tree-scanning guard calls it, and those are always-run.
      const reader = (up) => `export const list = () => readdirSync(fileURLToPath(new URL('${up}/client', import.meta.url)));\n`;
      const importer = (spec) => `import { it } from 'vitest';\nimport { list } from '${spec}';\nit('x', () => {});\n`;
      const test = 'server/lib/reader.test.js';
      const floor = (tree) => computeTestMemoKeys([test], options(tree, { listFiles: () => tracked(tree) })).get(test).floor;
      const product = { ...files, 'server/lib/reader.js': reader('../..'), [test]: importer('./reader.js') };
      const tooling = { ...files, 'scripts/reader.js': reader('..'), [test]: importer('../../scripts/reader.js') };
      const edited = { 'client/src/index.css': 'body { margin: 1px; }\n' };
      expect(floor(product).memoizable).toBe(true);
      expect(floor({ ...product, ...edited }).key).toBe(floor(product).key);
      expect(floor(tooling).memoizable).toBe(true);
      expect(floor({ ...tooling, ...edited }).key).not.toBe(floor(tooling).key);
    });

    it('selects the suite for a change anywhere in the tree, recorded or not', () => {
      const keys = (extra = {}) => computeTestMemoKeys([one], options(files, { workspace: 'client', listFiles: () => tracked(files), ...extra }));
      const digestOf = (rel) => createHash('sha256').update(files[rel]).digest('hex').slice(0, 16);
      const recorded = keys({ records: new Map([[one, [one]]]), digests: new Map([[one, [digestOf(one)]]]) });
      expect(recorded.get(one).narrowed).not.toBeNull();
      for (const info of [keys(), recorded]) {
        expect(relatedTests(info, ['client/src/components/C7.jsx'])).toEqual([one]);
        expect(relatedTests(info, ['server/lib/navData.js'])).toEqual([one]);
        expect(relatedTests(info, ['server/lib/unrelated.js'])).toEqual([]);
      }
    });
  });

  // A real-browser suite renders what a dev server, bundler or static server
  // reads on its behalf, none of which the module runner records. Before
  // #16545 a directory handed to such a tool was "a value", so a suite that
  // wrote `root: clientDir` was skipped after the component it renders changed.
  describe('a directory a real-browser test hands to a tool', () => {
    const SERVED = {
      ...TREE,
      'client/package.json': '{"name":"client"}',
      'client/package-lock.json': '{"lockfileVersion":3}',
      'client/src/Panel.jsx': 'export const Panel = 1;\n',
      'client/public/font.woff2': 'font v1\n',
      'server/lib/static/player.js': 'export const play = 1;\n',
      'server/node_modules/playwright-core/package.json': '{"name":"playwright-core","version":"1.0.0"}',
    };
    const preamble = ["import { it } from 'vitest';", "const repo = resolve(import.meta.dirname, '../..');", "const client = join(repo, 'client');"];
    const browserTest = (body) => [...preamble, "import { chromium } from 'playwright-core';", body, "it('renders', () => {});"].join('\n');
    const nodeTest = (body) => [...preamble, body, "it('renders', () => {});"].join('\n');
    const test = 'server/lib/a.test.js';
    const floorOf = (body, tree = SERVED, extra = {}) => keyOf({ ...tree, [test]: browserTest(body) }, test, extra).floor;
    const handing = "const server = await createServer({ configFile: false, root: client, css: { postcss: { plugins: [tailwind({ base: client })] } } });\napp.use(express.static(join(__dirname, 'static')));";

    it('keys the tree behind a root: option, a static server and an object-literal value', () => {
      const baseline = floorOf(handing);
      expect(baseline.memoizable).toBe(true);
      for (const rel of ['client/src/Panel.jsx', 'client/public/font.woff2', 'client/package-lock.json', 'server/lib/static/player.js']) {
        expect(floorOf(handing, { ...SERVED, [rel]: `${SERVED[rel]} ` }).key, rel).not.toBe(baseline.key);
      }
      expect(floorOf(handing, { ...SERVED, 'client/src/New.jsx': 'export const New = 1;\n' }).key).not.toBe(baseline.key);
      const publicDir = "await build({ configFile: false, publicDir: join(client, 'public') });";
      expect(floorOf(publicDir, { ...SERVED, 'client/public/font.woff2': 'font v2\n' }).key).not.toBe(floorOf(publicDir).key);
      expect(floorOf(publicDir, { ...SERVED, 'client/src/Panel.jsx': 'export const Panel = 2;\n' }).key).toBe(floorOf(publicDir).key);
      const shorthand = 'await serve({ port: 0, client });';
      expect(floorOf(shorthand, { ...SERVED, 'client/src/Panel.jsx': 'export const Panel = 2;\n' }).key).not.toBe(floorOf(shorthand).key);
    });

    it.each(['root', 'dir', '"base"'])('keys a bounded variable %s and rejects an unbounded one only for browsers', (option) => {
      const optionPath = (path) => `createServer({ ${option}: ${path} });`;
      const open = optionPath('(join(client, pick()))');
      expect(floorOf(open)).toMatchObject({ memoizable: false, reason: `${test}: reads a path with a variable segment that can leave client` });
      expect(keyOf({ ...SERVED, [test]: nodeTest(open) }, test).floor.memoizable).toBe(true);
      const contained = "import { pathWithin } from '../../scripts/lib/pathWithin.js';\n" + optionPath('pathWithin(client, pick())');
      const tree = { ...SERVED, 'scripts/lib/pathWithin.js': 'export const pathWithin = (dir, name) => join(dir, name);\n' };
      const baseline = floorOf(contained, tree);
      expect(baseline.memoizable).toBe(true);
      expect(floorOf(contained, { ...tree, 'client/src/Panel.jsx': 'export const Panel = 2;\n' }).key).not.toBe(baseline.key);
    });

    it('keys an install directory by its manifest and lockfile', () => {
      for (const body of ["await symlink(join(client, 'node_modules'), link, 'dir');", 'const bundler = resolveClientBundler(repo);']) {
        const tree = { ...SERVED, 'client/node_modules/vite/package.json': '{"name":"vite","version":"8.0.0"}' };
        const baseline = floorOf(body, tree);
        expect(baseline.memoizable, body).toBe(true);
        expect(floorOf(body, { ...tree, 'client/package-lock.json': '{"lockfileVersion":4}' }).key, body).not.toBe(baseline.key);
        expect(floorOf(body, { ...tree, 'client/src/Panel.jsx': 'export const Panel = 2;\n' }).key, body).toBe(baseline.key);
      }
    });

    it('fails closed on the repository root, the install data tree, build output, a tree past the limit and a native non-literal require', () => {
      expect(floorOf("app.use(express.static(join(client, 'dist')));", { ...SERVED, 'client/dist/index.html': '<html></html>' }))
        .toMatchObject({ memoizable: false, reason: `${test}: hands build output or a cache to a tool: client/dist` });
      expect(floorOf('const server = await createServer({ root: repo });')).toMatchObject({ memoizable: false, reason: `${test}: hands the repository root to a tool` });
      // The same root spelled with a trailing slash.
      expect(floorOf("app.use(express.static(fileURLToPath(new URL('../../', import.meta.url))));")).toMatchObject({ memoizable: false, reason: `${test}: hands the repository root to a tool` });
      expect(floorOf("app.use(express.static(join(repo, 'data')));", { ...SERVED, 'data/x.json': '{}' })).toMatchObject({ memoizable: false, reason: `${test}: reads machine-local state (data)` });
      const big = { ...SERVED };
      for (let i = 0; i <= DIRECTORY_INPUT_LIMIT; i += 1) big[`client/src/big/f${i}.js`] = 'export {};\n';
      expect(floorOf(handing, big)).toMatchObject({ memoizable: false, reason: `${test}: directory input too large: client` });
      expect(floorOf(handing, big, { listFiles: () => Object.keys(big) }).memoizable).toBe(true);
      const native = `${handing}\nconst load = createRequire(import.meta.url);\nconst plugin = load(pluginPath());`;
      const recorded = computeTestMemoKeys([test], options({ ...SERVED, [test]: browserTest(native) }, { records: new Map([[test, [test]]]) })).get(test).recorded;
      expect(recorded).toMatchObject({ memoizable: false, reason: `${test}: hands client to a tool and has a non-literal require()` });
    });

    it('does not mistake a property key for the binding of the same name, or a block for an object literal', () => {
      // `root: client` beside `const root = <repo root>`: the key is not a use of the binding.
      const body = "const root = resolve(import.meta.dirname, '../..');\nconst server = await createServer({ configFile: false, root: client });";
      expect(floorOf(body).memoizable).toBe(true);
      // A directory returned from a block or chosen by a ternary there is handed to nothing.
      const blocks = 'const where = () => { return repo; };\nif (flag) { const picked = flag ? client : repo; }';
      expect(floorOf(blocks).memoizable).toBe(true);
      expect(floorOf(blocks, { ...SERVED, 'client/src/Panel.jsx': 'export const Panel = 2;\n' }).key).toBe(floorOf(blocks).key);
    });

    it('leaves a Node test that passes the same directories along exactly as it was', () => {
      const key = (body, tree = SERVED) => keyOf({ ...tree, [test]: nodeTest(body) }).floor;
      expect(key(`${handing}\nhelper({ root: repo });`).memoizable).toBe(true);
      expect(key(handing, { ...SERVED, 'client/src/Panel.jsx': 'export const Panel = 2;\n' }).key).toBe(key(handing).key);
    });

    it('treats a test as real-browser through what it runs, not through browser tests a member only lists', () => {
      const lister = "export const templates = () => readdirSync(join(__dirname, 'templates'));\n";
      const sibling = "import { chromium } from 'playwright-core';\nit('a browser test in the listed directory', () => {});\n";
      const tree = { ...SERVED, 'server/lib/lister.js': lister, 'server/lib/templates/engine.browser.test.js': sibling };
      const body = `import { templates } from './lister.js';\n${handing}`;
      const listed = keyOf({ ...tree, [test]: nodeTest(body) }).floor;
      expect(listed.memoizable).toBe(true);
      expect(keyOf({ ...tree, 'client/src/Panel.jsx': 'export const Panel = 2;\n', [test]: nodeTest(body) }).floor.key).toBe(listed.key);
      // A helper the test imports, or a script it spawns, that drives Chrome does make it one.
      const helper = { ...SERVED, 'server/lib/driver.js': "export const chrome = process.env.CHROME_PATH;\n" };
      for (const reach of ["import { chrome } from './driver.js';", "spawn(process.execPath, [join(__dirname, 'driver.js')]);"]) {
        const before = keyOf({ ...helper, [test]: nodeTest(`${reach}\n${handing}`) }).floor;
        expect(before.memoizable, reach).toBe(true);
        expect(keyOf({ ...helper, 'client/src/Panel.jsx': 'export const Panel = 2;\n', [test]: nodeTest(`${reach}\n${handing}`) }).floor.key, reach).not.toBe(before.key);
      }
    });

    it('selects the suite for a change in a handed tree, recorded or not', () => {
      const files = { ...SERVED, [test]: browserTest(handing) };
      const digestOf = (rel) => createHash('sha256').update(files[rel]).digest('hex').slice(0, 16);
      const recorded = computeTestMemoKeys([test], options(files, { records: new Map([[test, [test]]]), digests: new Map([[test, [digestOf(test)]]]) }));
      expect(recorded.get(test).narrowed).not.toBeNull();
      for (const info of [computeTestMemoKeys([test], options(files)), recorded]) {
        expect(relatedTests(info, ['client/src/Panel.jsx'])).toEqual([test]);
        expect(relatedTests(info, ['server/lib/static/player.js'])).toEqual([test]);
        expect(relatedTests(info, ['server/lib/unrelated.js'])).toEqual([]);
      }
    });
  });

  it('keys the arguments that select which cases run', () => {
    const plain = keyOf(TREE).floor.key;
    const full = keyOf(TREE, 'server/lib/a.test.js', { caseFilter: ['--testNamePattern=^(?!.*\\[local-performance\\]).*$'] }).floor.key;
    expect(keyOf(TREE, 'server/lib/a.test.js', { caseFilter: [] }).floor.key).toBe(plain);
    expect(full).not.toBe(plain);
    expect(keyOf(TREE, 'server/lib/a.test.js', { caseFilter: ['--testNamePattern=\\[fidelity\\]'] }).floor.key).not.toBe(full);
  });

  it('marks a verdict that was declared rather than discovered', () => {
    const marked = { ...TREE, 'server/lib/a.js': `// test-memo: never\n${TREE['server/lib/a.js']}` };
    expect(keyOf(marked).floor).toMatchObject({ memoizable: false, declared: true });
    const [guard] = getAlwaysRunTests();
    expect(computeTestMemoKeys([guard], options({ ...TREE, [guard]: "import { it } from 'vitest';\nit('g', () => {});\n" })).get(guard).floor).toMatchObject({ memoizable: false, declared: true });
    const dynamic = { ...TREE, 'server/lib/a.js': 'export const a = (name) => import(name);\n' };
    expect(keyOf(dynamic).floor).toMatchObject({ memoizable: false, declared: false });
  });

  it('keeps the git rule off product modules the test merely imports', () => {
    const files = { ...TREE, 'server/lib/a.js': "import { execFileSync } from 'node:child_process';\nexport const a = () => execFileSync('git', ['status']);\n" };
    expect(keyOf(files).floor.memoizable).toBe(true);
    expect(keyOf({ ...files, 'scripts/tool.js': files['server/lib/a.js'], 'server/lib/a.test.js': "import { it } from 'vitest';\nimport '../../scripts/tool.js';\nit('x', () => {});\n" }).floor)
      .toMatchObject({ memoizable: false, reason: 'spawns git' });
  });
});

// #16602: a path with a variable segment was keyed as the directory the source
// still names, as if the read had to land inside it. A helper called with
// '../../client/src/limits.js' leaves that directory, so the key held a tree the
// test never read and missed the file it did. A variable segment now has to be
// resolved to its literal values, proven to stay under the prefix, or the test
// (or the `scripts/` member) is refused.
describe('a read whose variable segment can leave the directory the source names', () => {
  const test = 'server/lib/a.test.js';
  const EXTRA = {
    'client/src/limits.js': 'export const LIMIT = 1;\n',
    'data.reference/templates/a.png': 'png v1\n',
    'data.reference/templates/b.png': 'png v1\n',
    'server/lib/fixtures/f0.json': '{}',
    'server/lib/fixtures/f1.json': '{}',
    'server/lib/fixtures/LICENSE': 'license v1\n',
    'server/lib/fixtures/mod.js': 'export const mod = 1;\n',
    'server/lib/space name.txt': 'spaced v1\n',
    'scripts/lib/pathWithin.js': 'export const pathWithin = (dir, ...segments) => join(dir, ...segments);\n',
  };
  const PREAMBLE = [
    "import { it } from 'vitest';",
    "import { existsSync, readdirSync, readFileSync } from 'node:fs';",
    "import { readdir } from 'node:fs/promises';",
    "import * as fs from 'node:fs';",
    "import { randomUUID } from 'node:crypto';",
    "import { pathWithin } from '../../scripts/lib/pathWithin.js';",
    'const HERE = dirname(fileURLToPath(import.meta.url));',
    "const FIXTURES = join(HERE, 'fixtures');",
  ].join('\n');
  const tree = (body, extra = {}) => ({ ...TREE, ...EXTRA, ...extra, [test]: `${PREAMBLE}\n${body}\nit('x', () => {});\n` });
  const floorOf = (body, extra) => keyOf(tree(body, extra), test).floor;
  /** True when the test is keyed and its key moves with `rel`. */
  const keyedOn = (body, rel) => {
    const before = floorOf(body);
    return before.memoizable && floorOf(body, { [rel]: 'changed\n' }).key !== before.key;
  };
  const refusal = (body) => floorOf(body).reason;
  const leaves = (dir) => `${test}: reads a path with a variable segment that can leave ${dir}`;
  const through = (helper, dir) => `${test}: reads a path through ${helper}() that the analyzer cannot resolve (under ${dir})`;

  it('does not key on gitignored __pycache__ bytecode under a keyed tree', () => {
    const body = "for (const name of readdirSync(FIXTURES)) readFileSync(join(FIXTURES, name));";
    const base = floorOf(body, { 'server/lib/fixtures/x.py': 'x = 1\n' });
    const cached = floorOf(body, { 'server/lib/fixtures/x.py': 'x = 1\n', 'server/lib/fixtures/__pycache__/x.cpython-313.pyc': 'bytecode\n' });
    expect(base.memoizable).toBe(true);
    expect(cached.key).toBe(base.key);
    expect(floorOf(body, { 'server/lib/fixtures/x.py': 'x = 2\n' }).key).not.toBe(base.key);
  });

  it('keeps slash normalization and refuses another member operation only when its result can be read', () => {
    const path = "join(FIXTURES, 'f0.json')";
    const rel = 'server/lib/fixtures/f0.json';
    for (const suffix of [String.raw`.replaceAll('\\', '/')`, String.raw`.replace(/\\/g, '/')`, '.normalize()', '.toString()']) {
      expect(keyedOn(`readFileSync(${path}${suffix});`, rel), suffix).toBe(true);
    }
    const changed = `${path}.replace('.json', '.txt')`;
    const reason = 'reads a path the analyzer cannot follow through .replace()';
    for (const body of [`readFileSync(${changed});`, `execFileSync('bash', [${changed}]);`,
      `const target = ${changed}; load(normalize(target));`, `load(join(HERE, ${changed}));`,
      `load((${changed}));`, `load({ options: [${changed}] });`]) {
      expect(refusal(body), body).toBe(`${test}: ${reason}`);
    }
    for (const suffix of ['[key]', '?.[key]']) {
      expect(refusal(`readFileSync(${path}${suffix});`)).toBe(`${test}: reads a path the analyzer cannot follow through []`);
    }
    expect(floorOf(`expect({ paths: [${changed}] }).toContain('.txt');`).memoizable).toBe(true);
    const script = 'scripts/load-fixture.js';
    const scriptBody = `export const load = () => readFileSync(join(import.meta.dirname, 'f0.json').replace('.json', '.txt'));`;
    expect(floorOf("import '../../scripts/load-fixture.js';", { [script]: scriptBody }).reason).toBe(`${script}: ${reason}`);
  });

  it('refuses normalization that changes the spelling of a complete literal path', () => {
    const slashPath = String.raw`join(FIXTURES, 'sub\\f0.json')`;
    const decomposedPath = String.raw`join(FIXTURES, 'cafe\u0301.json')`;
    const normalizations = [
      [slashPath, String.raw`.replaceAll('\\', '/')`, '.replaceAll()'],
      [slashPath, String.raw`.replace(/\\/g, '/')`, '.replace()'],
      [decomposedPath, '.normalize()', '.normalize()'],
    ];
    for (const [path, operation, method] of normalizations) {
      expect(refusal(`readFileSync(${path}${operation});`)).toBe(`${test}: reads a path the analyzer cannot follow through ${method}`);
    }
  });

  it('refuses slash normalization of a guarded dynamic path unless a later guard re-bounds the normalized value', () => {
    const makeName = "const makeName = () => ['foo', '..', '..', 'outside.json'].join('\\\\');";
    for (const [operation, method] of [
      [String.raw`.replaceAll('\\', '/')`, '.replaceAll()'],
      [String.raw`.replace(/\\/g, '/')`, '.replace()'],
    ]) {
      expect(refusal(`${makeName}\nreadFileSync(pathWithin(FIXTURES, makeName())${operation});`), method)
        .toBe(`${test}: reads a path the analyzer cannot follow through ${method}`);
    }
    expect(refusal(String.raw`readFileSync(join(FIXTURES, readdirSync(FIXTURES)[0]).replaceAll('\\', '/'));`))
      .toBe(`${test}: reads a path the analyzer cannot follow through .replaceAll()`);
    // A guard on the pre-normalized path or using the normalized path as the base does not re-bound it.
    expect(refusal(`${makeName}\nconst raw = pathWithin(FIXTURES, makeName());\nconst norm = raw.replaceAll('\\\\', '/');\npathWithin(FIXTURES, raw);\nreadFileSync(norm);`))
      .toBe(`${test}: reads a path the analyzer cannot follow through .replaceAll()`);
    expect(refusal(`${makeName}\nconst norm = pathWithin(FIXTURES, makeName()).replaceAll('\\\\', '/');\nreadFileSync(pathWithin(norm, 'f0.json'));`))
      .toBe(`${test}: reads a path the analyzer cannot follow through .replaceAll()`);

    // Canonical literals, resolvable literal loops, and guards applied after normalization keep working.
    expect(keyedOn(String.raw`readFileSync(pathWithin(FIXTURES, 'f0.json').replaceAll('\\', '/'));`, 'server/lib/fixtures/f0.json')).toBe(true);
    expect(keyedOn(String.raw`for (const name of ['f0.json', 'f1.json']) readFileSync(join(FIXTURES, name).replaceAll('\\', '/'));`, 'server/lib/fixtures/f0.json')).toBe(true);
    expect(floorOf(`${makeName}\nreadFileSync(pathWithin(FIXTURES, makeName().replaceAll('\\\\', '/')));`).memoizable).toBe(true);
    expect(floorOf(`${makeName}\nconst norm = pathWithin(FIXTURES, makeName()).replaceAll('\\\\', '/');\nreadFileSync(pathWithin(FIXTURES, norm));`).memoizable).toBe(true);
  });

  it('refuses an environment-derived segment under an anchor but keeps genuinely external paths', () => {
    for (const expr of ['process.env.FIXTURE', 'process.env[envKey]', 'process.env.HOME']) {
      expect(refusal(`readFileSync(join(FIXTURES, ${expr}));`), expr).toBe(leaves('server/lib/fixtures'));
    }
    expect(refusal("const segment = process.env.FIXTURE; readFileSync(resolve(FIXTURES, segment));")).toBe(leaves('server/lib/fixtures'));
    for (const expr of ['tmpdir()', 'mkdtempSync(tmpdir())', "'/tmp/fixture.json'"]) {
      expect(floorOf(`readFileSync(resolve(FIXTURES, ${expr}));`).memoizable, expr).toBe(true);
    }
  });

  it('restarts resolve() at the rightmost proven absolute anchor and keeps join() left-to-right', () => {
    // Regression: environment-derived arguments to the left of a proven absolute anchor
    // are ignored by Node's resolve(), so the known fixture after HERE/FIXTURES is still keyed.
    const anchoredResolve = "readFileSync(resolve(process.env.FIXTURE_ROOT, FIXTURES, 'f0.json'));";
    expect(keyedOn(anchoredResolve, 'server/lib/fixtures/f0.json')).toBe(true);
    expect(keyedOn("readFileSync(resolve(join(HERE, process.argv[2]), FIXTURES, 'f0.json'));", 'server/lib/fixtures/f0.json')).toBe(true);

    // An unresolved suffix or unfollowed anchor after/without a right-side proven anchor still fails closed.
    expect(refusal("readFileSync(resolve(process.env.FIXTURE_ROOT, FIXTURES, process.env.SUB, 'f0.json'));")).toBe(leaves('server/lib/fixtures'));
    expect(refusal("readFileSync(resolve(process.env.FIXTURE_ROOT, FIXTURES, process.env.HOME));")).toBe(leaves('server/lib/fixtures'));
    expect(refusal("readFileSync(resolve(process.env.FIXTURE_ROOT, HERE.replace('a', 'b'), 'f0.json'));")).toBe(`${test}: reads a path the analyzer cannot follow through .replace()`);
    // A later external absolute value still overrides the repo anchor and remains memoizable.
    expect(floorOf("readFileSync(resolve(process.env.FIXTURE_ROOT, FIXTURES, '/tmp/fixture.json'));").memoizable).toBe(true);

    // join() does not reset at a later absolute anchor.
    const joined = [
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const HERE = import.meta.dirname;',
      "readFileSync(join(process.env.FIXTURE_ROOT, HERE, 'fixture.json'));",
    ].join('\n');
    expect(extractFileFacts(joined, { fileRel: test, cwdRel: 'server' }).paths).toEqual([]);
  });

  it('keys the file a helper is called with, not the directory the helper names', () => {
    const helper = "const read = (p) => readFileSync(join(HERE, p), 'utf8');\nconst limits = read('../../client/src/limits.js');";
    expect(keyedOn(helper, 'client/src/limits.js')).toBe(true);
    // The directory guess is gone: a neighbour the helper is never called with is not an input.
    expect(floorOf(helper).memoizable).toBe(true);
    expect(keyedOn(helper, 'server/lib/unrelated.js')).toBe(false);
    const template = 'const template = (name) => readFileSync(new URL(`../../data.reference/templates/${name}`, import.meta.url));\nconst png = template(\'a.png\');';
    expect(keyedOn(template, 'data.reference/templates/a.png')).toBe(true);
    expect(keyedOn(template, 'data.reference/templates/b.png')).toBe(false);
  });

  it('refuses a helper called with anything but a literal, naming the helper and the literal directory it kept', () => {
    expect(floorOf("const read = (p) => readFileSync(join(HERE, p), 'utf8');\nread(process.argv[2]);")).toMatchObject({ memoizable: false, key: null, reason: through('read', 'server/lib') });
    // The template's literal directories are kept, where the importing file's directory used to stand in for them.
    expect(refusal('const template = (name) => readFileSync(new URL(`../../data.reference/templates/${name}`, import.meta.url));\ntemplate(process.env.TEMPLATE);'))
      .toBe(through('template', 'data.reference/templates'));
    expect(refusal("function load(name) { return readFileSync(join(FIXTURES, `${name}.json`), 'utf8'); }\nload('f0'); load(pick());")).toBe(through('load', 'server/lib/fixtures'));
  });

  it('resolves every call of a helper, every row of a literal table and every pair of two variables', () => {
    const cases = {
      'two calls': "const read = (p) => readFileSync(join(FIXTURES, p), 'utf8');\nread('f0.json'); read('f1.json');",
      'a function declaration': "function read(p) { return readFileSync(join(FIXTURES, p), 'utf8'); }\nread('f0.json'); read('f1.json');",
      'a literal table': "it.each(['f0.json', 'f1.json'])('%s', (name) => { readFileSync(join(FIXTURES, name)); });",
      'a constant array': "const NAMES = ['f0.json', 'f1.json'];\nfor (const name of NAMES) readFileSync(`${FIXTURES}/${name}`);",
      'a frozen array handed on': "const NAMES = Object.freeze(['f0', 'f1']);\nregister(NAMES);\nNAMES.forEach((name) => readFileSync(join(FIXTURES, name + '.json')));",
      'two variables': "const read = (dir, name) => readFileSync(join(HERE, dir, name));\nread('fixtures', 'f0.json'); read('.', 'fixtures/f1.json');",
      'a constant array iterated with its index': "const NAMES = ['f0.json', 'f1.json'];\nNAMES.forEach((name, i) => readFileSync(join(FIXTURES, name)));",
      'a constant array handed a one-parameter helper': "const NAMES = ['f0.json', 'f1.json'];\nconst read = (name) => readFileSync(join(FIXTURES, name));\nNAMES.forEach(read);",
      'a suffix after the variable': "for (const stem of ['f0', 'f1']) readFileSync(`${FIXTURES}/${stem}.json`);",
      'a parameter named like the directory every call passes': "const read = (FIXTURES) => [readFileSync(join(FIXTURES, 'f0.json')), readFileSync(join(FIXTURES, 'f1.json'))];\nread(FIXTURES);",
      'a function parameter named like the directory every call passes': "function read(HERE, name) { return readFileSync(join(HERE, 'fixtures', name)); }\nread(HERE, 'f0.json'); read(HERE, 'f1.json');",
      'a parameter named like one directory and passed another': "const read = (HERE) => [readFileSync(join(HERE, 'f0.json')), readFileSync(join(HERE, 'f1.json'))];\nread(FIXTURES); read(join(HERE, 'fixtures'));",
      'a constant array compared by a matcher': "const NAMES = ['f0.json', 'f1.json'];\nexpect(NAMES).toHaveLength(2);\nexpect(NAMES).not.toContain('x');\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));",
      'a suffix after a helper parameter': "const read = (stem) => readFileSync(HERE + '/fixtures/' + stem + '.json');\nread('f0'); read('f1');",
      'a helper called by another helper': "const read = (name) => readFileSync(join(FIXTURES, name));\nconst both = (stem) => read(`${stem}.json`);\nboth('f0'); both('f1');",
      'a binding inside the helper': "const read = (name) => { const file = join(FIXTURES, name); return readFileSync(file); };\nread('f0.json'); read('f1.json');",
      'dynamic scope identifiers only outside the helper': "eval('');\nfunction read(name) { /* eval */ const text = 'arguments'; return readFileSync(join(FIXTURES, name)); }\nread('f0.json'); read('f1.json');\nother.arguments;",
    };
    for (const [label, body] of Object.entries(cases)) {
      expect(keyedOn(body, 'server/lib/fixtures/f0.json'), label).toBe(true);
      expect(keyedOn(body, 'server/lib/fixtures/f1.json'), label).toBe(true);
      // Exact files, no directory: a new neighbour is not an input.
      expect(floorOf(body, { 'server/lib/fixtures/f2.json': '{}' }).key, label).toBe(floorOf(body).key);
    }
    // A name with no extension is a file all the same, and a URL is read as the URL parser reads it.
    for (const [body, read] of [
      ["const read = (p) => readFileSync(join(FIXTURES, p));\nread('LICENSE');", 'server/lib/fixtures/LICENSE'],
      ["readFileSync(join(FIXTURES, 'LICENSE'));", 'server/lib/fixtures/LICENSE'],
      ["const read = (name) => readFileSync(new URL(name, import.meta.url));\nread('space%20name.txt');", 'server/lib/space name.txt'],
      ["const read = (name) => readFileSync(new URL(name, import.meta.url));\nread('./fixture.txt?raw');", 'server/lib/fixture.txt'],
      // String concatenation continues the last segment unless a separator is written, and only join() keeps a trailing one.
      ["readFileSync(`${join(FIXTURES, 'f0')}.json`);", 'server/lib/fixtures/f0.json'],
      ["readFileSync(join(HERE, 'fixtures/') + 'f0.json');", 'server/lib/fixtures/f0.json'],
      // A URL resolves beside a base that does not end in a separator, inside one that does.
      ["readFileSync(new URL('fixture.txt', pathToFileURL(FIXTURES)));", 'server/lib/fixture.txt'],
      ["readFileSync(new URL('f0.json', pathToFileURL(FIXTURES + '/')));", 'server/lib/fixtures/f0.json'],
      // join() reads a leading separator as a plain segment.
      ["const read = (p) => readFileSync(join(HERE, p));\nread('/fixture.txt');", 'server/lib/fixture.txt'],
      ["readFileSync(join(HERE, '/fixture.txt'));", 'server/lib/fixture.txt'],
      // A helper that only builds the path: what it returns is read, whoever reads it.
      ["const dirOf = (name) => join(HERE, name);\nfor (const f of readdirSync(dirOf('fixtures'))) readFileSync(join(dirOf('fixtures'), f));", 'server/lib/fixtures/f0.json'],
      ["const fixture = (name) => join(FIXTURES, name);\nreadFileSync(fixture('LICENSE'));", 'server/lib/fixtures/LICENSE'],
      // A second declarator is a binding too, and a module path is completed the way the loader completes it.
      ["const read = (name) => { const a = 1, file = join(FIXTURES, name); return readFileSync(file); };\nread('f0.json');", 'server/lib/fixtures/f0.json'],
      ["const load = (name) => import(join(FIXTURES, name));\nawait load('mod');", 'server/lib/fixtures/mod.js'],
      ["readFileSync(join(FIXTURES, '\\x66\\u0030.json'));", 'server/lib/fixtures/f0.json'],
    ]) expect(keyedOn(body, read), body).toBe(true);
    expect(keyedOn("readFileSync(resolve(HERE, 'fixtures/') + 'f0.json');", 'server/lib/fixtures/f0.json')).toBe(false);
    // A glob pattern, resolved or literal, is every match under its directory: a new one moves the key.
    for (const glob of ["const list = (pattern) => globSync(join(FIXTURES, pattern));\nexpect(list('*.json')).toHaveLength(2);", "expect(globSync(join(FIXTURES, '*.json'))).toHaveLength(2);"]) {
      expect(floorOf(glob).memoizable, glob).toBe(true);
      expect(floorOf(glob, { 'server/lib/fixtures/new.json': '{}' }).key, glob).not.toBe(floorOf(glob).key);
    }
    // A helper nothing calls reads nothing.
    expect(keyedOn("const read = (p) => readFileSync(join(FIXTURES, p), 'utf8');", 'server/lib/fixtures/f0.json')).toBe(false);
    expect(floorOf("const read = (p) => readFileSync(join(FIXTURES, p), 'utf8');").memoizable).toBe(true);
  });

  it('keys the directory for a name that provably stays inside it', () => {
    const cases = {
      'a listing mapped over': "const all = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => readFileSync(join(FIXTURES, f), 'utf8'));",
      'a listing kept in a constant': "const FILES = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();\nexpect(FILES.length).toBeGreaterThan(0);\nfor (const file of FILES) readFileSync(join(FIXTURES, file));",
      'a helper handed to the listing': "const read = (f) => readFileSync(join(FIXTURES, f));\nconst all = readdirSync(FIXTURES).map(read);",
      'a helper called with a listed name': "const read = (f) => readFileSync(join(FIXTURES, f));\nfor (const f of fs.readdirSync(FIXTURES)) read(f);",
      'an awaited listing': "for (const f of (await readdir(FIXTURES)).slice(0, 5)) readFileSync(`${HERE}/fixtures/${f}`);",
      'a literal directory in the joined text': "readdirSync(FIXTURES).forEach((f) => readFileSync(join(HERE, `fixtures/${f}`)));",
      'a literal directory concatenated': "readdirSync(FIXTURES).forEach((f) => readFileSync(HERE + '/fixtures/' + f));",
      'a generated name': "const probe = existsSync(join(FIXTURES, `${randomUUID()}.json`));",
      'a guarded join': "const read = (...parts) => readFileSync(pathWithin(FIXTURES, ...parts));\nread(process.argv[2]);",
      'a guarded join handed on': "const read = (name) => load(pathWithin(FIXTURES, name));\nread(process.argv[2]);",
    };
    for (const [label, body] of Object.entries(cases)) {
      expect(keyedOn(body, 'server/lib/fixtures/f0.json'), label).toBe(true);
      expect(floorOf(body, { 'server/lib/fixtures/new.json': '{}' }).key, label).not.toBe(floorOf(body).key);
      // The directory keyed is the one the literal text names, not the file's own.
      expect(keyedOn(body, 'server/lib/unrelated.js'), label).toBe(false);
    }
    // All literal, a guarded join is the one file.
    const literal = "readFileSync(pathWithin(FIXTURES, 'f0.json'));";
    expect(keyedOn(literal, 'server/lib/fixtures/f0.json')).toBe(true);
    expect(keyedOn(literal, 'server/lib/fixtures/f1.json')).toBe(false);
    // It joins as path.join does: a leading separator is a plain segment.
    expect(keyedOn("readFileSync(pathWithin(HERE, '/fixtures/f0.json'));", 'server/lib/fixtures/f0.json')).toBe(true);
  });

  it('refuses every shape that only looks bounded', () => {
    const listed = (use) => `readdirSync(FIXTURES).forEach((f) => ${use});`;
    const cases = {
      // The helper has callers this file does not show.
      'an exported helper': ["export const read = (p) => readFileSync(join(FIXTURES, p));\nread('f0.json');", leaves('server/lib/fixtures')],
      'a helper handed on': ["const read = (p) => readFileSync(join(FIXTURES, p));\nread('f0.json'); register(read);", through('read', 'server/lib/fixtures')],
      'a helper stored': ["const read = (p) => readFileSync(join(FIXTURES, p));\nconst api = { read };\nread('f0.json');", through('read', 'server/lib/fixtures')],
      'a helper declared twice': ["let read = (p) => readFileSync(join(FIXTURES, p));\nread('f0.json');\nif (flag) { const read = other; }", through('read', 'server/lib/fixtures')],
      'a spread call': ["const read = (p) => readFileSync(join(FIXTURES, p));\nread(...args);", through('read', 'server/lib/fixtures')],
      'a call with no argument': ["const read = (p) => readFileSync(join(FIXTURES, p));\nread();", through('read', 'server/lib/fixtures')],
      'a default parameter': ["const read = (name, dir = 'fixtures') => readFileSync(join(HERE, dir, name));\nread('f0.json');", leaves('server/lib')],
      'a destructured parameter': ["const read = ({ name }) => readFileSync(join(FIXTURES, name));\nread({ name: 'f0.json' });", leaves('server/lib/fixtures')],
      'a parameter reassigned by an inner declaration': ["const read = (p) => { if (flag) { const p = pick(); return readFileSync(join(FIXTURES, p)); } };\nread('f0.json');", through('read', 'server/lib/fixtures')],
      'a parameter assigned in the body': ["const read = (p) => { p = pick(); return readFileSync(join(FIXTURES, p)); };\nread('f0.json');", through('read', 'server/lib/fixtures')],
      'a parameter appended to in the body': ["const read = (p) => { p += '/../../a.js'; return readFileSync(join(FIXTURES, p)); };\nread('f0.json');", through('read', 'server/lib/fixtures')],
      'a parameter overwritten by an object pattern': ["const read = (p) => { ({ p } = pick()); return readFileSync(join(FIXTURES, p)); };\nread('f0.json');", through('read', 'server/lib/fixtures')],
      'a parameter overwritten by an array pattern': ["const read = (p) => { [p] = pick(); return readFileSync(join(FIXTURES, p)); };\nread('f0.json');", through('read', 'server/lib/fixtures')],
      'an argument bound by let and assigned again': ["let name = 'f0.json';\nname = 'f1.json';\nconst read = (p) => readFileSync(join(FIXTURES, p));\nread(name);", through('read', 'server/lib/fixtures')],
      'an argument whose name an inner scope declares again': ["const NAME = 'f0.json';\nconst read = (p) => readFileSync(join(FIXTURES, p));\nfunction run(row) { const { NAME } = row; read(NAME); }", through('read', 'server/lib/fixtures')],
      'a segment assigned by a loop head': ["let name = 'f0.json';\nfor (name of [process.argv[2]]) { if (ok(name)) break; }\nreadFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a segment assigned by a pattern in a loop head': ["let name = 'f0.json';\nfor ({ name } of rows) { if (ok(name)) break; }\nreadFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a segment assigned in parentheses': ["let name = 'f0.json';\n(name) = process.argv[2];\nreadFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a segment a second declarator declares again': ["const name = 'f0.json';\nit('y', () => { const a = 1, name = process.argv[2]; readFileSync(join(FIXTURES, name)); });", leaves('server/lib/fixtures')],
      'a segment an import also names': ["import { name } from './names.js';\nit('a', () => { const name = 'f0.json'; use(name); });\nit('b', () => { readFileSync(join(FIXTURES, name)); });", leaves('server/lib/fixtures')],
      'a literal discarded by a comma': ["readFileSync(join(FIXTURES, ('f0.json', process.argv[2])));", leaves('server/lib/fixtures')],
      'a module constant under a loop variable of its name': ["const name = 'f0.json';\nfor (const name of [process.argv[2]]) if (true) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a call the tokenizer reads as text': ["function read(name) { return readFileSync(join(FIXTURES, name)); }\nif (x) { read('f0.json'); }\n/[`]/.test(s) && read(process.argv[2]); const t = `x`;", through('read', 'server/lib/fixtures')],
      'a call through .call inside an eval': ["const read = (n) => readFileSync(join(FIXTURES, n));\nread('f0.json');\neval(\"read.call(null, process.argv[2])\");", through('read', 'server/lib/fixtures')],
      // The price of not trusting the tokenizer with comments: one that spells a call costs the resolution.
      'a call spelled in a comment': ["const read = (n) => readFileSync(join(FIXTURES, n));\nread('f0.json');\n// read(process.argv[2]) is what the tokenizer could have missed", through('read', 'server/lib/fixtures')],
      'a call inside an eval': ["const read = (n) => readFileSync(join(FIXTURES, n));\nread('f0.json');\neval(\"read(process.argv[2])\");", through('read', 'server/lib/fixtures')],
      'a segment assigned by a parenthesized loop target': ["let name = 'f0.json';\nfor ((name) of [process.argv[2]]);\nreadFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a segment assigned inside an eval': ["let name = 'f0.json';\neval(\"name = process.argv[2]\");\nreadFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a segment declared again after a tagged template': ["const name = 'f0.json';\nit('y', () => { const a = String.raw`x`, name = process.argv[2]; readFileSync(join(FIXTURES, name)); });", leaves('server/lib/fixtures')],
      'a block after an arrow with no semicolon': ["const name = process.argv[2]\nconst read = (name) => readFileSync(join(FIXTURES, name))\n{\n  readFileSync(join(FIXTURES, name))\n}\nread('f0.json')", leaves('server/lib/fixtures')],
      'a call the tokenizer reads as a comment': ["function read(name) { return readFileSync(join(FIXTURES, name)); }\nif (x) { read('f0.json'); }\n/a\\//.test(s) || read(process.argv[2]);", through('read', 'server/lib/fixtures')],
      'a call through an escaped identifier': ["const read = (n) => readFileSync(join(FIXTURES, n));\nread('f0.json');\nr\\u0065ad(process.argv[2]);", through('read', 'server/lib/fixtures')],
      'a segment bound by let and assigned again': ["let name = 'f0.json';\nname = process.argv[2];\nreadFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a parameter of a function that touches arguments': ["function read(p) { arguments[0] = pick(); return readFileSync(join(FIXTURES, p)); }\nread('f0.json');", through('read', 'server/lib/fixtures')],
      'a parameter of a function with eval in a nested template': ["function read(p) { const value = `outer ${`inner ${eval(code)}`}`; return readFileSync(join(FIXTURES, p)); }\nread('f0.json');\nother.eval;", through('read', 'server/lib/fixtures')],
      'a literal with a method call on it': ["readFileSync(join(FIXTURES, 'F0.JSON'.toLowerCase()));", leaves('server/lib/fixtures')],
      'the same name bound twice, one inside the other': ["const read = (f) => ['f1.json'].map((f) => readFileSync(join(FIXTURES, f)));\nread('f0.json');", leaves('server/lib/fixtures')],
      'a parameter redeclared by an inner pattern': ["const read = (p) => { if (flag) { const { p } = pick(); return readFileSync(join(FIXTURES, p)); } };\nread('f0.json');", through('read', 'server/lib/fixtures')],
      'a spread before the argument': ["const read = (label, name) => readFileSync(join(FIXTURES, name));\nread(...labels, 'f0.json');", through('read', 'server/lib/fixtures')],
      'a literal argument with a method call on it': ["const read = (p) => readFileSync(join(FIXTURES, p));\nread('xf0.json'.slice(1));", through('read', 'server/lib/fixtures')],
      'a literal row with a method call on it': ["for (const name of ['xf0.json'.slice(1)]) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      // Not a literal and not a listed name.
      'a property of something': ["readFileSync(join(FIXTURES, entry.file));", leaves('server/lib/fixtures')],
      'a call result': ["readFileSync(join(FIXTURES, pick()));", leaves('server/lib/fixtures')],
      'a table row that is not a string': ["it.each([['f0.json', 1]])('%s', (name) => { readFileSync(join(FIXTURES, name)); });", leaves('server/lib/fixtures')],
      'a table of something that is not the test API': ["rows.each(['f0.json'])('%s', (name) => { readFileSync(join(FIXTURES, name)); });", leaves('server/lib/fixtures')],
      'the index a callback is given, not the element': ["['f0.json'].forEach((name, other) => readFileSync(join(FIXTURES, other)));", leaves('server/lib/fixtures')],
      'a table with a computed row': ["for (const name of ['f0.json', pick()]) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an array that gains an element': ["const NAMES = ['f0.json'];\nNAMES.push(process.argv[2]);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an array with an element assigned': ["const NAMES = ['f0.json'];\nNAMES[0] = process.argv[2];\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an array literal with an empty slot': ["for (const name of ['f0', , 'f1']) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'a const array with an empty slot': ["const NAMES = ['f0', , 'f1'];\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'a const array with a leading empty slot': ["const NAMES = [, 'f1'];\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'a frozen array with an empty slot': ["const NAMES = Object.freeze(['f0', , 'f1']);\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'a table with an empty slot': ["it.each(['f0', , 'f1'])('x', (name) => { readFileSync(join(FIXTURES, `${name}.json`)); });", leaves('server/lib/fixtures')],
      'an array with an element deleted': ["const NAMES = ['f0', 'f1'];\ndelete NAMES[1];\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'an array with an element deleted in parentheses': ["const NAMES = ['f0', 'f1'];\ndelete (NAMES[1]);\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'an array with an element deleted for its value': ["const NAMES = ['f0', 'f1'];\nvoid delete NAMES[0];\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'an array with an element incremented in parentheses': ["const NAMES = ['f0', 'f1'];\n++(NAMES[5]);\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'an array lengthened by an update': ["const NAMES = ['f0', 'f1'];\nNAMES.length++;\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'an array lengthened by a prefix update': ["const NAMES = ['f0', 'f1'];\n++NAMES.length;\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'an array lengthened in parentheses': ["const NAMES = ['f0', 'f1'];\n++(NAMES.length);\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'an array whose length is assigned in parentheses': ["const NAMES = ['f0', 'f1'];\n(NAMES.length) = 5;\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'an array element assigned by a loop head': ["const NAMES = ['f0', 'f1'];\nfor (NAMES[0] of other) {}\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'an array element assigned by a loop head in parentheses': ["const NAMES = ['f0', 'f1'];\nfor ((NAMES[0]) of other) {}\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'an array lengthened by a loop head': ["const NAMES = ['f0', 'f1'];\nfor (NAMES.length of sizes) {}\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'an array lengthened by a loop head in parentheses': ["const NAMES = ['f0', 'f1'];\nfor ((NAMES.length) of sizes) {}\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'an array element assigned through a parenthesized pattern': ["const NAMES = ['f0', 'f1'];\n[(NAMES[0])] = pair;\nfor (const name of NAMES) readFileSync(join(FIXTURES, `${name}.json`));", leaves('server/lib/fixtures')],
      'a parameter updated in parentheses': ["const read = (p) => { (p)++; return readFileSync(join(FIXTURES, `${p}.json`)); };\nread('f0');", through('read', 'server/lib/fixtures')],
      'a parameter updated by a prefix in parentheses': ["const read = (p) => { ++(p); return readFileSync(join(FIXTURES, `${p}.json`)); };\nread('f0');", through('read', 'server/lib/fixtures')],
      'a parameter assigned through a parenthesized pattern': ["const read = (p) => { [(p)] = ['zz']; return readFileSync(join(FIXTURES, `${p}.json`)); };\nread('f0');", through('read', 'server/lib/fixtures')],
      'a parameter assigned through a parenthesized property': ["const read = (p) => { ({ a: (p) } = { a: 'zz' }); return readFileSync(join(FIXTURES, `${p}.json`)); };\nread('f0');", through('read', 'server/lib/fixtures')],
      'an array whose iteration callback takes every argument': ["const NAMES = ['f0.json'];\nNAMES.forEach((...all) => all[2].push(process.argv[2]));\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an array whose iteration callback takes the array': ["const NAMES = ['f0.json'];\nNAMES.forEach((name, i, all) => all.push(process.argv[2]));\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an array iterated by a function with its own arguments': ["const NAMES = ['f0.json'];\nNAMES.forEach(function () { arguments[2].push(process.argv[2]); });\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an array iterated by a helper that takes the array': ["const grow = (name, i, all) => all.push(process.argv[2]);\nconst NAMES = ['f0.json'];\nNAMES.forEach(grow);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an array reduced by a callback that takes the array': ["const NAMES = ['f0.json'];\nNAMES.reduce((sum, name, i, all) => all.push(process.argv[2]), 0);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a listed array whose iteration callback takes the array': ["const FILES = readdirSync(FIXTURES);\nFILES.some((f, i, all) => all.push(process.argv[2]));\nfor (const f of FILES) readFileSync(join(FIXTURES, f));", leaves('server/lib/fixtures')],
      'an array written through the array a method returns': ["const NAMES = ['f0.json'];\nNAMES.sort().push(process.argv[2]);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an array aliased by valueOf': ["const NAMES = ['f0.json'];\nconst same = NAMES.valueOf();\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a frozen array an inner scope declares again': ["const NAMES = Object.freeze(['f0.json']);\nfunction run(row) { const { NAMES } = row; for (const name of NAMES) readFileSync(join(FIXTURES, name)); }", leaves('server/lib/fixtures')],
      'a value with a windows separator': ["const read = (p) => readFileSync(join(FIXTURES, p));\nread('sub\\\\f0.json');", leaves('server/lib/fixtures')],
      'an array filtered by a callback that takes the array': ["['f0.json', 'f1.json'].filter((n, i, all) => { all[1] = process.argv[2]; return true; }).forEach((name) => readFileSync(join(FIXTURES, name)));", leaves('server/lib/fixtures')],
      'an array iterated by a callback that takes the array': ["['f0.json', 'f1.json'].forEach((name, i, all) => { all[1] = process.argv[2]; readFileSync(join(FIXTURES, name)); });", leaves('server/lib/fixtures')],
      'an array iterated by a function, which has arguments': ["['f0.json'].forEach(function (name) { arguments[2][1] = process.argv[2]; readFileSync(join(FIXTURES, name)); });", leaves('server/lib/fixtures')],
      'a listing mapped by a helper that takes the array': ["const read = (f, i, all) => { all[i + 1] = process.argv[2]; return readFileSync(join(FIXTURES, f)); };\nconst texts = readdirSync(FIXTURES).map(read);", through('read', 'server/lib/fixtures')],
      'an element assigned through a pattern': ["const NAMES = ['f0.json'];\n([NAMES[0]] = [process.argv[2]]);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an adding method called by computed name': ["const NAMES = ['f0.json'];\nNAMES['push'](process.argv[2]);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an array handed alone to an each that is not the test API': ["const NAMES = ['f0.json'];\nrows.each(NAMES);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an array handed to an each that is not the test API': ["const NAMES = ['f0.json'];\nrows.each(NAMES, grow);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an unfrozen copy of a frozen array': ["const NAMES = Object.freeze(['f0.json']).slice();\nNAMES.push(process.argv[2]);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an optional call of an iteration method': ["const NAMES = ['f0.json'];\nNAMES.forEach?.((n, i, all) => { all.push(process.argv[2]); });\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an optional call by computed name': ["const NAMES = ['f0.json'];\nNAMES['push']?.(process.argv[2]);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a callback that was given another function': ["const NAMES = ['f0.json'];\nlet cb = (n) => n;\ncb = (n, i, all) => { all.push(process.argv[2]); };\nNAMES.forEach(cb);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a replacer bound to the array': ["const NAMES = ['f0.json'];\nJSON.stringify(NAMES, function (k, v) { this.push?.(process.argv[2]); return v; });\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a mapper bound to the array': ["const NAMES = ['f0.json'];\nArray.from(NAMES, function () { this.push(process.argv[2]); }, NAMES);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a local function named expect': ["const NAMES = ['f0.json'];\nfunction expect(list) { list.push(process.argv[2]); return { toHaveLength() {} }; }\nexpect(NAMES).toHaveLength(2);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an array whose method was replaced': ["const NAMES = ['f0.json'];\nNAMES.map = (cb) => cb(process.argv[2]);\nNAMES.map((name) => readFileSync(join(FIXTURES, name)));", leaves('server/lib/fixtures')],
      'an index into an object that only looks like an array': ["const table = { 'f0.json': [process.argv[2]] }\n['f0.json'].forEach((name) => readFileSync(join(FIXTURES, name)))", leaves('server/lib/fixtures')],
      'an array handed to a matcher that calls back': ["const NAMES = ['f0.json'];\nexpect(NAMES).toSatisfy((list) => list.push(process.argv[2]));\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an array handed to expect and kept': ["const NAMES = ['f0.json'];\nconst held = expect(NAMES);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a var loop variable assigned after the loop': ["for (var name of ['f0.json']) { it('reads', () => readFileSync(join(FIXTURES, name))); }\nname = process.argv[2];", leaves('server/lib/fixtures')],
      'a loop variable with no declaration': ["let name;\nfor (name of ['f0.json']) { it('reads', () => readFileSync(join(FIXTURES, name))); }\nname = process.argv[2];", leaves('server/lib/fixtures')],
      'an array frozen by a local Object': ["const Object = { freeze: (xs) => [...xs, process.argv[2]] };\nconst NAMES = Object.freeze(['f0.json']);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a literal frozen by a local Object': ["const Object = { freeze: (xs) => [...xs, process.argv[2]] };\nfor (const name of Object.freeze(['f0.json'])) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      // A parameter or loop variable named like a module-level directory is that directory only when every call passes it.
      'a directory parameter called with two directories': ["const read = (FIXTURES) => readFileSync(join(FIXTURES, 'f0.json'));\nread(FIXTURES); read(HERE);", through('read', 'server/lib/fixtures')],
      'a directory parameter called with an unknown directory': ["const read = (FIXTURES) => readFileSync(join(FIXTURES, 'f0.json'));\nread(process.argv[2]);", through('read', 'server/lib/fixtures')],
      'a directory parameter of an exported helper': ["export const read = (FIXTURES) => readFileSync(join(FIXTURES, 'f0.json'));\nread(FIXTURES);", leaves('server/lib/fixtures')],
      'a directory parameter assigned in the body': ["const read = (FIXTURES) => { FIXTURES = pick(); return readFileSync(join(FIXTURES, 'f0.json')); };\nread(FIXTURES);", through('read', 'server/lib/fixtures')],
      'a directory parameter of a helper handed on': ["const read = (FIXTURES) => readFileSync(join(FIXTURES, 'f0.json'));\nread(FIXTURES); register(read);", through('read', 'server/lib/fixtures')],
      'a directory parameter after a spread argument': ["const read = (skip, FIXTURES) => readFileSync(join(FIXTURES, 'f0.json'));\nread(...none, FIXTURES);", through('read', 'server/lib/fixtures')],
      'a directory parameter called with a listed directory': ["const read = (FIXTURES) => readFileSync(join(FIXTURES, 'f0.json'));\nfor (const d of readdirSync(HERE)) read(join(HERE, d));", through('read', 'server/lib/fixtures')],
      'a directory parameter of a callback': ["dirs.forEach((FIXTURES) => readFileSync(join(FIXTURES, 'f0.json')));", leaves('server/lib/fixtures')],
      'a directory loop variable': ["for (const FIXTURES of dirs) readFileSync(join(FIXTURES, 'f0.json'));", leaves('server/lib/fixtures')],
      'a directory parameter of a method': ["const api = { read(FIXTURES) { return readFileSync(join(FIXTURES, 'f0.json')); } };\napi.read(FIXTURES);", leaves('server/lib/fixtures')],
      'a local arrow named expect': ["const NAMES = ['f0.json'];\nconst expect = (list) => { list.push(process.argv[2]); return { toHaveLength() {} }; };\nexpect(NAMES).toHaveLength(2);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a local arrow named Boolean': ["const NAMES = ['f0.json'];\nconst Boolean = (v, i, all) => { all.push(process.argv[2]); return true; };\nNAMES.filter(Boolean);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an element assigned in parentheses': ["const NAMES = ['f0.json'];\n(NAMES[1]) = process.argv[2];\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a method replaced through a pattern': ["const NAMES = ['f0.json'];\n({ map: NAMES.map } = { map: (cb) => cb(process.argv[2]) });\nNAMES.map((name) => readFileSync(join(FIXTURES, name)));", leaves('server/lib/fixtures')],
      'an array handed to unknown code': ["const NAMES = ['f0.json'];\nfill(NAMES);\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'an exported array': ["export const NAMES = ['f0.json'];\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'a rebindable array': ["let NAMES = ['f0.json'];\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));", leaves('server/lib/fixtures')],
      'more values than are worth resolving': [`const NAMES = [${Array.from({ length: 65 }, (_, i) => `'f${i}.json'`).join(', ')}];\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));`, leaves('server/lib/fixtures')],
      // A listed name that is changed, replaced or followed by a climb.
      'a listed name rewritten': [listed("readFileSync(join(FIXTURES, f.replace('a', '../')))"), leaves('server/lib/fixtures')],
      'a listed name indexed': [listed('readFileSync(join(FIXTURES, f[0]))'), leaves('server/lib/fixtures')],
      'a listed name in a ternary': [listed("readFileSync(join(FIXTURES, f === 'f0.json' ? '../../a.js' : f))"), leaves('server/lib/fixtures')],
      'a listed name and-ed away': [listed('readFileSync(join(FIXTURES, f && other))'), leaves('server/lib/fixtures')],
      'a listed name discarded by a comma': [listed('readFileSync(join(FIXTURES, (f, other)))'), leaves('server/lib/fixtures')],
      'a listed name discarded by a comma in a template hole': [listed('readFileSync(`${FIXTURES}/${f, other}`)'), leaves('server/lib/fixtures')],
      'a listed name in a template hole with more in it': [listed('readFileSync(`${FIXTURES}/${f || other}`)'), leaves('server/lib/fixtures')],
      'a climb after a listed name': [listed("readFileSync(join(FIXTURES, f, '..', '..', 'a.js'))"), leaves('server/lib/fixtures')],
      'a climb written into the template': [listed('readFileSync(`${FIXTURES}/${f}/../../a.js`)'), leaves('server/lib/fixtures')],
      'a climb split across two literals': [listed("readFileSync(join(FIXTURES, f + '/.' + './../a.js'))"), leaves('server/lib/fixtures')],
      'a windows climb after a listed name': [listed("readFileSync(join(FIXTURES, f + '\\\\..\\\\..\\\\a.js'))"), leaves('server/lib/fixtures')],
      'a windows climb written before a listed name': [listed("readFileSync(join(HERE, 'fixtures\\\\..\\\\..\\\\' + f))"), leaves('server/lib')],
      'a listed name assigned in its loop': ["for (let f of readdirSync(FIXTURES)) { f = process.argv[2]; readFileSync(join(FIXTURES, f)); }", leaves('server/lib/fixtures')],
      'a listed name after an unknown directory': [listed('readFileSync(join(FIXTURES, entry.dir, f))'), leaves('server/lib/fixtures')],
      'a climbing URL relative to a listed entry': [listed("readFileSync(new URL('../../a.js', pathToFileURL(join(FIXTURES, f))))"), leaves('server/lib/fixtures')],
      'the parent of a listed entry': [listed('readdirSync(dirname(join(FIXTURES, f)))'), leaves('server/lib/fixtures')],
      'the grandparent of a listed entry': [listed("readFileSync(join(dirname(dirname(join(FIXTURES, f))), 'a.js'))"), leaves('server/lib/fixtures')],
      'the parent of a guarded join': ["readFileSync(join(dirname(pathWithin(FIXTURES, pick())), 'a.js'));", leaves('server/lib/fixtures')],
      'a URL beside a guarded join': ["readFileSync(new URL('a.js', pathToFileURL(pathWithin(FIXTURES, pick()))));", leaves('server/lib/fixtures')],
      'an encoded climb relative to a listed entry': [listed("readFileSync(new URL('%2e%2e/a.js', pathToFileURL(join(FIXTURES, f))))"), leaves('server/lib/fixtures')],
      'a climb spelled across three literals': [listed("readFileSync(join(FIXTURES, f) + '/.' + './.' + './a.js')"), leaves('server/lib/fixtures')],
      'a listing by a second declarator of the imported name': ["it('y', () => { const a = 1, readdirSync = () => [pick()]; for (const f of readdirSync(FIXTURES)) readFileSync(join(FIXTURES, f)); });", leaves('server/lib/fixtures')],
      'a listing through a namespace that was written to': ["fs.readdirSync = () => [pick()];\nfor (const f of fs.readdirSync(FIXTURES)) readFileSync(join(FIXTURES, f));", leaves('server/lib/fixtures')],
      'a listing through a namespace that was handed on': ["Object.assign(fs, { readdirSync: () => [pick()] });\nfor (const f of fs.readdirSync(FIXTURES)) readFileSync(join(FIXTURES, f));", leaves('server/lib/fixtures')],
      'a suffix glued onto a guarded join': ["readFileSync(pathWithin(FIXTURES, pick()) + '.json');", leaves('server/lib/fixtures')],
      'a URL built from text with URL syntax in it': ["const read = (n) => readFileSync(new URL(pathToFileURL(FIXTURES).href + '/' + n));\nread('f0.json?raw');", leaves('server/lib/fixtures')],
      'a URL of a path with a hash in its name': ["readFileSync(new URL(pathToFileURL(join(FIXTURES, 'a#b.json'))));", leaves('server/lib/fixtures')],
      'a listing through a namespace member that was written to': ["fs.promises.readdir = async () => [pick()];\nfor (const f of await fs.promises.readdir(FIXTURES)) readFileSync(join(FIXTURES, f));", leaves('server/lib/fixtures')],
      'a listing through a namespace that was aliased': ["const p = fs.promises;\np.readdir = async () => [pick()];\nfor (const f of await fs.promises.readdir(FIXTURES)) readFileSync(join(FIXTURES, f));", leaves('server/lib/fixtures')],
      'a listing by a declarator after a function expression': ["it('y', () => { const a = function f() {}, readdirSync = () => [pick()]; for (const f of readdirSync(FIXTURES)) readFileSync(join(FIXTURES, f)); });", leaves('server/lib/fixtures')],
      'a guard declared after a class expression': ["it('y', () => { const A = class A {}, pathWithin = (d, s) => join(d, s); readFileSync(pathWithin(FIXTURES, pick())); });", leaves('server/lib/fixtures')],
      'a guard the file mocks': ["vi.mock('../../scripts/lib/pathWithin.js', () => ({ pathWithin: (d, s) => join(d, s) }));\nreadFileSync(pathWithin(FIXTURES, pick()));", leaves('server/lib/fixtures')],
      'a listed name glued to the directory': [listed('readFileSync(`${FIXTURES}${f}`)'), leaves('server/lib/fixtures')],
      'a listed name as a URL': [listed('readFileSync(new URL(f, import.meta.url))'), leaves('server/lib')],
      'a listed name under a URL directory': [listed('readFileSync(new URL(`./fixtures/${f}`, import.meta.url))'), leaves('server/lib/fixtures')],
      'mapped names': ["readdirSync(FIXTURES).map((f) => f.slice(1)).forEach((f) => readFileSync(join(FIXTURES, f)));", leaves('server/lib/fixtures')],
      'directory entries, not names': ["for (const f of readdirSync(FIXTURES, { withFileTypes: true })) readFileSync(join(FIXTURES, f));", leaves('server/lib/fixtures')],
      'a listing by some other readdir': ["for (const f of store.readdir()) readFileSync(join(FIXTURES, f));", leaves('server/lib/fixtures')],
      'a listing by a local of the imported name': ["function run(list) { const readdirSync = list; for (const f of readdirSync(FIXTURES)) readFileSync(join(FIXTURES, f)); }", leaves('server/lib/fixtures')],
      'an id from a parameter named randomUUID': ["const read = (randomUUID) => readFileSync(join(HERE, `fixtures/${randomUUID()}`));\nread(() => '../a.js');", leaves('server/lib/fixtures')],
      'a join through a parameter named pathWithin': ["function run(pathWithin) { return readFileSync(pathWithin(FIXTURES, process.argv[2])); }", leaves('server/lib/fixtures')],
      'a listing by a shadowed readdirSync': ["function listAll(readdirSync) { for (const f of readdirSync(FIXTURES)) readFileSync(join(FIXTURES, f)); }", leaves('server/lib/fixtures')],
      'a listed array that gains an element': ["const FILES = readdirSync(FIXTURES);\nFILES.unshift(process.argv[2]);\nfor (const f of FILES) readFileSync(join(FIXTURES, f));", leaves('server/lib/fixtures')],
      // A guard is trusted only around the directory it guards.
      'a guarded join under an unknown directory': ["readFileSync(pathWithin(join(FIXTURES, entry.dir), 'f0.json'));", leaves('server/lib/fixtures')],
      'a guarded join with a climb after it': ["readFileSync(join(pathWithin(FIXTURES, process.argv[2]), '..', '..', 'a.js'));", leaves('server/lib/fixtures')],
    };
    for (const [label, [body, reason]] of Object.entries(cases)) {
      expect(floorOf(body), label).toMatchObject({ memoizable: false, key: null });
      expect(floorOf(body).reasons, label).toContain(reason);
    }
  });

  it('trusts readdir, randomUUID and pathWithin only as imported from the modules that define them', () => {
    const guessed = (...lines) => [...new Set(extractFileFacts(lines.join('\n'), { fileRel: test, cwdRel: 'server' }).dirs
      .filter((dir) => dir.guessed).map((dir) => `${dir.rel}: ${dir.open ? 'unbounded' : 'contained'}`))];
    const contained = ['server/lib/fixtures: contained'];
    const unbounded = ['server/lib/fixtures: unbounded'];
    const listing = "for (const f of readdirSync(join(__dirname, 'fixtures'))) readFileSync(join(__dirname, 'fixtures', f));";
    expect(guessed("import { readdirSync, readFileSync } from 'node:fs';", listing)).toEqual(contained);
    expect(guessed("import { readdirSync as list } from 'fs';", listing.replace('readdirSync(', 'list('))).toEqual(contained);
    expect(guessed("const { readdirSync } = require('node:fs');", listing)).toEqual(contained);
    expect(guessed("import { promises as fsp } from 'node:fs';", listing.replace('readdirSync(', 'await fsp.readdir('))).toEqual(contained);
    expect(guessed(listing)).toEqual(unbounded);
    expect(guessed("import { readdirSync } from './fakeFs.js';", listing)).toEqual(unbounded);
    expect(guessed("import { readdirSync } from 'node:fs';", listing.replace('readdirSync(', 'store.readdirSync('))).toEqual(unbounded);
    const named = "const probe = existsSync(join(__dirname, 'fixtures', `${randomUUID()}.json`));";
    expect(guessed("import { randomUUID } from 'node:crypto';", named)).toEqual(contained);
    expect(guessed("import { randomUUID } from './ids.js';", named)).toEqual(unbounded);
    expect(guessed("import { randomUUID as id } from 'node:crypto';", named)).toEqual(unbounded);
    expect(guessed("import * as nodeCrypto from 'node:crypto';", "import { randomUUID } from 'node:crypto';", "vi.spyOn(nodeCrypto, 'randomUUID').mockReturnValue('../../a');", named)).toEqual(unbounded);
    const guard = "const read = (name) => readFileSync(pathWithin(join(__dirname, 'fixtures'), name));\nread(process.argv[2]);";
    expect(guessed("import { pathWithin } from '../../scripts/lib/pathWithin.js';", guard)).toEqual(contained);
    // The guard imported without its extension is the guard; mocked, it is refused (above).
    expect(guessed("import { pathWithin } from '../../scripts/lib/pathWithin';", guard)).toEqual(contained);
    // Any other function of that name is an unknown call, as it always was: no directory is claimed for it.
    // A module the file mocks or spies on returns what the test tells it to.
    expect(guessed("import { readdirSync, readFileSync } from 'node:fs';", "vi.mock('node:fs', () => ({ readdirSync: () => ['../../a.js'] }));", listing)).toEqual(unbounded);
    expect(guessed("import fs, { readdirSync } from 'node:fs';", "vi.spyOn(fs, 'readdirSync').mockReturnValue(['../../a.js']);", listing)).toEqual(unbounded);
    expect(guessed("import { randomUUID } from 'node:crypto';", "vi.mock('node:crypto', () => ({ randomUUID: () => '../../a' }));", named)).toEqual(unbounded);
    expect(guessed("import { pathWithin } from '../../scripts/lib/pathWithin.js';", "vi.mock('../../scripts/lib/pathWithin.js', () => ({ pathWithin: (dir, name) => join(dir, name) }));", guard)).toEqual(unbounded);
    // However the module is named: an import() promise, a template, a path with no extension.
    expect(guessed("import { readdirSync, readFileSync } from 'node:fs';", "vi.mock(import('node:fs'), async (original) => ({ ...(await original()), readdirSync: () => ['../../a.js'] }));", listing)).toEqual(unbounded);
    expect(guessed("import { randomUUID } from 'node:crypto';", "vi.mock(`node:crypto`, () => ({ randomUUID: () => '../../a' }));", named)).toEqual(unbounded);
    expect(guessed("import { pathWithin } from '../../scripts/lib/pathWithin.js';", "vi.mock('../../scripts/lib/pathWithin', () => ({ pathWithin: (dir, name) => join(dir, name) }));", guard)).toEqual(unbounded);
    for (const imported of ["import { pathWithin } from './pathWithin.js';", "import { join as pathWithin } from '../../scripts/lib/pathWithin.js';", 'const pathWithin = (dir, name) => join(dir, name);']) {
      expect(guessed(imported, guard), imported).toEqual([]);
    }
  });

  it('trusts nothing a setup file or an imported helper mocks', () => {
    const generated = "const probe = existsSync(join(FIXTURES, `${randomUUID()}.json`));";
    const mock = "vi.mock('node:crypto', () => ({ randomUUID: () => '../../a' }));\n";
    expect(floorOf(generated).memoizable).toBe(true);
    // The workspace setup file, or a module it imports: mocked for every test.
    expect(floorOf(generated, { 'server/vitest.setup.js': mock })).toMatchObject({ memoizable: false, reason: leaves('server/lib/fixtures') });
    expect(floorOf(generated, { 'server/vitest.setup.js': "import './test/mocks.js';\n", 'server/test/mocks.js': mock }))
      .toMatchObject({ memoizable: false, reason: leaves('server/lib/fixtures') });
    // A helper the test imports registers its mock for the test as well.
    expect(floorOf(`import './mocks.js';\n${generated}`, { 'server/lib/mocks.js': mock }))
      .toMatchObject({ memoizable: false, reason: `${test}: relies on randomUUID(), which server/lib/mocks.js mocks` });
    expect(floorOf(`import './mocks.js';\n${generated}`, { 'server/lib/mocks.js': 'export const unrelated = 1;\n' }).memoizable).toBe(true);
    // A replaced guard returns what it likes, whatever it is handed: literal segments, a listed
    // directory, a result that is joined on. Each is a path this file only has the guard's word for.
    const guardMock = "vi.mock('../../scripts/lib/pathWithin.js', () => ({ pathWithin: () => '/elsewhere/a.js' }));\n";
    for (const read of [
      "readFileSync(pathWithin(FIXTURES, 'f0.json'));",
      "readFileSync(join(pathWithin(HERE, 'fixtures'), 'f0.json'));",
      'for (const d of readdirSync(HERE)) readFileSync(pathWithin(join(HERE, d), process.argv[2]));',
      'readFileSync(pathWithin(FIXTURES, process.argv[2]));',
    ]) {
      expect(floorOf(`import './mocks.js';\n${read}`, { 'server/lib/mocks.js': guardMock }), read)
        .toMatchObject({ memoizable: false, reason: `${test}: relies on pathWithin(), which server/lib/mocks.js mocks` });
      expect(floorOf(`import './mocks.js';\n${read}`, { 'server/lib/mocks.js': 'export const unrelated = 1;\n' }).memoizable, read).toBe(true);
    }
  });

  it('never drops a read the scope rules took the constant away from', () => {
    // A text constant is unknown where a parameter or a loop variable has its name. Read as a whole
    // path, unknown text is runtime data and no input, so the file the constant names stays keyed.
    const text = "const FILE = 'lib/fixtures/f0.json';\n";
    for (const body of [
      `${text}items.forEach((FILE) => FILE);\nreadFileSync(FILE);`,
      `${text}const read = (FILE) => readFileSync(FILE);\nread(FILE);`,
      `${text}const read = (FILE) => readFileSync(resolve(FILE));\nread(FILE);`,
      `${text}for (const FILE of items) readFileSync(FILE);`,
      "const STEM = 'lib/fixtures/f0';\nitems.forEach((STEM) => STEM);\nreadFileSync(`${STEM}.json`);",
      "const STEM = 'lib/fixtures/f0';\nconst read = (STEM) => readFileSync(`${STEM}.json`);\nread(STEM);",
    ]) {
      expect(keyedOn(body, 'server/lib/fixtures/f0.json'), body).toBe(true);
    }
    // Machine-local state stays what it was read as, too.
    const home = "const STATE = join(homedir(), '.state');\nconst read = (STATE) => readFileSync(join(STATE, 'a.json'));\nread(STATE);";
    expect(floorOf(home).memoizable).toBe(false);
  });

  it('counts a mock only against a read that relies on it, from a member that runs', () => {
    const generated = "const probe = existsSync(join(FIXTURES, `${randomUUID()}.json`));";
    const mock = "vi.mock('node:crypto', () => ({ randomUUID: () => '../../a' }));\n";
    // A script that names a lock file with a UUID reads nothing by it: the mock of a helper beside it takes no proof away.
    const tool = { 'scripts/tool.js': "import { randomUUID } from 'node:crypto';\nimport { renameSync } from 'node:fs';\nexport function retire(lockDir) {\n  const retired = `${lockDir}.retired-${randomUUID()}`;\n  renameSync(lockDir, retired);\n  return randomUUID();\n}\n" };
    expect(floorOf("import './mocks.js';\nimport { retire } from '../../scripts/tool.js';", { ...tool, 'server/lib/mocks.js': mock }).memoizable).toBe(true);
    // A test file this one only reads as text never runs here, so its mock is registered for nobody.
    const sibling = { 'server/lib/sibling.test.js': `import { vi } from 'vitest';\n${mock}` };
    expect(floorOf(`const text = readFileSync(join(HERE, 'sibling.test.js'), 'utf8');\n${generated}`, sibling).memoizable).toBe(true);
    expect(floorOf(`import './sibling.test.js';\n${generated}`, sibling))
      .toMatchObject({ memoizable: false, reason: `${test}: relies on randomUUID(), which server/lib/sibling.test.js mocks` });
  });

  it('refuses the recorded key too, a script the test imports, and a product module', () => {
    const open = "const read = (p) => readFileSync(join(HERE, p), 'utf8');\nread(process.argv[2]);";
    const recorded = keyOf(tree(open), test, { records: new Map([[test, [test]]]) }).recorded;
    expect(recorded).toMatchObject({ memoizable: false, reason: through('read', 'server/lib') });
    const member = (rel) => ({ [rel]: "export const read = (p) => readFileSync(new URL(`./fixtures/${p}`, import.meta.url));\n" });
    const tooling = floorOf("import { read } from '../../scripts/tool.js';", { ...member('scripts/tool.js'), 'scripts/fixtures/s0.json': '{}' });
    expect(tooling).toMatchObject({ memoizable: false, reason: 'scripts/tool.js: reads a path with a variable segment that can leave scripts/fixtures' });
    // A library module reads such a path wherever its caller's name or its own data lands, which no
    // key line follows: until #16660 it kept the prefix as a guess, so a test was skipped after the
    // file the module really read changed.
    const library = "import { read } from './reader.js';";
    expect(floorOf(library, member('server/lib/reader.js'))).toMatchObject({ memoizable: false, reason: 'server/lib/reader.js: reads a path with a variable segment that can leave server/lib/fixtures' });
    const recordedLibrary = keyOf(tree(library, member('server/lib/reader.js')), test, { records: new Map([[test, [test, 'server/lib/reader.js']]]) }).recorded;
    expect(recordedLibrary).toMatchObject({ memoizable: false, reason: 'server/lib/reader.js: reads a path with a variable segment that can leave server/lib/fixtures' });
    // An unresolved path in a helper still fails closed when its parameter shadows a directory constant.
    const shadowing = { 'server/lib/reader.js': "const HERE = dirname(fileURLToPath(import.meta.url));\nexport function read(HERE) { return readFileSync(join(HERE, 'fixtures/f0.json')); }\n" };
    expect(floorOf(library, shadowing)).toMatchObject({ memoizable: false, reason: 'server/lib/reader.js: reads a path with a variable segment that can leave server/lib' });
  });

  it('follows a variable module path only as far as it is bounded', () => {
    const load = (call) => `const load = (f) => import(pathToFileURL(join(HERE, 'mods', f)).href);\n${call}`;
    const mods = { 'server/lib/mods/m0.js': 'export const m = 0;\n' };
    const listed = load("await Promise.all(readdirSync(join(HERE, 'mods')).map(load));");
    expect(floorOf(listed, mods).memoizable).toBe(true);
    expect(floorOf(listed, { 'server/lib/mods/m0.js': 'export const m = 1;\n' }).key).not.toBe(floorOf(listed, mods).key);
    // Unbounded, the module may be anywhere: an edge the floor key does not know.
    expect(floorOf(load('load(process.argv[2]);'), mods)).toMatchObject({ memoizable: false, reason: `${test}: import() with a non-literal specifier` });
  });

  // #16660: a library module's unbounded read now refuses its importers too, so each shape a module
  // names a file with must be read exactly: another module's literal, a guarded join, a search path.
  describe('a name from another module, and the rule for every closure member', () => {
    const NAMES = 'server/lib/names.js';
    const READER = 'server/lib/reader.js';
    const importNames = "import { NAME, NAMES } from './names.js';";

    it('reads an imported string constant and an imported frozen array as the files they name', () => {
      const names = { [NAMES]: "export const NAME = 'f0.json';\nexport const NAMES = Object.freeze(['f0.json', `f1.json`]);\n" };
      for (const body of [`${importNames}\nreadFileSync(join(FIXTURES, NAME));`, `${importNames}\nconst read = (p) => readFileSync(join(FIXTURES, p));\nread(NAME);`]) {
        // Without the exporting module the name is unknown, as any other import is.
        expect(floorOf(body).reasons, body).toContain(body.includes('read(') ? through('read', 'server/lib/fixtures') : leaves('server/lib/fixtures'));
        expect(floorOf(body, names), body).toMatchObject({ memoizable: true });
        expect(floorOf(body, { ...names, 'server/lib/fixtures/f0.json': 'changed\n' }).key, body).not.toBe(floorOf(body, names).key);
        expect(floorOf(body, { ...names, 'server/lib/fixtures/f1.json': 'changed\n' }).key, body).toBe(floorOf(body, names).key);
      }
      const each = `${importNames}\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));`;
      for (const file of ['server/lib/fixtures/f0.json', 'server/lib/fixtures/f1.json']) {
        expect(floorOf(each, { ...names, [file]: 'changed\n' }).key, file).not.toBe(floorOf(each, names).key);
      }
      // Exact files: a new neighbour is not an input.
      expect(floorOf(each, { ...names, 'server/lib/fixtures/f2.json': '{}' }).key).toBe(floorOf(each, names).key);
      // A library module the test imports names the file it reads the same way.
      const reader = { ...names, [READER]: "import { NAME } from './names.js';\nexport const read = () => readFileSync(new URL(`./fixtures/${NAME}`, import.meta.url));\n" };
      const library = "import { read } from './reader.js';";
      expect(floorOf(library, reader).memoizable).toBe(true);
      expect(floorOf(library, { ...reader, 'server/lib/fixtures/f0.json': 'changed\n' }).key).not.toBe(floorOf(library, reader).key);
    });

    it('refuses an exported array that is not frozen and any initializer that is not the literal alone', () => {
      const cases = {
        'an exported array that is not frozen': "export const NAMES = ['f0.json'];\n",
        'a frozen array with a computed element': "export const NAMES = Object.freeze(['f0.json', pick()]);\n",
        'a frozen array with a hole': "export const NAMES = Object.freeze(['f0.json', , 'f1.json']);\n",
        'a frozen array of something more': "export const NAMES = Object.freeze(['f0.json']).concat(extra);\n",
        'a frozen variable': 'export const NAMES = Object.freeze(names);\n',
        'a re-export': "export { NAMES } from './other.js';\n",
      };
      const body = `${importNames}\nfor (const name of NAMES) readFileSync(join(FIXTURES, name));`;
      for (const [label, module] of Object.entries(cases)) {
        expect(floorOf(body, { [NAMES]: module }).reasons, label).toContain(leaves('server/lib/fixtures'));
      }
      const one = `${importNames}\nreadFileSync(join(FIXTURES, NAME));`;
      for (const module of ["export const NAME = 'f0' + '.json';\n", "export const NAME = 'xf0.json'.slice(1);\n", "export let NAME = 'f0.json';\n", 'export const NAME = `${stem}.json`;\n']) {
        expect(floorOf(one, { [NAMES]: module }).reasons, module).toContain(leaves('server/lib/fixtures'));
      }
      // A name the file binds again, and a module the file mocks, are not the export.
      const names = { [NAMES]: "export const NAME = 'f0.json';\n" };
      expect(floorOf(`${importNames}\nfunction run(NAME) { return readFileSync(join(FIXTURES, NAME)); }\nrun(pick());`, names).reasons).toContain(through('run', 'server/lib/fixtures'));
      expect(floorOf(`${importNames}\nvi.mock('./names.js', () => ({ NAME: '../../a.js' }));\nreadFileSync(join(FIXTURES, NAME));`, names).reasons).toContain(leaves('server/lib/fixtures'));
    });

    it('voids a library module\'s reading when the test mocks the module it relied on', () => {
      const reads = {
        'an imported constant': { [NAMES]: "export const NAME = 'f0.json';\n", [READER]: "import { NAME } from './names.js';\nexport const read = () => readFileSync(join(import.meta.dirname, 'fixtures', NAME));\n" },
        'a guarded join': {
          'lib/pathWithin.js': 'export const pathWithin = (dir, ...segments) => join(dir, ...segments);\n',
          [READER]: "import { pathWithin } from '../../lib/pathWithin.js';\nexport const read = (p) => readFileSync(pathWithin(join(import.meta.dirname, 'fixtures'), p));\n",
        },
      };
      const mocks = { 'an imported constant': ['./names.js', 'server/lib/names.js'], 'a guarded join': ['../../lib/pathWithin.js', 'lib/pathWithin.js'] };
      for (const [label, files] of Object.entries(reads)) {
        const library = "import { read } from './reader.js';";
        expect(floorOf(library, files), label).toMatchObject({ memoizable: true });
        expect(floorOf(library, { ...files, 'server/lib/fixtures/f0.json': 'changed\n' }).key, label).not.toBe(floorOf(library, files).key);
        const [spec, target] = mocks[label];
        expect(floorOf(`${library}\nvi.mock('${spec}', () => ({}));`, files).reasons, label).toContain(label === 'a guarded join'
          ? `${READER}: relies on pathWithin(), which ${test} mocks`
          : `${READER}: names a path through ${target}, which the test mocks`);
      }
      const setup = {
        ...reads['an imported constant'],
        'server/vitest.setup.js': "vi.mock('./lib/names', () => ({ NAME: 'f1.json' }));",
      };
      expect(floorOf("import { read } from './reader.js';", setup).reasons).toContain(
        `${READER}: names a path through ${NAMES}, which the test mocks`,
      );
      // A module the test mocks that names no read is no reason: only a keyed value depends on it.
      const unrelated = { [NAMES]: "export const NAME = 'f0.json';\n", [READER]: "import { NAME } from './names.js';\nexport const label = () => NAME.toUpperCase();\n" };
      expect(floorOf("import { label } from './reader.js';\nvi.mock('./names.js', () => ({}));", unrelated).memoizable).toBe(true);
    });

    it('keys a directory put on a search path, and refuses one glued to anything else', () => {
      const guard = (delimiter) => ({
        'server/lib/bin/tool': 'tool v1\n',
        [READER]: [`${delimiter}`, 'const HERE = dirname(fileURLToPath(import.meta.url));', "export const BIN = join(HERE, 'bin');", 'export const env = (base) => ({ PATH: `${BIN}${delimiter}${base}` });', ''].join('\n'),
      });
      const imported = guard("import { delimiter, dirname, join } from 'node:path';");
      const library = "import { env } from './reader.js';";
      expect(floorOf(library, imported).memoizable).toBe(true);
      expect(floorOf(library, { ...imported, 'server/lib/bin/tool': 'tool v2\n' }).key).not.toBe(floorOf(library, imported).key);
      const multiple = {
        ...imported,
        [READER]: imported[READER].replace('${delimiter}${base}', "${delimiter}${join(HERE, 'tools')}${delimiter}${base}"),
        'server/lib/tools/other': 'tool v1\n',
      };
      expect(floorOf(library, multiple).memoizable).toBe(true);
      expect(floorOf(library, { ...multiple, 'server/lib/tools/other': 'tool v2\n' }).key).not.toBe(floorOf(library, multiple).key);
      // Any other `delimiter` may be a separator that continues the directory's path.
      expect(floorOf(library, guard('const delimiter = pick();')).reasons).toContain(`${READER}: reads a path with a variable segment that can leave server/lib/bin`);
    });

    it('takes a source reader\'s read from its callers, and refuses a reader that is not called by name', () => {
      const helper = { 'server/lib/testHelper.js': [
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const SERVER_DIR = join(import.meta.dirname, '..');",
        'export function readServerSource(rel) {',
        "  return readFileSync(join(SERVER_DIR, rel), 'utf8');",
        '}',
        '',
      ].join('\n') };
      const imported = "import { readServerSource } from './testHelper.js';";
      const called = `${imported}\nreadServerSource('lib/fixtures/f0.json');`;
      expect(floorOf(called, helper).memoizable).toBe(true);
      expect(floorOf(called, { ...helper, 'server/lib/fixtures/f0.json': 'changed\n' }).key).not.toBe(floorOf(called, helper).key);
      expect(floorOf(called, { ...helper, 'server/lib/fixtures/f1.json': 'changed\n' }).key).toBe(floorOf(called, helper).key);
      const templated = imported + "\nconst message = `source: ${readServerSource('lib/fixtures/f0.json')}`;";
      expect(floorOf(templated, { ...helper, 'server/lib/fixtures/f0.json': 'changed\n' }).key).not.toBe(floorOf(templated, helper).key);
      expect(floorOf(imported + '\nconst message = `source: ${readServerSource(pick())}`;', helper).reasons)
        .toContain(`${test}: readServerSource() with a non-literal path`);

      // The same body anywhere else is an ordinary unbounded read.
      const elsewhere = { 'server/lib/reader.js': helper['server/lib/testHelper.js'] };
      expect(floorOf("import { readServerSource } from './reader.js';", elsewhere).reasons).toContain('server/lib/reader.js: reads a path with a variable segment that can leave server');
      for (const body of [`${imported}\nconst all = ['lib/fixtures/f0.json'].map(readServerSource);`, "import { readServerSource as read } from './testHelper.js';\nread('lib/fixtures/f0.json');"]) {
        expect(floorOf(body, helper).reasons, body).toContain(`${test}: readServerSource used other than by a direct call`);
      }
    });
  });
});

describe('fixture owners', () => {
  // No package import: a scripts/ owner does not walk up into server/node_modules.
  const stub = "it('pin', () => {});\n";
  const owners = [
    'scripts/setup-image-video.test.js',
    'server/lib/pythonSetup.install.test.js',
    'server/lib/pythonSetup.test.js',
  ];
  const files = {
    ...TREE,
    ...Object.fromEntries(owners.map((owner) => [owner, stub])),
    'scripts/ml/requirements/requirements-ltx25-cuda.txt': 'pillow==1\n',
    'scripts/ml/requirements/requirements-ltx25-cuda-windows.lock.txt': 'torch==1\n',
    'scripts/ml/requirements/requirements-ltx25-cuda-linux.lock.txt': 'torch==1\n',
    'scripts/ml/requirements/requirements-ltx25-cuda-build.lock.txt': 'uv-build==1\n',
    'scripts/ml/requirements/requirements-wan22-cuda.txt': 'diffusers==1\n',
    'scripts/ml/requirements/requirements-minimax-music3-cuda-windows.lock.txt': 'diffusers==1 --hash=sha256:aaa\n',
    'scripts/ml/requirements/requirements-minimax-music3-cuda-linux.lock.txt': 'diffusers==1 --hash=sha256:bbb\n',
    'scripts/ml/requirements/requirements-minimax-h3-cuda-windows.lock.txt': 'torch==1\n',
    'scripts/ml/requirements/requirements-minimax-h3-cuda-linux.lock.txt': 'torch==1\n',
    'scripts/notes.txt': 'unmapped\n',
    'scripts/nested/requirements-extra.txt': 'nested\n',
  };

  it('hashes requirements pins into the installer-contract owners and ignores other text', () => {
    for (const owner of owners) {
      const before = keyOf(files, owner);
      expect(before.floor.memoizable, owner).toBe(true);
      expect(keyOf({ ...files, 'scripts/ml/requirements/requirements-ltx25-cuda.txt': 'pillow==2\n' }, owner).floor.key, owner)
        .not.toBe(before.floor.key);
      expect(keyOf({ ...files, 'scripts/notes.txt': 'changed\n' }, owner).floor.key, owner).toBe(before.floor.key);
      expect(keyOf({ ...files, 'scripts/nested/requirements-extra.txt': 'changed\n' }, owner).floor.key, owner)
        .toBe(before.floor.key);
      for (const target of ['windows', 'linux']) {
        const changed = { ...files, [`scripts/ml/requirements/requirements-minimax-music3-cuda-${target}.lock.txt`]: 'diffusers==2\n' };
        expect(keyOf(changed, owner).floor.key, owner).not.toBe(before.floor.key);
        const records = new Map([[owner, [owner]]]);
        expect(keyOf(changed, owner, { records }).recorded.key, owner)
          .not.toBe(keyOf(files, owner, { records }).recorded.key);
      }
      for (const target of ['windows', 'linux', 'build']) {
        const changed = { ...files, [`scripts/ml/requirements/requirements-ltx25-cuda-${target}.lock.txt`]: 'changed==2\n' };
        const after = keyOf(changed, owner, { records: new Map([[owner, [owner]]]) });
        expect(after.floor.key, owner).not.toBe(before.floor.key);
        expect(after.recorded.key, owner).not.toBe(keyOf(files, owner, { records: new Map([[owner, [owner]]]) }).recorded.key);
      }
      const recorded = keyOf(files, owner, { records: new Map([[owner, [owner]]]) });
      expect(recorded.recorded.memoizable, owner).toBe(true);
      for (const target of ['windows', 'linux']) {
        const changed = { ...files, [`scripts/ml/requirements/requirements-minimax-h3-cuda-${target}.lock.txt`]: 'torch==2\n' };
        const after = keyOf(changed, owner, { records: new Map([[owner, [owner]]]) });
        expect(after.floor.key, owner).not.toBe(before.floor.key);
        expect(after.recorded.key, owner).not.toBe(recorded.recorded.key);
      }
      expect(keyOf(
        { ...files, 'scripts/ml/requirements/requirements-wan22-cuda.txt': 'diffusers==2\n' },
        owner,
        { records: new Map([[owner, [owner]]]) },
      ).recorded.key, owner).not.toBe(recorded.recorded.key);
    }
  });

  it('invalidates both keys when a SuperCollider snapshot verifier, pin or signed fixture changes', () => {
    const owner = 'server/lib/superColliderSnapshot.test.js';
    const inputs = [
      'docker/supercollider/verify-snapshot.sh',
      'docker/supercollider/debian-inrelease.sha256',
      'server/test/fixtures/supercollider-snapshot/trixie.InRelease',
    ];
    const tree = {
      ...TREE,
      [owner]: stub,
      ...Object.fromEntries(inputs.map((path) => [path, 'original\n'])),
    };
    const records = new Map([[owner, [owner]]]);
    const before = keyOf(tree, owner, { records });
    expect(before.floor.memoizable).toBe(true);
    expect(before.recorded.memoizable).toBe(true);
    for (const input of inputs) {
      const after = keyOf({ ...tree, [input]: 'changed\n' }, owner, { records });
      expect(after.floor.key, input).not.toBe(before.floor.key);
      expect(after.recorded.key, input).not.toBe(before.recorded.key);
    }
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
    // Assembled so this file does not itself read as a tree scanner to server/test/guards/repo-scan-guards.test.js.
    const unresolvable = { ...files, 'server/lib/side.test.js': ["import { it } from 'vitest';", "import { readServerSource } from './testHelper.js';", `it('r', () => ${'readServerSource'}(process.env.TARGET));`].join('\n') };
    expect(withRecord(unresolvable, 'server/lib/side.test.js', ['server/lib/side.test.js']).recorded).toMatchObject({ memoizable: false, reason: expect.stringContaining('readServerSource') });
  });

  it('takes the setup files and custom environment from the record, not their static closure', () => {
    const files = {
      ...TREE,
      'server/vitest.config.js': [
        "import { vitestCiPool } from '../scripts/vitestCiPool.js';",
        "export default { test: { environment: fileURLToPath(new URL('./test/mediaRegistryEnvironment.js', import.meta.url)), setupFiles: ['./vitest.setup.js'] } };",
      ].join('\n'),
      'server/vitest.setup.js': "import { helper } from './lib/setupHelper.js';\nvi.mock('./services/instances.js', async (importOriginal) => importOriginal());\n",
      'server/lib/setupHelper.js': 'export const helper = 1;\n',
      'server/services/instances.js': "import { peer } from '../lib/peerLeaf.js';\nexport const getPeers = () => [peer];\n",
      'server/lib/peerLeaf.js': 'export const peer = 1;\n',
      'server/test/mediaRegistryEnvironment.js': "import { observe } from './envHelper.js';\nexport default { name: 'env', setup: observe };\n",
      'server/test/envHelper.js': 'export const observe = () => ({ teardown() {} });\n',
    };
    const loaded = [...recorded, 'server/vitest.setup.js', 'server/lib/setupHelper.js', 'server/test/mediaRegistryEnvironment.js', 'server/test/envHelper.js'];
    const change = (rel) => ({ ...files, [rel]: `${files[rel]}// changed\n` });
    const baseline = withRecord(files, 'server/lib/a.test.js', loaded);
    expect(baseline.recorded.memoizable).toBe(true);
    // Setup only registers a mock for instances.js; no suite here imports it, so its closure is outside both keys.
    expect(withRecord(change('server/lib/peerLeaf.js'), 'server/lib/a.test.js', loaded).recorded.key).toBe(baseline.recorded.key);
    expect(withRecord(change('server/lib/peerLeaf.js'), 'server/lib/a.test.js', loaded).floor.key).toBe(baseline.floor.key);
    for (const rel of ['server/lib/setupHelper.js', 'server/test/envHelper.js', 'server/vitest.setup.js', 'scripts/vitestCiPool.js']) {
      const changed = withRecord(change(rel), 'server/lib/a.test.js', loaded);
      expect(changed.recorded.key, rel).not.toBe(baseline.recorded.key);
      expect(changed.floor.key, rel).not.toBe(baseline.floor.key);
    }
    // A suite that imports the mocked module keys its closure itself, under both keys.
    const peerTest = "import { it } from 'vitest';\nimport { getPeers } from '../services/instances.js';\nit('p', () => getPeers());\n";
    const peers = { ...files, 'server/lib/peers.test.js': peerTest };
    const peersLoaded = ['server/lib/peers.test.js', 'server/services/instances.js', 'server/lib/peerLeaf.js', ...loaded.slice(recorded.length)];
    const peersBaseline = withRecord(peers, 'server/lib/peers.test.js', peersLoaded);
    const peersChanged = withRecord({ ...peers, 'server/lib/peerLeaf.js': 'export const peer = 2;\n' }, 'server/lib/peers.test.js', peersLoaded);
    expect(peersBaseline.floor.memoizable && peersBaseline.recorded.memoizable).toBe(true);
    expect(peersChanged.floor.key).not.toBe(peersBaseline.floor.key);
    expect(peersChanged.recorded.key).not.toBe(peersBaseline.recorded.key);
    // A record without the environment (a per-file pragma) keeps the full static base, environment closure included.
    const withoutEnv = loaded.filter((rel) => !rel.startsWith('server/test/'));
    expect(withRecord(change('server/test/envHelper.js'), 'server/lib/a.test.js', withoutEnv).recorded.key)
      .not.toBe(withRecord(files, 'server/lib/a.test.js', withoutEnv).recorded.key);
  });

  it('ignores edits to the test-selection modules the config imports', () => {
    const files = {
      ...TREE,
      'server/vitest.config.js': [
        "import { vitestCiPool } from '../scripts/vitestCiPool.js';",
        "import { SERVER_TEST_EXCLUDE } from '../scripts/lib/workspaceTests.js';",
        'export default { test: { exclude: SERVER_TEST_EXCLUDE } };',
      ].join('\n'),
      'scripts/lib/workspaceTests.js': "import { DB_TEST_INCLUDE } from './dbTestFiles.js';\nimport { BROWSER_SUITES } from './browserSuites.js';\nexport const SERVER_TEST_EXCLUDE = [...DB_TEST_INCLUDE, ...BROWSER_SUITES];\n",
      'scripts/lib/dbTestFiles.js': "export const DB_TEST_INCLUDE = ['services/x.db.test.js'];\n",
      'scripts/lib/browserSuites.js': "export const BROWSER_SUITES = ['server/lib/x.browser.test.js'];\n",
    };
    const baseline = withRecord(files);
    expect(baseline.floor.memoizable && baseline.recorded.memoizable).toBe(true);
    const edits = {
      'scripts/lib/dbTestFiles.js': "export const DB_TEST_INCLUDE = ['services/x.db.test.js', 'services/y.db.test.js'];\n",
      'scripts/lib/browserSuites.js': "export const BROWSER_SUITES = ['server/lib/x.browser.test.js', 'server/lib/y.browser.test.js'];\n",
      'scripts/lib/workspaceTests.js': `${files['scripts/lib/workspaceTests.js']}export const extra = 1;\n`,
    };
    for (const [rel, text] of Object.entries(edits)) {
      const changed = withRecord({ ...files, [rel]: text });
      expect(changed.floor.key, rel).toBe(baseline.floor.key);
      expect(changed.recorded.key, rel).toBe(baseline.recorded.key);
    }
    // A test that reads the inventory itself still keys it.
    const guard = { ...files, 'server/lib/inventory.test.js': "import { it } from 'vitest';\nimport { DB_TEST_INCLUDE } from '../../scripts/lib/dbTestFiles.js';\nit('i', () => DB_TEST_INCLUDE);\n" };
    expect(keyOf({ ...guard, 'scripts/lib/dbTestFiles.js': edits['scripts/lib/dbTestFiles.js'] }, 'server/lib/inventory.test.js').floor.key)
      .not.toBe(keyOf(guard, 'server/lib/inventory.test.js').floor.key);
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
    // A bare name may be a directory Node loads via index.js or package.json main: not provably a file.
    expect(floor(tree(boot.replace("'ecosystem.config.cjs'", "'plugin'")))).toMatchObject({ memoizable: false, reason: expect.stringContaining('non-literal') });
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
    // A literal prefix of a computed name is not the whole argument.
    expect(key({ ...files, 'scripts/tool.py': "import importlib\nmod = importlib.import_module('_pins' + suffix)\n" })).toMatchObject({ memoizable: false, reason: expect.stringContaining('import_module') });
    // Whitespace between the name and '(' is valid Python and must not bypass either path.
    const spaced = { ...files, 'scripts/tool.py': "import importlib\nmod = importlib.import_module ('_pins')\n" };
    expect(key({ ...spaced, 'scripts/_pins.py': 'PINS = 2\n' }).key).not.toBe(key(spaced).key);
    expect(key({ ...files, 'scripts/tool.py': 'import importlib\nmod = importlib.import_module (name)\n' })).toMatchObject({ memoizable: false, reason: expect.stringContaining('import_module') });
  });

  it('fails closed when the test or repository tooling reads the install data tree or the home directory, and ignores a product module doing so', () => {
    // The fixture sources spell the data directory from pieces so this file
    // does not itself trip server/test/guards/repo/testDataIsolation.test.js.
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

  it.each([false, true])('selects a test for a file outside its guessed read prefix (transitive: %s)', (transitive) => {
    const test = 'server/lib/a.test.js';
    const changed = 'client/src/limits.js';
    const reader = [
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const HERE = import.meta.dirname;',
      'const read = (name) => readFileSync(join(HERE, name));',
      "const pick = () => '../../client/src/limits.js';",
      'read(pick());',
    ].join('\n');
    const files = {
      ...TREE,
      [changed]: 'export const limit = 1;',
      [test]: transitive ? "import './reader.js';" : reader,
      ...(transitive ? { 'server/lib/reader.js': reader } : {}),
    };
    const keys = computeTestMemoKeys([test, 'server/lib/plain.test.js'], options(files));
    expect(keys.get(test).floor.reason).toContain('reads a path through read() that the analyzer cannot resolve');
    expect(relatedTests(keys, [changed])).toEqual([test]);
  });

  it('only selects a test with a contained read when its input changes', () => {
    const test = 'server/lib/a.test.js';
    const files = {
      ...TREE,
      'lib/pathWithin.js': 'export const pathWithin = (dir, ...segments) => join(dir, ...segments);',
      'server/lib/fixtures/fixture.txt': 'fixture',
      [test]: [
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "import { pathWithin } from '../../lib/pathWithin.js';",
        "readFileSync(pathWithin(join(import.meta.dirname, 'fixtures'), process.argv[2]));",
      ].join('\n'),
    };
    const keys = computeTestMemoKeys([test], options(files));
    expect(relatedTests(keys, ['server/lib/fixtures/fixture.txt'])).toEqual([test]);
    expect(relatedTests(keys, ['server/lib/unrelated.js'])).toEqual([]);
  });
});

describe('record-aware related selection (#16424)', () => {
  // hub.js is a lazy hub: it statically imports util.js and lazily imports
  // lazy.js. user.test.js calls load(), so its green run loaded lazy.js;
  // bystander.test.js imports the hub and never calls it.
  const HUB = {
    ...BASE,
    'server/lib/hub.js': "import { u } from './util.js';\nexport const load = () => import('./lazy.js');\nexport const hub = u;\n",
    'server/lib/util.js': 'export const u = 1;\n',
    'server/lib/lazy.js': 'export const lazy = 1;\n',
    'server/lib/newLazy.js': 'export const fresh = 1;\n',
    'server/lib/user.test.js': "import { it } from 'vitest';\nimport { load } from './hub.js';\nit('u', async () => { await load(); });\n",
    'server/lib/bystander.test.js': "import { it } from 'vitest';\nimport { hub } from './hub.js';\nit('b', () => hub);\n",
    'server/lib/unrecorded.test.js': "import { it } from 'vitest';\nimport { hub } from './hub.js';\nit('n', () => hub);\n",
  };
  const TESTS = ['server/lib/bystander.test.js', 'server/lib/unrecorded.test.js', 'server/lib/user.test.js'];
  const LOADED = {
    'server/lib/user.test.js': ['server/lib/hub.js', 'server/lib/lazy.js', 'server/lib/user.test.js', 'server/lib/util.js'],
    'server/lib/bystander.test.js': ['server/lib/bystander.test.js', 'server/lib/hub.js', 'server/lib/util.js'],
  };
  // The digest a v2 record stores, computed independently of the analyzer: sha256, 16 hex.
  const digest = (files, rel) => (rel in files ? createHash('sha256').update(files[rel]).digest('hex').slice(0, 16) : '0'.repeat(16));
  /** Keys for `now`, with v2 records written when the tree was `recordedFrom` (default: `now`). */
  const keysFor = (now, { recordedFrom = now, loaded = LOADED, digests = true, tests = TESTS } = {}) => computeTestMemoKeys(tests, options(now, {
    records: new Map(Object.entries(loaded)),
    digests: digests ? new Map(Object.entries(loaded).map(([test, modules]) => [test, modules.map((rel) => digest(recordedFrom, rel))])) : new Map(),
  }));
  const unnarrowed = (now) => computeTestMemoKeys(TESTS, options(now));

  it('selects a recorded test only through what it loaded, and an unrecorded test through the whole lazy closure', () => {
    const keys = keysFor(HUB);
    expect(keys.get('server/lib/user.test.js').narrowed).not.toBeNull();
    expect(keys.get('server/lib/unrecorded.test.js').narrowed).toBeNull();
    expect(relatedTests(keys, ['server/lib/lazy.js'])).toEqual(['server/lib/unrecorded.test.js', 'server/lib/user.test.js']);
    // Before: the lazy edge put every hub importer in the selection.
    expect(relatedTests(unnarrowed(HUB), ['server/lib/lazy.js'])).toEqual(TESTS);
    // Static closures and the hub itself still select every importer.
    for (const source of ['server/lib/hub.js', 'server/lib/util.js']) expect(relatedTests(keys, [source]), source).toEqual(TESTS);
    expect(relatedTests(keys, ['server/lib/nothing.js'])).toEqual([]);
  });

  it('selects a test with no record, or with a record from before digests, exactly as before', () => {
    const variants = {
      ...HUB,
      'server/lib/hub.js': "import { u } from './util.js';\nexport const load = (name) => import(name);\nexport const more = () => import('./lazy.js');\nexport const hub = u;\n",
    };
    for (const tree of [HUB, variants]) {
      const before = unnarrowed(tree);
      const legacy = keysFor(tree, { digests: false });
      for (const info of legacy.values()) expect(info.narrowed).toBeNull();
      for (const source of Object.keys(tree)) {
        expect(relatedTests(legacy, [source]), source).toEqual(relatedTests(before, [source]));
        // In a mixed store the unrecorded test keeps exactly its old membership.
        const mixed = relatedTests(keysFor(tree), [source]).includes('server/lib/unrecorded.test.js');
        expect(mixed, source).toBe(relatedTests(before, [source]).includes('server/lib/unrecorded.test.js'));
      }
    }
  });

  it('keeps selecting every test that recorded an importer once it gains a new lazy edge', () => {
    // Another change added `import('./newLazy.js')` to the hub after the records were written.
    const gained = { ...HUB, 'server/lib/hub.js': "import { u } from './util.js';\nexport const load = () => import('./lazy.js');\nexport const next = () => import('./newLazy.js');\nexport const hub = u;\n" };
    const keys = keysFor(gained, { recordedFrom: HUB });
    // The change that adds the edge selects every recorder of the importer...
    expect(relatedTests(keys, ['server/lib/hub.js'])).toEqual(TESTS);
    // ...and so does a later change to the new lazy target alone, before any re-record:
    // the hub's digest no longer matches, so its closure is walked whole.
    expect(relatedTests(keys, ['server/lib/newLazy.js'])).toEqual(TESTS);
    // Once a green run re-records with the new bytes, a bystander that never calls it narrows again.
    expect(relatedTests(keysFor(gained), ['server/lib/newLazy.js'])).toEqual(['server/lib/unrecorded.test.js']);
  });

  it('fails closed on an unresolved edge only where the record cannot vouch for the walk', () => {
    const dynamic = { ...HUB, 'server/lib/util.js': 'export const u = 1;\nexport const any = (name) => import(name);\n' };
    // util.js is recorded and unchanged: the run's record covers what it loaded.
    expect(relatedTests(keysFor(dynamic), ['server/lib/nothing.js'])).toEqual(['server/lib/unrecorded.test.js']);
    // Changed since the record: its non-literal import could reach anything now.
    const changed = { ...dynamic, 'server/lib/util.js': `${dynamic['server/lib/util.js']}// edited\n` };
    expect(relatedTests(keysFor(changed, { recordedFrom: dynamic }), ['server/lib/nothing.js'])).toEqual(TESTS);
  });

  it('keeps a spawned side module whole and fails closed on its unresolved edges, but not on a tree only copied as data', () => {
    const tree = {
      ...HUB,
      'server/lib/templates/page.js': 'export const page = (name) => import(name);\n',
      'server/lib/worker.js': "export const run = (name) => import(name);\nimport './helper.js';\n",
      'server/lib/helper.js': 'export const h = 1;\n',
      'lib/pathWithin.js': 'export const pathWithin = (dir, ...segments) => join(dir, ...segments);\n',
      'server/lib/hub.js': [
        "import { readdir } from 'node:fs/promises';",
        "import { spawn } from 'node:child_process';",
        "import { join } from 'node:path';",
        "import { pathWithin } from '../../lib/pathWithin.js';",
        "import { u } from './util.js';",
        // Joined with pathWithin(): a library module's unbounded read refuses its importers too (#16660).
        "export const copy = (id) => readdir(pathWithin(join(import.meta.dirname, 'templates'), id));",
        "export const start = () => spawn(process.execPath, [new URL('./worker.js', import.meta.url).pathname]);",
        'export const hub = u;',
      ].join('\n'),
    };
    const only = (test) => keysFor(tree, { tests: [test], loaded: { [test]: LOADED['server/lib/bystander.test.js'] } });
    const keys = only('server/lib/bystander.test.js');
    // The spawned worker's whole closure is in reach, and its non-literal import fails closed.
    expect(keys.get('server/lib/bystander.test.js').narrowed.failClosed).toMatch(/worker\.js/);
    const copied = { ...tree, 'server/lib/hub.js': tree['server/lib/hub.js'].replace(/^export const start.*$/m, '') };
    const quiet = keysFor(copied, { tests: ['server/lib/bystander.test.js'], loaded: { 'server/lib/bystander.test.js': LOADED['server/lib/bystander.test.js'] } });
    expect(quiet.get('server/lib/bystander.test.js').narrowed.failClosed).toBeNull();
    // A copied template is still an input: editing it selects the test.
    expect(relatedTests(quiet, ['server/lib/templates/page.js'])).toEqual(['server/lib/bystander.test.js']);
    expect(relatedTests(keys, ['server/lib/helper.js'])).toEqual(['server/lib/bystander.test.js']);
  });

  it('counts JS read as text by its bytes, and by its closure only when the reader can evaluate it', () => {
    const reader = (extra = '') => ({
      ...HUB,
      'server/lib/source.js': "import './sourceDep.js';\nexport const s = 1;\n",
      'server/lib/sourceDep.js': 'export const d = 1;\n',
      'server/lib/bystander.test.js': [
        "import { it } from 'vitest';",
        "import { readFileSync } from 'node:fs';",
        "import { hub } from './hub.js';",
        "const text = readFileSync(new URL('./source.js', import.meta.url), 'utf8');",
        extra,
        "it('b', () => hub && text);",
      ].join('\n'),
    });
    const test = 'server/lib/bystander.test.js';
    const keysOf = (files) => keysFor(files, { tests: [test], loaded: { [test]: LOADED[test] } });
    const plain = keysOf(reader());
    expect(relatedTests(plain, ['server/lib/source.js'])).toEqual([test]);
    expect(relatedTests(plain, ['server/lib/sourceDep.js'])).toEqual([]);
    // Evaluating the text through a data: URL runs its imports, so they count too (and cannot fail closed).
    const evaluating = keysOf(reader("const mod = await import(`data:text/javascript,${encodeURIComponent(text)}`);"));
    expect(evaluating.get(test).narrowed.failClosed).toBeNull();
    expect(relatedTests(evaluating, ['server/lib/sourceDep.js'])).toEqual([test]);
  });

  it('does not narrow a record the recorded key rejects: a deleted member or one outside the repository', () => {
    const gone = { ...HUB };
    delete gone['server/lib/lazy.js'];
    gone['server/lib/hub.js'] = "import { u } from './util.js';\nexport const hub = u;\n";
    // The record names a module that no longer exists, so the test is selected as before: the
    // importer edit that dropped the import selects it, as it does every hub importer.
    const deleted = keysFor(gone, { recordedFrom: HUB });
    expect(deleted.get('server/lib/user.test.js').narrowed).toBeNull();
    expect(relatedTests(deleted, ['server/lib/hub.js'])).toEqual(TESTS);
    // A record that reaches outside the repository is not memoizable, so it cannot narrow either.
    const outside = keysFor(HUB, { loaded: { ...LOADED, 'server/lib/user.test.js': [...LOADED['server/lib/user.test.js'], '../outside/x.js'] } });
    expect(outside.get('server/lib/user.test.js').recorded.memoizable).toBe(false);
    expect(outside.get('server/lib/user.test.js').narrowed).toBeNull();
  });
});

describe('extractFileFacts', () => {
  it('keys a defaulted path parameter only where every call relies on the default', () => {
    const head = ["import { readdirSync } from 'fs';", "import { join } from 'path';", "const FIXTURES = join(__dirname, 'fixtures');", "const OTHER = join(__dirname, 'other');"];
    const keyed = (...lines) => {
      const facts = extractFileFacts([...head, ...lines].join('\n'), { fileRel: 'server/x.test.js', cwdRel: 'server' });
      return [facts.dirs.map((dir) => dir.rel).sort(), facts.handedDirs.slice().sort()];
    };
    const plain = 'function read(dir = FIXTURES) { return readdirSync(dir); }';
    // Every call omits the argument: the default is keyed, as before.
    expect(keyed(plain, 'read();')).toEqual([['server/fixtures'], []]);
    // Calls that disagree leave the read open (guessed and unbounded), never the default alone as if it were the value.
    const disagreeing = extractFileFacts([...head, plain, 'read(OTHER);', 'read();'].join('\n'), { fileRel: 'server/x.test.js', cwdRel: 'server' });
    expect(disagreeing.dirs).toEqual([expect.objectContaining({ rel: 'server/fixtures', guessed: true, open: true })]);
    // The issue's snippet: the default is never read, the passed path is.
    const swapped = keyed(plain, 'read(OTHER);');
    expect(swapped[0]).toContain('server/other');
    expect(swapped[0]).not.toContain('server/fixtures');
    // Destructured property: same rule per call's object literal.
    const destructured = 'function read({ dir = FIXTURES } = {}) { return readdirSync(dir); }';
    expect(keyed(destructured, 'read({});')).toEqual([['server/fixtures'], []]);
    const other = keyed(destructured, 'read({ dir: OTHER });');
    expect(other[0]).toContain('server/other');
    expect(other[0]).not.toContain('server/fixtures');
  });

  it('reads a module\'s literal string and frozen array exports, and nothing else', () => {
    const exported = literalExports([
      "export const A = 'a.json';",
      'export const B = `b.json`',
      "export const C = Object.freeze(['c0', `c1`,]);",
      "export const D = ['d'];",
      "export const E = 'e' + suffix;",
      'export const F = Object.freeze([]);',
      "export let G = 'g';",
      "const H = 'h';",
    ].join('\n'), 'server/lib/x.js');
    expect(Object.fromEntries(exported)).toEqual({
      A: { k: 'str', v: 'a.json' },
      B: { k: 'str', v: 'b.json' },
      C: { k: 'array', values: ['c0', 'c1'] },
      F: { k: 'array', values: [] },
    });
  });

  it('does not treat an array passed to a local Object.freeze as a frozen export', () => {
    expect(literalExports("const Object = getHelpers();\nexport const NAMES = Object.freeze(['f0.json']);", 'server/lib/x.js').has('NAMES')).toBe(false);
  });

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
      { rel: 'docs/API.md', walk: false, read: true },
      { rel: 'server/lib/x.json', walk: false, read: true },
      { rel: 'scripts/tool.js', walk: true, read: false },
      { rel: 'data/settings.json', walk: false, read: true },
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

describe('data-only JS files and bounded dynamic imports (#16902)', () => {
  const analyze = (files, tests = ['server/lib/a.test.js']) => computeTestMemoKeys(tests, {
    fs: memoryFs(files),
    workspace: 'server',
  });

  it('does not walk edges of data-directory JS files with dynamic imports in gather()', () => {
    const baseFiles = {
      ...BASE,
      'server/lib/doc.js': [
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const TEMPLATES = join(__dirname, 'templates');",
        "export const load = () => readFileSync(join(TEMPLATES, 'world.test.js'), 'utf8');",
      ].join('\n'),
      'server/lib/templates/world.test.js': "const threeUrl = getUrl();\nexport const run = async () => import(threeUrl);\n",
      'server/lib/a.test.js': "import { load } from './doc.js';\nexport const t = load;\n",
    };
    const first = analyze(baseFiles).get('server/lib/a.test.js');
    expect(first.edgesResolved).toBe(true);
    expect(first.floor.memoizable).toBe(true);
    expect(first.floor.key).not.toBeNull();

    const edited = analyze({
      ...baseFiles,
      'server/lib/templates/world.test.js': "const threeUrl = getUrl();\nexport const run = async () => import(threeUrl); // changed\n",
    }).get('server/lib/a.test.js');
    expect(edited.floor.key).not.toBe(first.floor.key);
  });

  it('resolves PATHS.slashdo dynamic imports and fails closed when fileUtils.js is mocked', () => {
    const files = {
      ...BASE,
      'server/lib/fileUtils.js': 'export const PATHS = {};\n',
      'server/lib/slashdoLoader.js': [
        "import { join } from 'node:path';",
        "import { pathToFileURL } from 'node:url';",
        "import { PATHS } from './fileUtils.js';",
        "export async function render() { return import(pathToFileURL(join(PATHS.slashdo, 'src/transformer.js')).href); }",
      ].join('\n'),
      'lib/slashdo/src/transformer.js': 'export default {};\n',
      'server/lib/a.test.js': "import { render } from './slashdoLoader.js';\nexport const t = render;\n",
    };
    const res = analyze(files).get('server/lib/a.test.js');
    expect(res.edgesResolved).toBe(true);
    expect(res.floor.memoizable).toBe(true);

    const mocked = analyze({
      ...files,
      'server/lib/a.test.js': "import { vi } from 'vitest';\nvi.mock('./fileUtils.js', () => ({ PATHS: { slashdo: '/tmp' } }));\nimport { render } from './slashdoLoader.js';\nexport const t = render;\n",
    }).get('server/lib/a.test.js');
    expect(mocked.floor.memoizable).toBe(false);
  });

  it('resolves migration runner dynamic imports using default parameters and scanners while ignoring migration tests', () => {
    const files = {
      ...BASE,
      'scripts/lib/migrationFiles.js': 'export async function scanMigrationFiles() { return []; }\nexport async function scanDatabaseMigrationFiles() { return []; }\n',
      'scripts/lib/migrationLedger.js': [
        "import { join, dirname } from 'node:path';",
        "import { fileURLToPath } from 'node:url';",
        "const __dirname = dirname(fileURLToPath(import.meta.url));",
        "export const DEFAULT_MIGRATIONS_DIR = join(__dirname, '..', 'migrations');",
        "export { scanMigrationFiles } from './migrationFiles.js';",
      ].join('\n'),
      'scripts/run-migrations.js': [
        "import { join } from 'node:path';",
        "import { pathToFileURL } from 'node:url';",
        "import { DEFAULT_MIGRATIONS_DIR, scanMigrationFiles } from './lib/migrationLedger.js';",
        "export async function runMigrations({ migrationsDir = DEFAULT_MIGRATIONS_DIR, through = null } = {}) {",
        "  return runPending({ migrationsDir, through });",
        "}",
        "async function runPending({ migrationsDir, through }) {",
        "  const files = await scanMigrationFiles(migrationsDir);",
        "  for (const file of through === null ? files : files.slice(0, files.indexOf(through) + 1)) {",
        "    await import(pathToFileURL(join(migrationsDir, file)).href);",
        "  }",
        "}",
      ].join('\n'),
      'scripts/migrations/001-init.js': 'export async function up() {}\n',
      'scripts/migrations/001-init.test.js': "const u = getUrl();\nexport const t = () => import(u);\n",
      'server/scripts/run-db-migrations.js': [
        "import { join, dirname } from 'node:path';",
        "import { fileURLToPath, pathToFileURL } from 'node:url';",
        "import { scanDatabaseMigrationFiles } from '../../scripts/lib/migrationFiles.js';",
        "const __dirname = dirname(fileURLToPath(import.meta.url));",
        "const DEFAULT_MIGRATIONS_DIR = join(__dirname, 'db-migrations');",
        "export async function runDatabaseMigrations({ migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {",
        "  const files = await scanDatabaseMigrationFiles(migrationsDir);",
        "  for (const file of files) {",
        "    if (file.endsWith('.js')) await import(pathToFileURL(join(migrationsDir, file)).href);",
        "  }",
        "}",
      ].join('\n'),
      'server/scripts/db-migrations/001-schema.js': 'export async function up() {}\n',
      'server/lib/a.test.js': [
        "import { runMigrations } from '../../scripts/run-migrations.js';",
        "import { runDatabaseMigrations } from '../scripts/run-db-migrations.js';",
        "export const t = [runMigrations, runDatabaseMigrations];",
      ].join('\n'),
    };
    const first = analyze(files).get('server/lib/a.test.js');
    expect(first.edgesResolved).toBe(true);
    expect(first.floor.memoizable).toBe(true);
    expect(first.floor.key).not.toBeNull();

    const edited = analyze({
      ...files,
      'scripts/migrations/001-init.js': 'export async function up() { return 1; }\n',
    }).get('server/lib/a.test.js');
    expect(edited.floor.key).not.toBe(first.floor.key);
  });
});
