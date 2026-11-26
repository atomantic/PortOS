import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import {
  formatPlanSummary,
  githubPlanOutput,
  FULL_SUITE_SHARDS,
  CLIENT_BROWSER_FANOUT_SUITES,
  CLIENT_FANOUT_TEST_FILES,
  shardIndexes,
} from './ciPlanOutput.js';
import { buildCiTestPlan } from '../ci-test-plan.js';
import { BROWSER_SUITES } from './browserSuites.js';
import { isRouteOnlyAppDiff, LINUX_CONTAINMENT_TESTS } from './ciPlanRules.js';
import { collectPlanInputs } from './ciPlanInputs.js';

it('narrows a shared basename to tests that can mean the changed copy, and keeps a unique one by name (#11870)', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-basenames-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const alpha = 'server/alpha/index.js';
  const mirror = 'client/src/lib/mirrorOnly.js';
  const tests = {
    inDirectory: ['server/alpha/local.test.js', "readFileSync(new URL('./index.js', import.meta.url));\n"],
    inSubtree: ['server/alpha/nested/deep.test.js', "readFileSync(new URL('../index.js', import.meta.url));\n"],
    namesAlpha: ['server/other/namesAlpha.test.js', "readFileSync(join(root, 'alpha', 'index.js'));\n"],
    namesBeta: ['server/other/namesBeta.test.js', "readFileSync(join(root, 'beta', 'index.js'));\n"],
    mirror: ['server/other/mirror.test.js', "readFileSync(join(clientLib, 'mirrorOnly.js'));\n"],
  };
  try {
    git('init', '-q');
    for (const source of [alpha, 'server/beta/index.js', mirror]) write(source, 'export const value = 1;\n');
    for (const [path, body] of Object.values(tests)) write(path, body);
    git('add', '--all');

    const { pathContractTests } = collectPlanInputs({ baseSha: 'HEAD', changedFiles: [alpha, mirror], cwd: root });
    expect(pathContractTests[alpha].sort()).toEqual(
      [tests.inDirectory[0], tests.inSubtree[0], tests.namesAlpha[0]].sort());
    // A unique basename keeps the #6363 lookup: the mirror test names no directory.
    expect(pathContractTests[mirror]).toEqual([tests.mirror[0]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('looks tests up by source basename from one indexed read, with git grep semantics (#14866)', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-reference-index-'));
  const trace = `${root}.git-trace`;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const sources = {
    unique: 'server/lib/uniqueHelper.js',
    punctuated: 'server/lib/file-name.v2.js',
    python: 'scripts/render_clip.py',
    orphan: 'server/lib/neverNamed.js',
  };
  const tests = {
    testVariant: ['server/lib/uniqueHelper.test.js', "readFileSync(join(lib, 'uniqueHelper.js'));\n"],
    specVariant: ['client/src/mirror.spec.jsx', 'const mirrored = "uniqueHelper.js";\n'],
    nestedTestDir: ['server/x.test.d/helper.js', "'file-name.v2.js'\n"],
    punctuated: ['server/lib/punctuated.test.js', "path.join('lib', 'file-name.v2.js')\n"],
    python: ['scripts/render.test.js', "readFileSync('scripts/render_clip.py', 'utf8');\n"],
    // Names that only look similar: wrong boundary on either side, or another extension.
    prefixed: ['server/lib/prefixed.test.js', "'myuniqueHelper.js' 'uniqueHelper.json' 'file-name_v2.js' 'file-name.v2xjs'\n"],
    notATest: ['server/lib/uniqueHelper.notes.js', "'uniqueHelper.js'\n"],
  };
  try {
    git('init', '-q');
    for (const path of Object.values(sources)) write(path, 'export const value = 1;\n');
    for (const [path, body] of Object.values(tests)) write(path, body);
    git('add', '--all');

    writeFileSync(trace, '');
    process.env.GIT_TRACE = trace;
    let pathContractTests;
    try {
      ({ pathContractTests } = collectPlanInputs({
        baseSha: 'HEAD', changedFiles: Object.values(sources), cwd: root,
      }));
    } finally {
      delete process.env.GIT_TRACE;
    }

    expect(pathContractTests).toEqual({
      [sources.unique]: [tests.specVariant[0], tests.testVariant[0]],
      [sources.punctuated]: [tests.nestedTestDir[0], tests.punctuated[0]].sort(),
      [sources.python]: [tests.python[0]],
      [sources.orphan]: [],
    });
    // Four changed sources, zero per-source repository scans.
    expect(readFileSync(trace, 'utf8')).not.toMatch(/\bgit grep\b|built-in: git grep/);
  } finally {
    rmSync(trace, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

it('builds the same plan from an explicit working-tree override as from the equivalent commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-override-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const source = 'client/src/App.jsx';
  const test = 'client/src/App.test.jsx';
  const write = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const commit = () => {
    git('add', '--all');
    git('-c', 'user.name=Example Contributor', '-c', 'user.email=contributor@example.com',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  };
  const build = (inputs) => buildCiTestPlan(inputs.changedFiles, {
    trackedFiles: inputs.trackedFiles,
    appRouteOnly: isRouteOnlyAppDiff(inputs.appDiff),
    pathContractTests: inputs.pathContractTests,
  });

  try {
    git('init', '-q');
    git('config', 'core.hooksPath', join(root, 'empty-hooks'));
    write(source, 'export const app = (\n  <Routes>\n    <Route path="old" />\n  </Routes>\n);\n');
    write(test, "import './App.jsx';\n");
    commit();
    const base = git('rev-parse', 'HEAD');

    write(source, 'export const app = (\n  <Routes>\n    <Route path="new" />\n  </Routes>\n);\n');
    const overridden = build(collectPlanInputs({
      baseSha: base,
      changedFiles: [source],
      cwd: root,
    }));

    commit();
    const committed = build(collectPlanInputs({ baseSha: base, cwd: root }));
    expect(overridden.full).toBe(false);
    expect(overridden).toEqual(committed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('resolves local client imports of present untracked modules and still fails closed on missing ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-untracked-deps-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, source) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  const leaf = 'server/lib/shared/leaf.js';
  const inspect = () => {
    const inputs = collectPlanInputs({ baseSha: 'HEAD', changedFiles: [leaf], cwd: root });
    return buildCiTestPlan(inputs.changedFiles, inputs);
  };
  try {
    git('init', '-q');
    write(leaf, 'export const value = 1;\n');
    write('client/src/lib/consumer.js', "import { widget } from './newWidget.js';\nexport { value } from '../../../server/lib/shared/leaf.js';\n");
    write('client/src/lib/consumer.test.js', "import './consumer.js';\n");
    git('add', '--all');

    // newWidget.js exists but is not yet staged: still a resolvable local import.
    write('client/src/lib/newWidget.js', 'export const widget = 1;\n');
    expect(git('status', '--porcelain')).toContain('?? client/src/lib/newWidget.js');
    const plan = inspect();
    expect(plan.full).toBe(false);
    expect(plan.client.mode).toBe('related');
    expect(plan.client.sources).toContain(leaf);

    // Control: a genuinely missing import still widens to a full plan.
    rmSync(join(root, 'client/src/lib/newWidget.js'));
    const missing = inspect();
    expect(missing.full).toBe(true);
    expect(missing.reason).toBe('client dependency discovery unresolved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('measures client related import reach and fans a broad shared client module out across the client shards (#17456)', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-client-reach-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, source) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  const shared = 'client/src/services/apiCore.js';
  const narrow = 'client/src/components/lonely/Lonely.jsx';
  const leaf = 'server/lib/shared/leaf.js';
  const consumers = CLIENT_FANOUT_TEST_FILES + 1;
  const inspect = (changedFiles) => {
    const inputs = collectPlanInputs({ baseSha: 'HEAD', changedFiles, cwd: root });
    return { inputs, plan: buildCiTestPlan(inputs.changedFiles, inputs) };
  };
  try {
    git('init', '-q');
    write(leaf, 'export const value = 1;\n');
    write(shared, "export { value } from '../../../server/lib/shared/leaf.js';\n");
    write(narrow, 'export const Lonely = () => null;\n');
    write('client/src/components/lonely/Lonely.test.jsx', "import './Lonely.jsx';\n");
    for (let i = 0; i < consumers; i += 1) {
      const dir = `client/src/pages/p${String(i).padStart(3, '0')}`;
      // A lazy edge: the related walk follows it, so the reach is dynamic-aware.
      write(`${dir}/Page.jsx`, "export const load = () => import('../../services/apiCore.js');\n");
      write(`${dir}/Page.test.jsx`, "import './Page.jsx';\n");
    }
    // A guard check lives in the client tree but no client runner collects it.
    write('client/src/test/guards/structure/apiCore.guard.test.js', "import '../../../services/apiCore.js';\n");
    git('add', '--all');

    const broad = inspect([shared]);
    expect(broad.inputs.serverReach).toBeNull();
    expect(broad.inputs.clientReach).toMatchObject({ selected: consumers, rows: [{ source: shared, staticReach: 0, dynamicReach: consumers }] });
    expect(broad.plan).toMatchObject({ full: false, client: { mode: 'related', sources: [shared] } });
    // Explicit selectors stay few; only the measured reach fans the runner out.
    expect(broad.plan.client.files.length).toBeLessThanOrEqual(CLIENT_FANOUT_TEST_FILES);
    expect(broad.plan.shards.client).toEqual(shardIndexes('full', FULL_SUITE_SHARDS.client));
    expect(broad.plan.shards.server).toEqual([1]);
    expect(broad.plan.suiteReasons.client).toMatch(new RegExp(
      `related import reach of ${consumers} suites exceeds the ${CLIENT_FANOUT_TEST_FILES}-file cap, sharded ${FULL_SUITE_SHARDS.client} ways`));
    expect(broad.plan.suiteReasons.client).toContain(`dynamic-aware fan-out ${consumers} suite(s): ${shared} ${consumers} (static 0)`);
    // The step summary carries the reach-based fan-out.
    const summary = formatPlanSummary(githubPlanOutput(broad.plan), broad.plan.shards);
    expect(summary).toContain(`related import reach of ${consumers} suites exceeds the ${CLIENT_FANOUT_TEST_FILES}-file cap`);
    expect(summary).toContain(`Client tests: \`related\` (shards \`${JSON.stringify(broad.plan.shards.client)}\`)`);

    const small = inspect([narrow]);
    expect(small.inputs.clientReach).toMatchObject({ selected: 1 });
    expect(small.plan.client.mode).toBe('related');
    expect(small.plan.shards.client).toEqual([1]);
    expect(small.plan.suiteReasons.client).not.toMatch(/sharded/);

    // A shared server/lib module the browser bundle imports is a client related
    // source too, so its client reach is measured alongside the server reach.
    const sharedServer = inspect([leaf]);
    expect(sharedServer.inputs.clientReach).toMatchObject({ selected: consumers });
    expect(sharedServer.plan.client.sources).toContain(leaf);
    expect(sharedServer.plan.shards.client).toEqual(shardIndexes('full', FULL_SUITE_SHARDS.client));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('counts the real-Chromium client suites a change reaches and fans the client out at four (#17616)', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-browser-reach-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, source) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  const inspect = (changedFiles) => {
    const inputs = collectPlanInputs({ baseSha: 'HEAD', changedFiles, cwd: root });
    return { inputs, plan: buildCiTestPlan(inputs.changedFiles, inputs) };
  };
  // A fixture names what it renders only inside strings: the virtual module and optimizeDeps.entries.
  const suite = (entry) => [
    "import { startBrowserFixture } from '../../../scripts/lib/browserFixture.js';",
    `const config = { optimizeDeps: { entries: ['${entry}'] } };`,
    `const fixture = \`import Rendered from '/${entry}';\`;`,
  ].join('\n');
  const suites = Array.from({ length: 5 }, (_, i) => `client/src/components/s${i}.browser.test.js`);
  try {
    git('init', '-q');
    write('scripts/lib/browserFixture.js', 'export const startBrowserFixture = () => null;\n');
    write('client/package.json', '{"name":"client"}\n');
    write('client/postcss.config.js', 'export default {};\n');
    write('client/src/index.css', '@import "tailwindcss";\n');
    write('client/src/themes/tokens.js', "import { palette } from '../palette.js';\nexport const tokens = palette;\n");
    write('client/src/palette.js', 'export const palette = 1;\n');
    write('client/src/components/ui/Menu.jsx', "import './Menu.css';\nexport const Menu = () => null;\n");
    write('client/src/components/ui/Menu.css', '.menu {}\n');
    write('client/src/pages/Other.jsx', 'export const Other = () => null;\n');
    write('client/src/pages/HtmlPages.jsx', 'export const HtmlPages = () => null;\n');
    suites.forEach((path, i) => write(path, suite(i < 4 ? 'src/components/ui/Menu.jsx' : 'src/pages/Other.jsx')));
    git('add', '--all');

    const reach = (changed) => inspect(changed).inputs.clientBrowserReach?.selected;
    expect(reach(['client/src/components/ui/Menu.jsx'])).toBe(4);
    expect(reach(['client/src/components/ui/Menu.css'])).toBe(4);
    expect(reach(['client/src/pages/Other.jsx'])).toBe(1);
    expect(reach(['client/src/pages/HtmlPages.jsx'])).toBe(0);
    // A module a shared input imports is on every served key too.
    for (const shared of ['client/src/index.css', 'client/src/themes/tokens.js', 'client/src/palette.js', 'client/postcss.config.js', 'client/package.json', 'scripts/lib/browserFixture.js']) {
      expect(reach([shared]), shared).toBe(5);
    }
    expect(inspect(['docs/notes.md']).inputs.clientBrowserReach).toBeNull();

    const menu = inspect(['client/src/components/ui/Menu.jsx']).plan;
    expect(menu).toMatchObject({ full: false, client: { mode: 'related' } });
    expect(menu.client.files.length).toBeLessThan(CLIENT_FANOUT_TEST_FILES);
    expect(menu.shards.client).toEqual(shardIndexes('full', FULL_SUITE_SHARDS.client));
    expect(menu.suiteReasons.client).toContain(`4 real-Chromium suites selected (at least ${CLIENT_BROWSER_FANOUT_SUITES}), sharded ${FULL_SUITE_SHARDS.client} ways`);
    expect(inspect(['client/src/index.css']).plan.shards.client).toEqual(shardIndexes('full', FULL_SUITE_SHARDS.client));
    for (const narrow of ['client/src/pages/HtmlPages.jsx', 'client/src/pages/Other.jsx']) {
      const plan = inspect([narrow]).plan;
      expect(plan.client.mode, narrow).toBe('related');
      expect(plan.shards.client, narrow).toEqual([1]);
      expect(plan.suiteReasons.client, narrow).not.toMatch(/sharded/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('shares source reads within one collection and observes edits and unreadable sources in the next', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-snapshot-'));
  const inputsModule = new URL('./ciPlanInputs.js', import.meta.url).href;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const leaf = 'server/lib/first.js';
  const second = 'server/lib/second.js';
  const bridge = 'server/lib/bridge.js';
  const browser = BROWSER_SUITES[0];
  const db = 'server/routes/decks.db.test.js';
  try {
    git('init', '-q');
    write(leaf, 'export const value = 1;\n');
    write(second, 'export const value = 2;\n');
    write(bridge, "export { value } from './first.js';\n");
    for (const entry of ['client/src/consumer.js', browser, db, 'server/lib/consumer.test.js']) {
      const relative = posix.relative(posix.dirname(entry), bridge);
      write(entry, `import '${relative.startsWith('.') ? relative : `./${relative}`}';\n`);
    }
    git('add', '--all');

    // A subprocess observes actual disk reads without changing Vitest's own fs.
    // This catches repeated reads across client, DB, browser and reach scans,
    // while the same process also proves no snapshot survives the next call.
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const original = fs.readFileSync;
      const reads = new Map();
      fs.readFileSync = function(path, ...args) {
        reads.set(String(path), (reads.get(String(path)) ?? 0) + 1);
        return original.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      const fixtureRoot = ${JSON.stringify(root)};
      const { collectPlanInputs } = await import(${JSON.stringify(inputsModule)});
      const collect = () => collectPlanInputs({ baseSha: 'HEAD', changedFiles: [${JSON.stringify(leaf)}], cwd: fixtureRoot });
      const first = collect();
      const bridgeReads = reads.get(join(fixtureRoot, ${JSON.stringify(bridge)}));
      fs.writeFileSync(${JSON.stringify(bridge)}, "export { value } from './second.js';\\n");
      const edited = collect();
      fs.unlinkSync(${JSON.stringify(bridge)});
      fs.mkdirSync(${JSON.stringify(bridge)});
      const warn = console.warn;
      console.warn = () => {};
      const unreadable = collect();
      console.warn = warn;
      console.log(JSON.stringify({ first, edited, unreadable, bridgeReads }));
    `], { cwd: root, encoding: 'utf8' }));
    expect(result.bridgeReads).toBe(1);
    for (const [inputs, present, absent] of [[result.first, leaf, second], [result.edited, second, leaf]]) {
      expect(inputs.clientDependencies).toContain(present);
      expect(inputs.clientDependencies).not.toContain(absent);
      expect(inputs.dbDependencies).toContain(present);
      expect(inputs.dbDependencies).not.toContain(absent);
      expect(inputs.browserDependencies[browser]).toContain(present);
      expect(inputs.browserDependencies[browser]).not.toContain(absent);
    }
    expect(result.first.serverReach.selected).toBeGreaterThan(0);
    expect(result.edited.serverReach.selected).toBe(0);
    expect(result.unreadable.clientDependencies).toBeNull();
    expect(result.unreadable.dbDependencies).toBeNull();
    expect(result.unreadable.browserDependencies[browser]).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('still runs a job when the diff deletes one of its entry points', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-plan-gates-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const deleted = LINUX_CONTAINMENT_TESTS[0];
    const inputs = collectPlanInputs({ baseSha: 'HEAD', changedFiles: [deleted], cwd: root });
    expect(buildCiTestPlan(inputs.changedFiles, inputs).linuxContainment).toBe(true);
    expect(buildCiTestPlan(['docs/README.md'], inputs).linuxContainment).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('collects the two-dot tree diff, including both sides of a rename', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-gated-diff-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.com',
    '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    mkdirSync(join(root, 'server/lib'), { recursive: true });
    writeFileSync(join(root, 'server/lib/old.js'), 'export const a = "a long enough body to be detected as a rename";\n');
    git('add', '--all');
    git('commit', '-q', '--no-verify', '-m', 'base');
    const green = git('rev-parse', 'HEAD');
    git('mv', 'server/lib/old.js', 'server/lib/new.js');
    git('commit', '-q', '--no-verify', '-m', 'rename');
    const inputs = collectPlanInputs({ forceFull: true, gatedBaseSha: green, cwd: root });
    expect(inputs.gatedChangedFiles.sort()).toEqual(['server/lib/new.js', 'server/lib/old.js']);
    expect(inputs.linuxContainmentInputs).toEqual(expect.arrayContaining(LINUX_CONTAINMENT_TESTS));
    // Without a gated base a forced-full run skips the walks entirely.
    expect(collectPlanInputs({ forceFull: true, cwd: root })).toMatchObject({ gatedChangedFiles: null, linuxContainmentInputs: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
