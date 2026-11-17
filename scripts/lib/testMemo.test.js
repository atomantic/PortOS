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
      'server/lib/apiAccessPolicy.test.js',
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
    const test = ["import { it } from 'vitest';", "const read = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');", 'it(\'x\', () => {});'].join('\n');
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
      // The read may land anywhere: `read('../../server/lib/nav.js')` leaves the prefix, and a
      // template URL keeps only the importing file's directory. Past the limit that was always refused.
      for (const read of [
        "const HERE = dirname(fileURLToPath(import.meta.url));\nconst read = (p) => readFileSync(join(HERE, p), 'utf8');",
        'const shipped = (name) => readFileSync(new URL(`../../../server/lib/${name}`, import.meta.url));',
      ]) {
        const guessed = { ...files };
        for (let i = 0; i <= DIRECTORY_INPUT_LIMIT; i += 1) guessed[`client/src/pages/p${i}.json`] = '{}';
        guessed[one] = `import { it } from 'vitest';\n${read}\nit('one', () => {});\n`;
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
    'scripts/requirements-ltx25-cuda.txt': 'pillow==1\n',
    'scripts/requirements-ltx25-cuda-windows.lock.txt': 'torch==1\n',
    'scripts/requirements-ltx25-cuda-linux.lock.txt': 'torch==1\n',
    'scripts/requirements-ltx25-cuda-build.lock.txt': 'uv-build==1\n',
    'scripts/requirements-wan22-cuda.txt': 'diffusers==1\n',
    'scripts/requirements-minimax-music3-cuda-windows.lock.txt': 'diffusers==1 --hash=sha256:aaa\n',
    'scripts/requirements-minimax-music3-cuda-linux.lock.txt': 'diffusers==1 --hash=sha256:bbb\n',
    'scripts/requirements-minimax-h3-cuda-windows.lock.txt': 'torch==1\n',
    'scripts/requirements-minimax-h3-cuda-linux.lock.txt': 'torch==1\n',
    'scripts/notes.txt': 'unmapped\n',
    'scripts/nested/requirements-extra.txt': 'nested\n',
  };

  it('hashes requirements pins into the installer-contract owners and ignores other text', () => {
    for (const owner of owners) {
      const before = keyOf(files, owner);
      expect(before.floor.memoizable, owner).toBe(true);
      expect(keyOf({ ...files, 'scripts/requirements-ltx25-cuda.txt': 'pillow==2\n' }, owner).floor.key, owner)
        .not.toBe(before.floor.key);
      expect(keyOf({ ...files, 'scripts/notes.txt': 'changed\n' }, owner).floor.key, owner).toBe(before.floor.key);
      expect(keyOf({ ...files, 'scripts/nested/requirements-extra.txt': 'changed\n' }, owner).floor.key, owner)
        .toBe(before.floor.key);
      for (const target of ['windows', 'linux']) {
        const changed = { ...files, [`scripts/requirements-minimax-music3-cuda-${target}.lock.txt`]: 'diffusers==2\n' };
        expect(keyOf(changed, owner).floor.key, owner).not.toBe(before.floor.key);
        const records = new Map([[owner, [owner]]]);
        expect(keyOf(changed, owner, { records }).recorded.key, owner)
          .not.toBe(keyOf(files, owner, { records }).recorded.key);
      }
      for (const target of ['windows', 'linux', 'build']) {
        const changed = { ...files, [`scripts/requirements-ltx25-cuda-${target}.lock.txt`]: 'changed==2\n' };
        const after = keyOf(changed, owner, { records: new Map([[owner, [owner]]]) });
        expect(after.floor.key, owner).not.toBe(before.floor.key);
        expect(after.recorded.key, owner).not.toBe(keyOf(files, owner, { records: new Map([[owner, [owner]]]) }).recorded.key);
      }
      const recorded = keyOf(files, owner, { records: new Map([[owner, [owner]]]) });
      expect(recorded.recorded.memoizable, owner).toBe(true);
      for (const target of ['windows', 'linux']) {
        const changed = { ...files, [`scripts/requirements-minimax-h3-cuda-${target}.lock.txt`]: 'torch==2\n' };
        const after = keyOf(changed, owner, { records: new Map([[owner, [owner]]]) });
        expect(after.floor.key, owner).not.toBe(before.floor.key);
        expect(after.recorded.key, owner).not.toBe(recorded.recorded.key);
      }
      expect(keyOf(
        { ...files, 'scripts/requirements-wan22-cuda.txt': 'diffusers==2\n' },
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
    // Assembled so this file does not itself read as a tree scanner to scripts/repo-scan-guards.guard.test.js.
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
    // does not itself trip lib/testDataIsolation.guard.test.js.
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
      'server/lib/hub.js': [
        "import { readdir } from 'node:fs/promises';",
        "import { spawn } from 'node:child_process';",
        "import { join } from 'node:path';",
        "import { u } from './util.js';",
        "export const copy = (id) => readdir(join(import.meta.dirname, 'templates', id));",
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
