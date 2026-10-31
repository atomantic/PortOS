import { beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDbTestFiles } from './lib/dbTestFiles.js';
import { staticImportClosure } from '../server/lib/staticImportGraph.js';
import { TRUSTED_REBUILDS } from './trusted-rebuilds.js';
import { workflowJobs } from './lib/workflowJobs.js';

import {
  ALWAYS_RUN_TESTS,
  BROWSER_SUITES,
  buildCiTestPlan,
  classifyDependencyChange,
  WINDOWS_INSTALLED_WORKSPACES,
  collectPlanInputs,
  collectSuperColliderLiveInputs,
  emitGitHubPlan,
  forceFullReasonFor,
  FULL_SUITE_SHARDS,
  isRouteOnlyAppDiff,
  LINUX_CONTAINMENT_TESTS,
  MAX_TARGETED_TEST_FILES,
  needsSlashdoSubmodule,
  PLATFORM_PACKAGE_RES,
  shardIndexes,
  SLASHDO_GITLINK_PATH,
  sourceReferencePattern,
  splitByRunner,
  structuralTestsFor,
  SUPERCOLLIDER_LIVE_ENTRIES,
  DOCKER_CONTAINMENT_LIVE_ENTRIES,
  WINDOWS_CONTRACT_TESTS,
  WINDOWS_RISK_RULES,
} from './ci-test-plan.js';

// Capture the planner's stderr so a spawn adds nothing to the run's output; a
// failing spawn still reports it on the thrown error.
const PLANNER_STDIO = ['ignore', 'pipe', 'pipe'];

// Every read-only real-tree case shares ONE whole-repository collection (1-2s
// each). It is collected with the union of the sources those cases plan, then
// each case plans its own source alone: the collected maps are keyed per
// source/test/suite, and buildCiTestPlan consults only the entries for the
// files it is handed, so the union is a superset that never widens a plan.
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REAL_TREE_SOURCES = [
  'server/lib/postScoring.js', 'server/lib/editorial/checkInfra/taxonomy.js',
  'server/routes/decks.js', 'server/services/modelPinRecords.js', 'server/services/backup.js',
  'client/src/components/catalog/GreyboxViewer.jsx', 'client/src/components/catalog/GreyboxCapture.jsx',
  'client/src/components/catalog/GreyboxPanel.jsx', 'client/src/pages/CatalogIngredient.jsx', 'server/lib/greyboxCapture.js',
  'client/src/lib/musicVideoFrameCapture.js', 'client/src/components/musicVideo/FrameStepper.jsx',
  'client/src/components/musicVideo/PreviewVideo.jsx', 'client/src/components/musicVideo/ProductionReviewPanel.jsx',
];
let realTreeInputs;
const realTree = () => (realTreeInputs ??= collectPlanInputs({ baseSha: 'HEAD', changedFiles: REAL_TREE_SOURCES, cwd: REPO_ROOT }));

const TRACKED = [
  'server/lib/index.js',
  'server/lib/index.test.js',
  'server/lib/bufferedSpawn.js',
  'server/routes/auth.test.js',
  'server/routes/sprites.test.js',
  'server/services/auth.js',
  'server/services/auth.test.js',
  'server/services/catalogDB/facets.js',
  'server/services/catalogDB/facets.db.test.js',
  'server/services/sprites/animationTracks.js',
  'server/services/sprites/animationTracks.test.js',
  'server/services/sprites/atlas.js',
  'server/services/sprites/atlas.test.js',
  'server/services/sprites/atlasGrid.js',
  'server/services/sprites/atlasGrid.test.js',
  'server/services/sprites/atlasLayout.js',
  'server/services/sprites/atlasLayout.test.js',
  'server/services/taskPromptDefaults.test.js',
  'server/lib/slashdoLoader.js',
  'server/lib/slashdoLoader.test.js',
  'server/lib/slashdoInvocation.js',
  'server/lib/slashdoInvocation.test.js',
  'server/lib/bufferedSpawn.test.js',
  'server/lib/platform.test.js',
  'server/lib/shellCd.test.js',
  'server/lib/shellCd.js',
  'server/services/agentTuiSpawning.test.js',
  'client/src/a11yConventions.test.js',
  'client/src/App.jsx',
  'client/src/App.test.jsx',
  'client/src/hooks/mountedRefConventions.test.js',
  'client/src/components/catalog/CatalogCard.jsx',
  'client/src/components/catalog/CatalogCard.test.jsx',
  'client/src/components/sprites/WalkWorkflow.test.jsx',
  'client/src/hooks/useAsyncAction.js',
  'client/src/lib/catalogLinks.js',
  'client/src/lib/index.test.js',
  'client/src/services/apiSprites.test.js',
  'scripts/migrations/210-example.js',
  'scripts/migrations/210-example.test.js',
  'scripts/fix-windows-console.js',
];

it('selects checkout-cache contracts only in their installed-dependency runners', () => {
  const serverContract = 'scripts/workspaceCaches.test.js';
  const clientContract = 'client/src/test/workspaceCaches.test.js';
  const shared = [
    '.github/workflows/ci.yml', 'package.json', 'scripts/lib/workspaceCacheFixture.js',
    'scripts/lib/vitestTempRootFixture.js', 'scripts/lib/vitestTempRoot.js',
    'scripts/lib/vitestWatch.js', 'scripts/lib/testProcessAttribution.js', 'scripts/lib/testOwnedProcesses.js', 'scripts/lib/darwinTestProcesses.py',
    'scripts/lib/vitestStaleRunRoots.js', 'scripts/lib/dbTestFiles.js', 'scripts/lib/workspaceTests.js',
    'scripts/vitestCiPool.js', 'scripts/vitestTempRootSetup.js', 'server/lib/killWithEscalation.js',
    'server/test/ownedBrowserDiagnostics.js', 'server/lib/mockPathsDataRoot.js',
  ];
  const server = [
    'server/package.json', 'server/package-lock.json',
    'server/vitest.config.js', 'server/vitest.config.db.js', 'server/vitest.setup.js',
    'server/test/admissionSetup.js', 'server/test/mediaRegistryEnvironment.js',
  ];
  const client = [
    'ecosystem.config.cjs', 'client/package.json', 'client/package-lock.json',
    'client/vite.config.js', 'client/vite.buildEnv.js', 'client/vite.chunkGroups.js',
    'client/vitest.config.js', 'client/src/test/timeouts.js', 'scripts/vitestProcessEnvironment.js',
    'scripts/dev-start.js', 'scripts/publish-client-build.js',
    'scripts/lib/envFile.cjs', 'scripts/lib/databaseSettings.cjs',
    'lib/portosAuthCore.js', 'server/lib/eidoverseProxyRoutes.js',
  ];
  const trackedFiles = [...TRACKED, ...shared, ...server, ...client, serverContract, clientContract];
  for (const [inputs, owners] of [[shared, [serverContract, clientContract]], [server, [serverContract]], [client, [clientContract]]]) {
    for (const input of inputs) {
      const selected = structuralTestsFor([input], new Set(trackedFiles));
      const plan = buildCiTestPlan([input], { trackedFiles });
      for (const [contract, runner] of [[serverContract, 'server'], [clientContract, 'client']]) {
        expect(selected.includes(contract), input + ' -> ' + runner).toBe(owners.includes(contract));
        // Full CI still runs both complete workspaces; scoped plans preserve ownership.
        if (owners.includes(contract)) expect(plan[runner].mode === 'full' || plan[runner].files.includes(contract), input).toBe(true);
      }
      expect(plan.server.files, input).not.toContain(clientContract);
      expect(plan.client.files, input).not.toContain(serverContract);
    }
  }
  for (const input of ['docs/CONTRIBUTING.md', 'server/services/auth.js']) {
    const plan = buildCiTestPlan([input], { trackedFiles });
    expect(plan.full, input).toBe(false);
    expect(plan.server.files, input).not.toContain(serverContract);
    expect(plan.client.files, input).not.toContain(clientContract);
  }
  expect(structuralTestsFor([...shared, ...server, ...client], new Set())).toEqual([]);
});

const REVIEW_LOOP_SNAPSHOT = 'server/services/promptSections/__snapshots__/reviewLoopMatrix/local-gh.txt';
const REVIEW_LOOP_OWNER = 'server/services/promptSections/reviewLifecycleMatrix.test.js';
const REVIEW_LIFECYCLE_SOURCE = 'server/services/promptSections/reviewLifecycle.js';
const REVIEW_LIFECYCLE_TEST = 'server/services/promptSections/reviewLifecycle.test.js';
const REVIEW_LOOP_TRACKED = [
  ...TRACKED,
  REVIEW_LOOP_SNAPSHOT,
  REVIEW_LOOP_OWNER,
  REVIEW_LIFECYCLE_SOURCE,
  REVIEW_LIFECYCLE_TEST,
];

it('preserves Git-quoted source and contract paths through the planner CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-paths-'));
  const planner = fileURLToPath(new URL('./ci-test-plan.js', import.meta.url));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const source = 'server/lib/example.js';
  const unicodeSource = 'server/lib/café.js';
  const contract = 'server/lib/café.test.js';
  const write = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const commit = () => {
    git('add', '--all');
    git('-c', 'user.name=Example Contributor', '-c', 'user.email=contributor@example.com',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  };
  const plan = (base) => JSON.parse(execFileSync(process.execPath, [planner], {
    cwd: root,
    encoding: 'utf8', stdio: PLANNER_STDIO,
    env: { ...process.env, CI_BASE_SHA: base, CI_BASE_REF: 'main', CI_FORCE_FULL: 'false', GITHUB_OUTPUT: '' },
  }));
  try {
    git('init', '-q');
    git('config', 'core.hooksPath', join(root, 'empty-hooks'));
    git('config', 'core.quotePath', 'true');
    write(source, 'export const value = 1;\n');
    write(unicodeSource, 'export const value = 1;\n');
    write(contract, '// Reads example.js as text rather than importing it.\n');
    commit();
    const base = git('rev-parse', 'HEAD');
    write(source, 'export const value = 2;\n');
    commit();
    const sourcePlan = plan(base);
    expect(sourcePlan.full).toBe(false);
    expect(JSON.parse(sourcePlan.server_files)).toContain(contract);

    write(unicodeSource, 'export const value = 2;\n');
    commit();
    const unicodePlan = plan(base);
    expect(unicodePlan.full).toBe(false);
    expect(unicodePlan.changed_files).toEqual([unicodeSource, source]);
    expect(JSON.parse(unicodePlan.server_sources)).toContain(unicodeSource);
    expect(JSON.parse(unicodePlan.server_files)).toContain(contract);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

describe('real shared-source import chains', () => {
  const cwd = REPO_ROOT;
  let inputs;
  // Synthetic mutation and recollection regressions below keep their separate
  // per-call snapshots.
  beforeAll(() => {
    inputs = realTree();
  });

  it('schedules the real client precision-copy import chain for a shared scoring change', () => {
    const source = 'server/lib/postScoring.js';
    const plan = buildCiTestPlan([source], inputs);

    expect(plan.full).toBe(false);
    expect(plan.server.mode).toBe('related');
    expect(plan.server.sources).toContain(source);
    expect(plan.client.mode).toBe('related');
    expect(plan.client.sources).toContain(source);
    expect(plan.build).toBe(true);
    // The test names its client helper, not postScoring: only import-graph
    // selection can reach this regression through the intermediate module.
    expect(inputs.pathContractTests[source]).not.toContain('client/src/lib/estimationTolerance.test.js');
    expect(staticImportClosure(join(cwd, 'client/src/lib/estimationTolerance.test.js')).files)
      .toContain(join(cwd, source));
  });

  it('schedules the real taxonomy-to-validation consumer chain for a nested editorial leaf', () => {
    const source = 'server/lib/editorial/checkInfra/taxonomy.js';
    const plan = buildCiTestPlan([source], inputs);

    expect(plan.full).toBe(false);
    expect(plan.server.mode).toBe('related');
    expect(plan.server.sources).toEqual([source]);
    // Explicit guards stay additive to the traversal.
    expect(plan.server.files).toEqual(expect.arrayContaining(ALWAYS_RUN_TESTS.filter((path) => path.startsWith('server/'))));
    // validation.test.js reaches the leaf only through pipelineValidation; it names
    // neither the leaf nor the editorial feature, so only traversal selects it.
    expect(plan.server.files).not.toContain('server/lib/validation.test.js');
    expect(staticImportClosure(join(cwd, 'server/lib/validation.test.js')).files)
      .toContain(join(cwd, source));
  });
});

it('keeps exact-file selection for a test-only diff and traverses a nested feature leaf for a differently named consumer', () => {
  const leaf = 'server/lib/widgets/inner/leaf.js';
  const featureTest = 'server/lib/widgets/widgets.test.js';
  // schemaHub.test.js reaches the leaf only through middle modules and shares no
  // name with it or its feature: the plan must hand the leaf to the import graph.
  const trackedFiles = [leaf, 'server/lib/middle.js', 'server/lib/schemaHub.test.js', featureTest];
  const plan = buildCiTestPlan([leaf], { trackedFiles, clientDependencies: [] });
  expect(plan.full).toBe(false);
  expect(plan.server.mode).toBe('related');
  expect(plan.server.sources).toEqual([leaf]);
  expect(plan.server.files).toContain(featureTest);

  const testOnly = buildCiTestPlan([featureTest], { trackedFiles, clientDependencies: [] });
  expect(testOnly.server).toMatchObject({ mode: 'files', sources: [] });
});

it('carries transitive browser re-exports through the planner CLI and fails closed on unresolved edges', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-browser-deps-'));
  const planner = fileURLToPath(new URL('./ci-test-plan.js', import.meta.url));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, source) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  const leaf = 'server/lib/shared/leaf.js';
  const clientSource = 'client/src/lib/consumer.js';
  const clientTest = 'client/src/lib/consumer.test.js';
  const serverOnly = 'server/lib/privateOnly.js';
  const plan = (changedFiles) => JSON.parse(execFileSync(process.execPath, [planner], {
    cwd: root,
    encoding: 'utf8', stdio: PLANNER_STDIO,
    env: { ...process.env, CI_BASE_SHA: 'HEAD', CI_BASE_REF: 'main', CI_FORCE_FULL: 'false',
      CI_CHANGED_FILES: JSON.stringify(changedFiles), GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
  }));
  try {
    git('init', '-q');
    WINDOWS_CONTRACT_TESTS.forEach(path => write(path, '// native inventory fixture\n'));
    write(leaf, 'export const value = 1;\n');
    write('server/lib/shared/leaf.ts', 'export const value = 3;\n');
    write('server/lib/bridge.js', "export { value } from './shared/leaf';\n");
    write(clientSource, "export { value } from '../../../server/lib/bridge.js';\n");
    write(clientTest, "import { value } from './consumer.js';\n");
    write(serverOnly, 'export const privateValue = 2;\n');
    write('client/vite.config.js', 'export default {};\n');
    git('add', '--all');

    const shared = plan([leaf]);
    expect(shared).toMatchObject({ full: false, build: true,
      client_mode: 'related', client_sources: JSON.stringify([leaf]) });
    expect(shared.server_mode).not.toBe('skip');
    expect(plan(['server/lib/shared/leaf.ts'])).toMatchObject({ build: true,
      client_mode: 'related', client_sources: JSON.stringify(['server/lib/shared/leaf.ts']) });

    const mixed = plan([leaf, clientSource, clientTest]);
    expect(mixed).toMatchObject({ client_mode: 'related', client_sources: JSON.stringify([clientSource, leaf]),
      client_files: JSON.stringify([clientTest]) });
    expect(mixed.build).toBe(true);
    expect(plan([serverOnly])).toMatchObject({ full: false, build: false, client_mode: 'skip' });
    expect(plan([leaf, 'client/vite.config.js'])).toMatchObject({ full: true, build: true, client_mode: 'full' });

    write('server/lib/bridge.js', "export { value } from './missing.js';\n");
    expect(plan([leaf])).toMatchObject({ full: true, build: true, client_mode: 'full',
      reason: 'client dependency discovery unresolved' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('projects test-only shared re-exports and retains unresolved consumers without selecting a build', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-client-test-deps-'));
  const planner = fileURLToPath(new URL('./ci-test-plan.js', import.meta.url));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, source) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  const leaf = 'scripts/lib/cleanupLeaf.js';
  const unused = 'scripts/lib/unconsumed.js';
  const consumer = 'client/src/test/lifecycle.test.js';
  const unrelated = 'client/src/test/unrelated.test.js';
  const plan = (source) => JSON.parse(execFileSync(process.execPath, [planner], {
    cwd: root, encoding: 'utf8', stdio: PLANNER_STDIO,
    env: { ...process.env, CI_BASE_SHA: 'HEAD', CI_BASE_REF: 'main', CI_FORCE_FULL: 'false',
      CI_CHANGED_FILES: JSON.stringify([source]), GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
  }));
  try {
    git('init', '-q');
    write(leaf, 'export const value = 1;\n');
    write(unused, 'export const unused = 1;\n');
    write('scripts/lib/cleanupBridge.js', "export { value } from './cleanupLeaf.js';\n");
    write('client/src/test/fixture.js', "export { value } from '../../../scripts/lib/cleanupBridge.js';\nimport './generic';\n");
    write('client/src/test/generic.ts', 'const identity = <T,>(value: T) => value; const asserted = <Thing>value;\n');
    write(consumer, "const fixture = await import('./fixture.js');\n");
    write(unrelated, [
      '// import (#2895)',
      'const fixture = `import value from "./ProbeGood"; import(unknown)`;',
      'export const unrelated = 1;',
    ].join('\n'));
    git('add', '--all');

    expect(plan(leaf)).toMatchObject({ full: false, build: false,
      client_mode: 'files', client_files: JSON.stringify([consumer]) });
    expect(plan(unused)).toMatchObject({ full: false, build: false, client_mode: 'skip' });

    write('client/src/test/fixture.js', "export { value } from './missing.js';\n");
    expect(plan(leaf)).toMatchObject({ full: false, build: false,
      client_mode: 'files', client_files: JSON.stringify([consumer]) });

    write(consumer, "const fixture = await import(globalThis.fixturePath);\n");
    expect(plan(leaf)).toMatchObject({ full: false, build: false,
      client_mode: 'files', client_files: JSON.stringify([consumer]) });
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

it('shares source reads within one collection and observes edits and unreadable sources in the next', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-snapshot-'));
  const planner = new URL('./ci-test-plan.js', import.meta.url).href;
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
      const { collectPlanInputs } = await import(${JSON.stringify(planner)});
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

it('requests DB verification for every shape of suite in the real canonical inventory without widening the matrix', () => {
  const inputs = realTree();
  const dbTests = resolveDbTestFiles(inputs.trackedFiles);
  expect(dbTests.length).toBeGreaterThan(50);
  // Routing keys on the same resolver that built this list, so one real suite
  // per inventory shape proves the rule; planning all 50+ only repeated it.
  const shapes = {
    scripts: (path) => path.startsWith('scripts/'),
    globbed: (path) => path.endsWith('/db.test.js'),
    unmarked: (path) => !path.includes('.db.') && !path.endsWith('/db.test.js'),
    realBrowser: (path) => path.includes('.realBrowser.db.'),
    named: (path) => path.startsWith('server/') && /\.db\.test\.js$/.test(path) && !path.includes('.realBrowser.'),
  };
  const representatives = Object.entries(shapes).map(([shape, matches]) => {
    const suite = dbTests.find(matches);
    expect(suite, shape).toBeDefined();
    return suite;
  });
  for (const suite of representatives) {
    const plan = buildCiTestPlan([suite], inputs);
    expect(plan, suite).toMatchObject({ full: false, db: true, server: { mode: 'files' } });
    expect(plan.server.files, suite).not.toContain(suite);
  }
});

it('keeps PostgreSQL tests out of ordinary server runner selection and routes them to the DB stage (#13455)', () => {
  const dbSuite = 'server/services/githubNotifications.db.test.js';
  const plan = buildCiTestPlan([dbSuite], { trackedFiles: [dbSuite] });
  expect(plan.server.files).not.toContain(dbSuite);
  expect(plan.server.mode).toBe('skip');
  expect(plan.db).toBe(true);
});

it('runs the whole-tree import-cycle guards on a PR that touches one server/services file (#14327)', () => {
  const plan = buildCiTestPlan(['server/services/auth.js'], realTree());
  expect(plan.server.files).toEqual(expect.arrayContaining([
    'server/services/agentImportCycles.test.js',
    'server/services/meatspacePostImportCycles.test.js',
    'server/services/serviceImportCycles.test.js',
    'server/services/twinImportCycles.test.js',
  ]));
});

it('requests DB verification for the real deck, model pin and backup source contracts', () => {
  const sources = ['server/routes/decks.js', 'server/services/modelPinRecords.js', 'server/services/backup.js'];
  const inputs = realTree();
  for (const source of sources) {
    expect(buildCiTestPlan([source], inputs), source).toMatchObject({ full: false, db: true });
  }
});

it('follows DB-only deferred dependencies through the pre-install CLI and preserves conservative and unrelated plans', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-db-deps-'));
  const planner = fileURLToPath(new URL('./ci-test-plan.js', import.meta.url));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, source) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  const leaf = 'server/services/example/leaf.js';
  const contract = 'server/routes/decks.db.test.js';
  const plan = (changedFiles) => JSON.parse(execFileSync(process.execPath, [planner], {
    cwd: root,
    encoding: 'utf8', stdio: PLANNER_STDIO,
    env: { ...process.env, CI_BASE_SHA: 'HEAD', CI_BASE_REF: 'main', CI_FORCE_FULL: 'false',
      CI_CHANGED_FILES: JSON.stringify(changedFiles), GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
  }));
  try {
    git('init', '-q');
    write(leaf, 'export const value = 1;\n');
    write('server/services/bridge.js', [
      '// import (#1945)',
      'const fixture = `import value from "./ProbeGood"; import(unknown)`;',
      "export const load = () => import('./example/leaf.js');",
    ].join('\n'));
    write(contract, "import '../services/bridge.js';\n");
    write('server/services/unrelated.js', 'export const value = 2;\n');
    git('add', '--all');

    // The contract neither names leaf.js nor shares its feature; only the
    // dependency walk can request the otherwise excluded database suite.
    const related = plan([leaf]);
    expect(related).toMatchObject({ full: false, db: true, server_mode: 'related' });
    expect(JSON.parse(related.server_files)).not.toContain(contract);
    expect(plan(['server/services/unrelated.js'])).toMatchObject({ full: false, db: false });
    expect(plan(['docs/README.md'])).toMatchObject({ full: false, db: false });

    // Basename and feature selectors must trigger DB coverage too.
    write('server/services/bridge.js', 'export const value = 2;\n');
    write(contract, '// Reads leaf.js as text.\n');
    expect(plan([leaf])).toMatchObject({ full: false, db: true });
    write(contract, '// A deck contract.\n');
    write('server/services/decks/leaf.js', 'export const value = 1;\n');
    git('add', '--all');
    expect(plan(['server/services/decks/leaf.js'])).toMatchObject({ full: false, db: true });

    for (const importExpression of ["'./missing.js'", 'modulePath']) {
      write(contract, "import '../services/bridge.js';\n");
      write('server/services/bridge.js', `export const load = () => import(${importExpression});\n`);
      expect(plan([leaf])).toMatchObject({ full: false, db: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('CI test impact planner', () => {
  it('selects executable documentation tests, including contracts outside the always-run list', () => {
    const paths = ['docs/features/product-surfaces.test.js', 'docs/example.test.js'];
    const plan = buildCiTestPlan(paths, { trackedFiles: [...TRACKED, ...paths] });

    expect(plan.full).toBe(false);
    expect(plan.server.mode).toBe('files');
    expect(plan.server.files).toEqual(expect.arrayContaining(paths));
    expect(plan.client.mode).toBe('skip');
  });

  it('covers the product-surfaces Markdown input without widening ordinary documentation changes', () => {
    const contract = 'docs/features/product-surfaces.test.js';
    const plan = buildCiTestPlan(['docs/features/product-surfaces.md'], {
      trackedFiles: [...TRACKED, contract],
    });

    expect(plan).toMatchObject({ full: false, reason: 'documentation-only change',
      server: { mode: 'files' }, client: { mode: 'skip' }, build: false, db: false, windows: false });
    expect(plan.server.files).toContain(contract);
  });

  it('skips all expensive jobs for documentation-only changes, keeping the always-run guards', () => {
    const plan = buildCiTestPlan([
      '.changelog/NEXT.md',
      'docs/GITHUB_ACTIONS.md',
    ], { trackedFiles: TRACKED });

    expect(plan).toMatchObject({
      full: false,
      reason: 'documentation-only change',
      server: { mode: 'files', files: ['server/services/taskPromptDefaults.test.js'] },
      client: { mode: 'skip' },
      db: false,
      lint: { mode: 'skip' },
      build: false,
      smoke: false,
      windows: false,
    });
  });

  // Quality snapshot PRs land through the publisher's immediate merge; their
  // diff is one numeric data file nothing reads from the checkout.
  it('skips every job, always-run guards included, for a quality-snapshot-only change', () => {
    const plan = buildCiTestPlan(['.quality.json'], { trackedFiles: [...TRACKED, '.quality.json'] });

    expect(plan).toMatchObject({
      full: false,
      reason: 'generated data-only change',
      server: { mode: 'skip' },
      client: { mode: 'skip' },
      browserFiles: [],
      db: false,
      lint: { mode: 'skip' },
      build: false,
      smoke: false,
      windows: false,
    });
  });

  it('keeps the always-run guards when the quality snapshot rides with other changes', () => {
    const docs = buildCiTestPlan(['.quality.json', 'docs/GITHUB_ACTIONS.md'], { trackedFiles: [...TRACKED, '.quality.json'] });
    expect(docs).toMatchObject({ reason: 'documentation-only change', server: { mode: 'files' } });
    expect(docs.server.files).toContain('server/services/taskPromptDefaults.test.js');

    const code = buildCiTestPlan(['.quality.json', 'server/services/auth.js'], { trackedFiles: [...TRACKED, '.quality.json'] });
    expect(code.reason).not.toMatch(/unmapped executable surface/);
    expect(code.server.mode).not.toBe('skip');
  });

  // The prompt-integrity snapshot guards a cross-install upgrade contract that
  // no other test covers, so no impact scope may drop it — including the scopes
  // that otherwise skip the server runner entirely.
  it('runs the prompt-integrity guard under every impact scope', () => {
    const scopes = [
      [],                                                   // no changed files
      ['docs/GITHUB_ACTIONS.md'],                           // documentation-only
      ['client/src/components/catalog/CatalogCard.jsx'],    // client-only (server would skip)
      ['server/services/auth.js'],                          // server related-mode
      ['server/services/sprites/atlas.js'],                 // server files-mode
    ];

    for (const changed of scopes) {
      const plan = buildCiTestPlan(changed, { trackedFiles: TRACKED });
      expect(plan.server.mode, JSON.stringify(changed)).not.toBe('skip');
      expect(plan.server.files, JSON.stringify(changed))
        .toContain('server/services/taskPromptDefaults.test.js');
    }

    // A full plan runs everything, so it carries no explicit selector list.
    const full = buildCiTestPlan(['.github/workflows/ci.yml'], { trackedFiles: TRACKED });
    expect(full.server.mode).toBe('full');
  });

  // The docs-only branch names its selectors directly rather than going through
  // the runner split the scoped branches use, so it splits them itself. Handing
  // a client/src guard to the server runner (which does not glob client/) would
  // report green having run it nowhere.
  it('routes always-run selectors to the runner that globs them', () => {
    expect(splitByRunner([
      'server/services/taskPromptDefaults.test.js',
      'scripts/agent-instructions-files.test.js',
      'client/src/a11yConventions.test.js',
    ])).toEqual({
      server: ['server/services/taskPromptDefaults.test.js', 'scripts/agent-instructions-files.test.js'],
      client: ['client/src/a11yConventions.test.js'],
    });
  });

  // Every guard on the list is unreachable by import-graph selection, so a
  // docs-only plan is the one scope where the complete list has to survive.
  it('carries every tracked always-run guard on a docs-only plan', () => {
    const tracked = [...TRACKED, ...ALWAYS_RUN_TESTS];
    const plan = buildCiTestPlan(['docs/GITHUB_ACTIONS.md'], { trackedFiles: tracked });
    const { server, client } = splitByRunner(ALWAYS_RUN_TESTS);

    expect(plan.server.mode).toBe('files');
    for (const guard of server) {
      expect(plan.server.files, guard).toContain(guard);
    }
    expect(plan.server.files.filter((path) => path.startsWith('client/'))).toEqual([]);

    if (client.length > 0) {
      expect(plan.client.mode).toBe('files');
      for (const guard of client) {
        expect(plan.client.files, guard).toContain(guard);
      }
    } else {
      expect(plan.client.mode).toBe('skip');
    }
  });

  it('maps every always-run guard to a runner', () => {
    // splitByRunner drops a path whose runnerForTest is null. A root-level
    // entry on ALWAYS_RUN_TESTS would then vanish from both jobs and the
    // docs-only plan would report green having run it nowhere.
    for (const path of ALWAYS_RUN_TESTS) {
      const { server, client } = splitByRunner([path]);
      expect(server.includes(path) || client.includes(path), path).toBe(true);
    }
  });

  it('runs the migration prompt-drift baseline on every plan', () => {
    expect(ALWAYS_RUN_TESTS).toContain('scripts/setup-data-drift.test.js');
  });

  it('omits an untracked always-run guard rather than handing Vitest a missing selector', () => {
    const plan = buildCiTestPlan(['docs/GITHUB_ACTIONS.md'], {
      trackedFiles: TRACKED.filter((path) => path !== 'server/services/taskPromptDefaults.test.js'),
    });

    expect(plan.server).toEqual({ mode: 'skip', files: [], sources: [] });
  });

  it('forces the full suite when CI or shared test configuration changes', () => {
    for (const path of [
      '.github/workflows/ci.yml',
      'server/vitest.config.js',
      'client/vitest.config.js',
      'client/src/test/setup.js',
      'server/lib/validation.js',
      // The client lint configuration. Both of these carry real enforced rules —
      // the .grit plugins include the crypto.randomUUID ban — so a change to
      // either must widen CI the same way the former eslint.config.js did. This
      // trigger went untested when it pointed at eslint.config.js, so the rename
      // to biome.jsonc could have silently matched nothing.
      'client/biome.jsonc',
      'client/lint-no-random-uuid.grit',
      'client/lint-react-legacy-apis.grit',
      'scripts/run-ci-tests.test.js',
      'scripts/vitestCiPool.js',
    ]) {
      const plan = buildCiTestPlan([path], { trackedFiles: TRACKED });
      expect(plan.full, path).toBe(true);
      expect(plan.server.mode, path).toBe('full');
      expect(plan.client.mode, path).toBe('full');
      expect(plan.db, path).toBe(true);
    }
  });

  it('scopes an App.jsx change only when its diff contains route declarations', () => {
    const routeDiff = [
      'diff --git a/client/src/App.jsx b/client/src/App.jsx',
      '--- a/client/src/App.jsx',
      '+++ b/client/src/App.jsx',
      '@@ -10 +10 @@',
      '-        <Route path="legacy" element={<Legacy />} />',
      '+        <Route path="current" element={<Current />} />',
    ].join('\n');

    expect(isRouteOnlyAppDiff(routeDiff)).toBe(true);
    const plan = buildCiTestPlan(['client/src/App.jsx'], {
      trackedFiles: TRACKED,
      appRouteOnly: isRouteOnlyAppDiff(routeDiff),
    });

    expect(plan).toMatchObject({
      full: false,
      server: { mode: 'files' },
      client: { mode: 'related', sources: ['client/src/App.jsx'] },
      db: false,
      build: true,
      smoke: false,
      windows: false,
    });
    expect(plan.suiteReasons.client).toMatch(/route-only/i);
    expect(plan.suiteReasons.db).toMatch(/skipped/i);
  });

  it('fails closed to the full matrix for any non-route App.jsx diff', () => {
    const providerDiff = [
      'diff --git a/client/src/App.jsx b/client/src/App.jsx',
      '--- a/client/src/App.jsx',
      '+++ b/client/src/App.jsx',
      '@@ -1 +1 @@',
      '-import { ExistingProvider } from \'./provider\';',
      '+import { NewProvider } from \'./provider\';',
    ].join('\n');

    expect(isRouteOnlyAppDiff(providerDiff)).toBe(false);
    const plan = buildCiTestPlan(['client/src/App.jsx'], {
      trackedFiles: TRACKED,
      appRouteOnly: isRouteOnlyAppDiff(providerDiff),
    });
    expect(plan).toMatchObject({ full: true, db: true, smoke: true, windows: false });
    expect(plan.reason).toMatch(/composition root changed/);
  });

  it('uses only the structural contract for a server barrel edit', () => {
    const plan = buildCiTestPlan(['server/lib/index.js'], { trackedFiles: TRACKED });

    expect(plan.full).toBe(false);
    expect(plan.server.mode).toBe('files');
    expect(plan.server.sources).toEqual([]);
    expect(plan.server.files).toContain('server/lib/index.test.js');
    expect(plan.client.mode).toBe('skip');
    expect(plan.db).toBe(false);
    expect(plan.windows).toBe(false);
  });

  // One row per structural trigger in structuralTestsFor. Each diff pairs the
  // trigger with an unrelated path, so a rule that only fires when every changed
  // file matches (`.some` → `.every`) drops its guard and fails here.
  const STRUCTURAL_GUARD_ROWS = [
    { changed: 'server/sockets/chat.js', runner: 'server', guards: ['server/sockets/asyncHandlerGuard.test.js'] },
    { changed: 'server/lib/bufferedSpawn.js', runner: 'server', guards: ['server/lib/index.test.js'] },
    { changed: 'server/routes/sprites.js', runner: 'server', guards: ['server/lib/apiRouteGraph.test.js', 'server/lib/apiRouteParity.test.js', 'scripts/generate-prompt-stage-call-sites.test.js'] },
    { changed: 'client/src/lib/catalogLinks.js', runner: 'client', guards: ['client/src/lib/index.test.js'] },
    { changed: 'client/src/hooks/useAsyncAction.js', runner: 'client', guards: ['client/src/hooks/index.test.js'] },
    { changed: 'client/src/utils/formatters.js', runner: 'client', guards: ['client/src/utils/index.test.js'] },
    { changed: 'client/src/components/catalog/CatalogCard.jsx', runner: 'client', guards: ['client/src/a11yConventions.test.js'] },
  ];
  it.each(STRUCTURAL_GUARD_ROWS)('schedules the structural guards for $changed in a mixed diff', ({ changed, runner, guards }) => {
    const trackedFiles = [...TRACKED, changed, ...STRUCTURAL_GUARD_ROWS.flatMap((row) => row.guards)];
    const plan = buildCiTestPlan([changed, 'server/services/auth.js'], { trackedFiles });

    expect(plan.full).toBe(false);
    for (const guard of guards) {
      expect(plan[runner].files, guard).toContain(guard);
    }
  });

  it('does not treat a source .grit or a mistyped biome.json as lint configuration', () => {
    // Guards the trigger regex against over-matching: only the client's top-level
    // config and its sibling .grit plugins should force a full run.
    for (const path of ['client/src/foo.grit', 'client/biome.json', 'clientx/biome.jsonc']) {
      const plan = buildCiTestPlan([path], { trackedFiles: TRACKED });
      expect(plan.reason, path).not.toMatch(/lint configuration changed/);
    }
  });

  it('selects the touched feature across server and client without pulling unrelated tests', () => {
    const plan = buildCiTestPlan([
      '.changelog/NEXT.md',
      'server/services/sprites/animationTracks.js',
      'server/services/sprites/animationTracks.test.js',
      'server/services/sprites/atlas.js',
      'server/services/sprites/atlas.test.js',
      'server/services/sprites/atlasGrid.js',
      'server/services/sprites/atlasGrid.test.js',
      'server/services/sprites/atlasLayout.js',
      'server/services/sprites/atlasLayout.test.js',
    ], { trackedFiles: TRACKED });

    expect(plan).toMatchObject({
      full: false,
      reason: 'targeted features: sprites',
      server: { mode: 'related' },
      client: { mode: 'files' },
      db: false,
      lint: { mode: 'files' },
      build: false,
      smoke: true,
    });
    expect(plan.server.files).toEqual([
      'server/routes/sprites.test.js',
      'server/services/sprites/animationTracks.test.js',
      'server/services/sprites/atlas.test.js',
      'server/services/sprites/atlasGrid.test.js',
      'server/services/sprites/atlasLayout.test.js',
      'server/services/taskPromptDefaults.test.js',
    ]);
    expect(plan.client.files).toEqual([
      'client/src/components/sprites/WalkWorkflow.test.jsx',
      'client/src/services/apiSprites.test.js',
    ]);
    expect(plan.server.files).not.toContain('server/services/auth.test.js');
  });

  it('uses Vitest related mode for flat modules whose impact is defined by imports', () => {
    const plan = buildCiTestPlan(['server/services/auth.js'], {
      trackedFiles: TRACKED,
    });

    expect(plan.full).toBe(false);
    expect(plan.server).toEqual({
      mode: 'related',
      files: ['server/services/taskPromptDefaults.test.js'],
      sources: ['server/services/auth.js'],
    });
    expect(plan.client.mode).toBe('skip');
    expect(plan.smoke).toBe(true);
  });

  it('adds structural guard tests and changed-file linting for client modules', () => {
    const plan = buildCiTestPlan([
      'client/src/components/catalog/CatalogCard.jsx',
      'client/src/lib/catalogLinks.js',
    ], { trackedFiles: TRACKED });

    expect(plan.full).toBe(false);
    expect(plan.client.mode).toBe('related');
    expect(plan.client.sources).toEqual([
      'client/src/components/catalog/CatalogCard.jsx',
      'client/src/lib/catalogLinks.js',
    ]);
    expect(plan.client.files).toContain('client/src/lib/index.test.js');
    expect(plan.client.files).toContain('client/src/a11yConventions.test.js');
    expect(plan.client.files).toContain('client/src/hooks/mountedRefConventions.test.js');
    expect(plan.lint).toEqual({
      mode: 'files',
      files: [
        'client/src/components/catalog/CatalogCard.jsx',
        'client/src/lib/catalogLinks.js',
      ],
    });
    expect(plan.build).toBe(true);
  });

  it('selects the mounted-ref guard for a plain-.js client change', () => {
    // The a11y guard only triggers on `.jsx`, but the StrictMode mounted-ref bug
    // reached 94 call sites through a `.js` hook — so this guard must be selected
    // by a change that touches no `.jsx` at all.
    const plan = buildCiTestPlan(['client/src/hooks/useAsyncAction.js'], { trackedFiles: TRACKED });

    expect(plan.client.files).toContain('client/src/hooks/mountedRefConventions.test.js');
    expect(plan.client.files).not.toContain('client/src/a11yConventions.test.js');
  });

  it('runs the DB suite when a database-backed adapter changes', () => {
    const plan = buildCiTestPlan([
      'server/services/catalogDB/facets.js',
      'server/services/catalogDB/facets.db.test.js',
    ], { trackedFiles: TRACKED });

    expect(plan.full).toBe(false);
    // A nested adapter still traverses its importers; the DB suite is additive.
    expect(plan.server.mode).toBe('related');
    expect(plan.server.sources).toContain('server/services/catalogDB/facets.js');
    expect(plan.db).toBe(true);
  });

  it('runs a directly changed migration test without broadening to the full suite', () => {
    const plan = buildCiTestPlan([
      'scripts/migrations/210-example.js',
      'scripts/migrations/210-example.test.js',
    ], { trackedFiles: TRACKED });

    expect(plan.full).toBe(false);
    expect(plan.server).toEqual({
      mode: 'related',
      files: ['scripts/migrations/210-example.test.js', 'server/services/taskPromptDefaults.test.js'],
      sources: ['scripts/migrations/210-example.js'],
    });
  });

  it('excludes deleted test files from exact selectors', () => {
    // `changed` includes deleted paths (diff-filter ACMRD), but neither
    // `TRACKED` (git ls-files) nor the trackedFiles fixture below lists them
    // — a deletion-only PR must not hand a nonexistent path to Vitest/ESLint
    // as an exact selector, which exits non-zero on a perfectly valid PR.
    const plan = buildCiTestPlan([
      'server/services/sprites/atlas.test.js', // deleted alongside its source
      'client/src/components/catalog/CatalogCard.test.jsx', // deleted test
      'docs/example.test.js', // executable documentation contract was removed
    ], { trackedFiles: TRACKED.filter((path) => ![
      'server/services/sprites/atlas.test.js',
      'client/src/components/catalog/CatalogCard.test.jsx',
    ].includes(path)) });

    expect(plan.full).toBe(false);
    expect(plan.server.files).not.toContain('server/services/sprites/atlas.test.js');
    expect(plan.server.files).not.toContain('docs/example.test.js');
  });

  it('widens when a changed executable source was deleted', () => {
    const plan = buildCiTestPlan(['client/src/lib/catalogLinks.js'], {
      trackedFiles: TRACKED.filter((path) => path !== 'client/src/lib/catalogLinks.js'),
    });

    expect(plan.full).toBe(true);
    expect(plan.reason).toMatch(/deleted executable source/);
  });

  it('runs the parsing contracts for a python sidecar script instead of the full suite', () => {
    const tracked = [
      ...TRACKED,
      'scripts/generate_ltx2.py',
      'scripts/_runner_common.py',
      'scripts/generate_ltx2.test.js',
      'server/services/videoGen/runtimes.test.js',
      'client/src/lib/videoRenderPhase.test.js',
    ];
    const pathContractTests = {
      'scripts/_runner_common.py': [
        'scripts/generate_ltx2.test.js',
        'server/services/videoGen/runtimes.test.js',
        'client/src/lib/videoRenderPhase.test.js',
        'server/lib/deleted.test.js',
      ],
    };

    const plan = buildCiTestPlan(['scripts/_runner_common.py'], { trackedFiles: tracked, pathContractTests });

    expect(plan).toMatchObject({
      full: false,
      reason: 'python script parsing contracts',
      server: { mode: 'files', sources: [] },
      client: { mode: 'files', sources: [] },
      windows: false,
      smoke: false,
      db: false,
    });
    expect(plan.server.files).toEqual(expect.arrayContaining([
      'scripts/generate_ltx2.test.js',
      'server/services/videoGen/runtimes.test.js',
      'server/services/taskPromptDefaults.test.js',
    ]));
    expect(plan.server.files).not.toContain('server/lib/deleted.test.js');
    expect(plan.client.files).toEqual(['client/src/lib/videoRenderPhase.test.js']);

    // A JS source in the same diff keeps its own import-graph selection; the
    // python contracts ride along as explicit files.
    const mixed = buildCiTestPlan(['scripts/_runner_common.py', 'server/services/auth.js'], {
      trackedFiles: tracked,
      pathContractTests,
    });
    expect(mixed.reason).toBe('Vitest related-test fallback');
    expect(mixed.server).toMatchObject({ mode: 'related', sources: ['server/services/auth.js'] });
    expect(mixed.server.files).toContain('scripts/generate_ltx2.test.js');
    expect(mixed.smoke).toBe(true);
  });

  it('selects a text-reading contract test by the changed file\'s basename (#6363)', () => {
    const tracked = [
      ...TRACKED,
      'client/src/pages/Calendar.jsx',
      'server/lib/navManifest.js',
      'server/lib/navManifest.test.js',
    ];
    // navManifest.test.js reads client/src/pages/Calendar.jsx with readFileSync
    // rather than importing it, so no `vitest related` edge reaches it — only
    // the basename lookup computed by main() and threaded through as
    // pathContractTests can.
    const pathContractTests = {
      'client/src/pages/Calendar.jsx': ['server/lib/navManifest.test.js'],
    };

    const plan = buildCiTestPlan(['client/src/pages/Calendar.jsx'], { trackedFiles: tracked, pathContractTests });

    expect(plan.full).toBe(false);
    expect(plan.server.files).toContain('server/lib/navManifest.test.js');
  });

  it('reaches a mirror-parity test from either side of the mirror by basename (#6363)', () => {
    const tracked = [
      ...TRACKED,
      'server/lib/eidoverseWorldReset.js',
      'server/lib/eidoverseWorldReset.parity.test.js',
      'client/src/lib/eidoverseWorldReset.js',
    ];
    // Both copies share one basename, and the mirror test names the OTHER copy
    // only by that basename — a mirror test living in server/lib is what a
    // change to either side must select.
    const pathContractTests = {
      'server/lib/eidoverseWorldReset.js': ['server/lib/eidoverseWorldReset.parity.test.js'],
      'client/src/lib/eidoverseWorldReset.js': ['server/lib/eidoverseWorldReset.parity.test.js'],
    };

    const serverSide = buildCiTestPlan(['server/lib/eidoverseWorldReset.js'], { trackedFiles: tracked, pathContractTests });
    expect(serverSide.server.files).toContain('server/lib/eidoverseWorldReset.parity.test.js');

    const clientSide = buildCiTestPlan(['client/src/lib/eidoverseWorldReset.js'], { trackedFiles: tracked, pathContractTests });
    expect(clientSide.server.files).toContain('server/lib/eidoverseWorldReset.parity.test.js');
  });

  describe('explicit text fixture ownership', () => {
    it('selects the review-loop snapshot owner and always-run guards without full CI', () => {
      const plan = buildCiTestPlan([REVIEW_LOOP_SNAPSHOT], { trackedFiles: REVIEW_LOOP_TRACKED });

      expect(plan).toMatchObject({
        full: false,
        server: {
          mode: 'files',
          files: [REVIEW_LOOP_OWNER, 'server/services/taskPromptDefaults.test.js'],
          sources: [],
        },
        client: { mode: 'skip' },
        db: false,
        build: false,
        smoke: false,
        windows: false,
      });
    });

    it('combines a mapped snapshot owner with normal source selection', () => {
      const plan = buildCiTestPlan([REVIEW_LIFECYCLE_SOURCE, REVIEW_LOOP_SNAPSHOT], {
        trackedFiles: REVIEW_LOOP_TRACKED,
      });

      expect(plan.full).toBe(false);
      expect(plan.server.mode).toBe('related');
      expect(plan.server.sources).toContain(REVIEW_LIFECYCLE_SOURCE);
      expect(plan.server.files).toEqual(expect.arrayContaining([
        REVIEW_LIFECYCLE_TEST,
        REVIEW_LOOP_OWNER,
        'server/services/taskPromptDefaults.test.js',
      ]));
      expect(plan.smoke).toBe(true);
    });

    it('fails closed for an unmapped fixture or a missing owner', () => {
      const unmapped = buildCiTestPlan([
        'server/services/promptSections/__snapshots__/otherMatrix/unknown.txt',
      ], { trackedFiles: REVIEW_LOOP_TRACKED });
      expect(unmapped.full).toBe(true);
      expect(unmapped.reason).toMatch(/unclassified/);

      const missingOwner = buildCiTestPlan([REVIEW_LOOP_SNAPSHOT], { trackedFiles: TRACKED });
      expect(missingOwner.full).toBe(true);
      expect(missingOwner.reason).toMatch(/fixture owner not tracked/);
    });

    it('scopes a requirements-pin change to the installer contract', () => {
      const requirements = [
        'scripts/requirements-ltx25-cuda.txt',
        'scripts/requirements-minimax-h3-cuda.txt',
        'scripts/requirements-minimax-h3-mlx.lock.txt',
        'scripts/requirements-wan22-cuda.txt',
      ];
      const owners = [
        'scripts/setup-image-video.test.js',
        'server/lib/pythonSetup.install.test.js',
        'server/lib/pythonSetup.test.js',
      ];
      const plan = buildCiTestPlan(requirements, { trackedFiles: [...TRACKED, ...requirements, ...owners] });

      expect(plan.full).toBe(false);
      expect(plan.reason).toBe('text fixture owners');
      expect(plan.server).toMatchObject({ mode: 'files', sources: [] });
      expect(plan.server.files).toEqual([
        ...owners,
        'server/services/taskPromptDefaults.test.js',
      ].sort());
      expect(plan.client).toMatchObject({ mode: 'skip' });
      expect(plan).toMatchObject({ db: false, build: false, smoke: false, windows: false });
    });

    it('still widens CI for an unmapped text artifact', () => {
      const owners = [
        'scripts/setup-image-video.test.js',
        'server/lib/pythonSetup.test.js',
      ];
      const unmapped = buildCiTestPlan(['scripts/notes.txt'], {
        trackedFiles: [...TRACKED, ...owners, 'scripts/notes.txt'],
      });
      expect(unmapped.full).toBe(true);
      expect(unmapped.reason).toMatch(/unclassified changed file: scripts\/notes\.txt/);

      // The pin pattern is one filename shape, not every requirements text file.
      const bare = buildCiTestPlan(['scripts/requirements.txt'], { trackedFiles: TRACKED });
      expect(bare.full).toBe(true);
      expect(bare.reason).toMatch(/unclassified/);
    });

    it('keeps an independent lockfile full-CI trigger authoritative', () => {
      const plan = buildCiTestPlan([REVIEW_LOOP_SNAPSHOT, 'server/package-lock.json'], {
        trackedFiles: [...REVIEW_LOOP_TRACKED, ...WINDOWS_CONTRACT_TESTS],
      });

      expect(plan).toMatchObject({
        full: true,
        server: { mode: 'full' },
        client: { mode: 'full' },
        db: true,
        build: true,
        smoke: true,
        windows: true,
        windowsMode: 'files',
      });
    });
  });

  it('runs the tree-scanning route and prompt-stage guards whenever a server source changes', () => {
    const treeGuards = [
      'server/lib/apiRouteGraph.test.js',
      'server/lib/apiRouteParity.test.js',
      'scripts/generate-prompt-stage-call-sites.test.js',
    ];
    const tracked = [...TRACKED, 'server/routes/settings.js', ...treeGuards];

    // An unmounted route file or a renamed mount on a scoped plan.
    const route = buildCiTestPlan(['server/routes/settings.js'], { trackedFiles: tracked });
    expect(route.full).toBe(false);
    expect(route.server.files).toEqual(expect.arrayContaining(treeGuards));
    // Any server module can add a literal stage-key call site.
    const service = buildCiTestPlan(['server/services/auth.js'], { trackedFiles: tracked });
    expect(service.server.files).toEqual(expect.arrayContaining(treeGuards));
    // A client-only change has nothing to scan.
    const client = buildCiTestPlan(['client/src/lib/catalogLinks.js'], { trackedFiles: tracked });
    expect(client.server.files).not.toEqual(expect.arrayContaining(treeGuards));
  });

  it('fails closed to the full suite for a python script nothing pins', () => {
    // Per script: a pinned sibling in the same diff does not vouch for the orphan.
    const plan = buildCiTestPlan(['scripts/generate_ltx2.py', 'scripts/orphan.py'], {
      trackedFiles: [...TRACKED, 'scripts/generate_ltx2.py', 'scripts/orphan.py', 'scripts/generate_ltx2.test.js'],
      pathContractTests: { 'scripts/generate_ltx2.py': ['scripts/generate_ltx2.test.js'] },
    });
    expect(plan.full).toBe(true);
    expect(plan.reason).toMatch(/python script with no parsing contract: scripts\/orphan\.py/);
    // A python file outside scripts/ is still an unclassified artifact.
    const nested = buildCiTestPlan(['server/tools/helper.py'], { trackedFiles: TRACKED });
    expect(nested.reason).toMatch(/unclassified/);
  });

  it('matches the way tests name one python script, not every one', () => {
    const re = new RegExp(sourceReferencePattern('scripts/generate_ltx2.py'));
    expect(re.test("join(SCRIPTS, 'generate_ltx2.py')")).toBe(true);
    expect(re.test('readFileSync("scripts/generate_ltx2.py", "utf8")')).toBe(true);
    expect(re.test('"generate_ltx2.py"')).toBe(true);
    expect(re.test("'generate_ltx2_cuda.py'")).toBe(false);
    expect(re.test("'my_generate_ltx2.py'")).toBe(false);
    expect(re.test("'generate_ltx2.pyc'")).toBe(false);
    expect(re.test("'generate_ltx2xpy'")).toBe(false);
  });

  it('keeps Windows native contracts on one runner while primary full plans stay sharded', () => {
    expect(FULL_SUITE_SHARDS.windows).toBe(1);
    expect(shardIndexes('full', 3)).toEqual([1, 2, 3]);
    expect(shardIndexes('related', 3)).toEqual([1]);
    expect(shardIndexes('files', 3)).toEqual([1]);
    expect(shardIndexes('skip', 3)).toEqual([1]);
    for (const [runner, count] of Object.entries(FULL_SUITE_SHARDS)) {
      if (runner !== 'windows') expect(count, runner).toBeGreaterThan(1);
    }

    const full = buildCiTestPlan(['server/vitest.config.js'], { trackedFiles: TRACKED });
    expect(full.shards).toEqual({
      server: shardIndexes('full', FULL_SUITE_SHARDS.server),
      client: shardIndexes('full', FULL_SUITE_SHARDS.client),
      windows: shardIndexes('full', FULL_SUITE_SHARDS.windows),
    });
    const scoped = buildCiTestPlan(['server/services/auth.js'], { trackedFiles: TRACKED });
    expect(scoped.shards).toEqual({ server: [1], client: [1], windows: [1] });
    const relatedWindows = buildCiTestPlan(['server/lib/bufferedSpawn.js'], { trackedFiles: TRACKED });
    expect(relatedWindows).toMatchObject({ full: false, windowsMode: 'files',
      windowsSources: [],
      shards: { server: [1, 2], client: [1], windows: [1] } });
    expect(relatedWindows.windowsFiles).toEqual(WINDOWS_CONTRACT_TESTS.filter(path => TRACKED.includes(path)).sort());
    const exactWindows = buildCiTestPlan(['server/lib/bufferedSpawn.test.js'], { trackedFiles: TRACKED });
    expect(exactWindows).toMatchObject({ windowsMode: 'files', shards: { windows: [1] } });
    const docsOnly = buildCiTestPlan(['docs/README.md'], { trackedFiles: TRACKED });
    expect(docsOnly.shards).toEqual({ server: [1], client: [1], windows: [1] });
  });

  it('never selects a model-capability fixture sandbox as a suite on a feature-name match', () => {
    const source = 'client/src/components/models/Panel.jsx';
    const fixture = 'server/fixtures/model-tests/sandbox/cart-totals/cart-totals.test.mjs';
    const real = 'client/src/components/models/Panel.test.jsx';
    const plan = buildCiTestPlan([source], { trackedFiles: [...TRACKED, source, real, fixture] });
    expect(plan.client.files).toContain(real);
    expect(plan.server.files).not.toContain(fixture);
  });

  describe('scoped fan-out instead of a full plan (#11871)', () => {
    const SERVER_FANOUT = shardIndexes('full', FULL_SUITE_SHARDS.server);
    const CLIENT_FANOUT = shardIndexes('full', FULL_SUITE_SHARDS.client);
    const featureTests = (prefix, count, ext = 'js') => Array.from({ length: count },
      (_, i) => `${prefix}/case${String(i).padStart(3, '0')}.test.${ext}`);

    it('keeps an over-cap server selection scoped, runs every selected test, and fans only the server out', () => {
      const source = 'server/services/bigfeature/core.js';
      const tests = featureTests('server/services/bigfeature', MAX_TARGETED_TEST_FILES + 5);
      const plan = buildCiTestPlan([source], { trackedFiles: [...TRACKED, ...WINDOWS_CONTRACT_TESTS, source, ...tests] });

      expect(plan).toMatchObject({ full: false, reason: 'targeted features: bigfeature',
        server: { mode: 'related', sources: [source] }, client: { mode: 'skip' },
        lint: { mode: 'files', files: [source] }, build: false, smoke: true, windows: false });
      // Sharding partitions the selection; it never drops a selector.
      expect(plan.server.files).toEqual(expect.arrayContaining(tests));
      expect(plan.shards).toEqual({ server: SERVER_FANOUT, client: [1], windows: [1] });
      expect(plan.suiteReasons.server).toMatch(/exceed the 125-file cap, sharded 2 ways/);
      // A broad shared dependency can still reach the slashdo contracts.
      expect(plan.slashdo).toBe(true);
    });

    it('fans the client out only when its own selection is over the cap', () => {
      const source = 'client/src/components/bigfeature/Panel.jsx';
      const tests = featureTests('client/src/components/bigfeature', MAX_TARGETED_TEST_FILES + 5, 'jsx');
      const plan = buildCiTestPlan([source], { trackedFiles: [...TRACKED, source, ...tests] });

      expect(plan).toMatchObject({ full: false, client: { mode: 'related', sources: [source] }, build: true });
      expect(plan.client.files).toEqual(expect.arrayContaining(tests));
      expect(plan.shards.client).toEqual(CLIENT_FANOUT);
      expect(plan.shards.server).toEqual([1]);

      const underCap = buildCiTestPlan([source], { trackedFiles: [...TRACKED, source, ...tests.slice(0, 20)] });
      expect(underCap.shards.client).toEqual([1]);
    });

    it('shards a server related graph, but not an exact-file plan under the cap', () => {
      const source = 'server/services/flat.js';
      const tests = featureTests('server/services/flatfeature', 3);
      const trackedFiles = [...TRACKED, source, ...tests];
      const related = buildCiTestPlan([source, ...tests.slice(0, 2)], { trackedFiles });
      expect(related.server.mode).toBe('related');
      expect(related.shards.server).toEqual(SERVER_FANOUT);
      expect(related.suiteReasons.server).toMatch(/related import graph sharded 2 ways/);

      const exact = buildCiTestPlan(tests, { trackedFiles });
      expect(exact.server.mode).toBe('files');
      expect(exact.shards.server).toEqual([1]);

      // A barrel-only edit keeps exact-file selection; over the cap it fans out.
      const barrel = 'server/lib/index.js';
      const named = featureTests('server/consumers', MAX_TARGETED_TEST_FILES + 1);
      const barrelPlan = buildCiTestPlan([barrel], { trackedFiles: [...TRACKED, ...named],
        pathContractTests: { [barrel]: named } });
      expect(barrelPlan.server.mode).toBe('files');
      expect(barrelPlan.server.files).toEqual(expect.arrayContaining(named));
      expect(barrelPlan.shards.server).toEqual(SERVER_FANOUT);
    });

    it("stays on one runner when Vitest's shard guard could see fewer files than shards", () => {
      // Vitest throws when the shard count exceeds the files it resolves. The
      // Linux job never runs DB or browser suites, so they cannot meet the floor.
      const source = 'server/services/flat.js';
      const unit = 'server/services/flat.test.js';
      const floor = (extra) => buildCiTestPlan([source, unit, ...extra],
        { trackedFiles: [source, unit, ...extra] }).shards.server;

      expect(floor([])).toEqual([1]);
      expect(floor(['server/services/appQuality.db.test.js'])).toEqual([1]);
      expect(floor(['server/lib/filmLook.browser.test.js'])).toEqual([1]);
      expect(floor(['server/services/flat.contract.test.js'])).toEqual(SERVER_FANOUT);
    });
  });

  it('falls back to full CI for unknown artifacts and wide changes', () => {
    const unknown = buildCiTestPlan(['data.reference/bootstrap.bin'], {
      trackedFiles: TRACKED,
    });
    expect(unknown.full).toBe(true);
    expect(unknown.reason).toMatch(/unclassified/);

    const unmappedExecutable = buildCiTestPlan(['ecosystem.config.cjs'], {
      trackedFiles: TRACKED,
    });
    expect(unmappedExecutable.full).toBe(true);
    expect(unmappedExecutable.reason).toMatch(/unmapped executable/);

    const wide = buildCiTestPlan(
      Array.from({ length: 31 }, (_, i) => `server/services/feature${i}.js`),
      { trackedFiles: TRACKED },
    );
    expect(wide.full).toBe(true);
    expect(wide.reason).toMatch(/wide change/);
  });

  it('forces the complete suite for a pull request into release', () => {
    // release.yml skips its own suite on the strength of this run, so it must
    // never be scoped — whatever the diff happens to touch.
    expect(forceFullReasonFor({ forceFull: false, baseRef: 'release' }))
      .toBe('release gate: pull request into release');

    const plan = buildCiTestPlan([], {
      trackedFiles: TRACKED,
      forceFull: true,
      forceFullReason: forceFullReasonFor({ forceFull: false, baseRef: 'release' }),
    });
    expect(plan).toMatchObject({ full: true, server: { mode: 'full' }, windows: true });
    expect(plan.reason).toMatch(/release gate/);
  });

  it('lets an ordinary pull request into main stay scoped', () => {
    expect(forceFullReasonFor({ forceFull: false, baseRef: 'main' })).toBeNull();
    expect(forceFullReasonFor({ forceFull: false, baseRef: undefined })).toBeNull();
    expect(forceFullReasonFor({ forceFull: true, baseRef: 'main' })).toBe('full CI requested');
  });

  it('routes CI pipeline scripts to the complete suite', () => {
    for (const path of [
      'scripts/ci-base-sha.js',
      'scripts/ci-base-sha.test.js',
      'scripts/lib/githubOutput.js',
      'scripts/ci-test-plan.js',
      'scripts/run-ci-tests.js',
      'scripts/run-ci-lint.js',
      'scripts/verify-ci-status.js',
      'scripts/verify-ci-status.test.js',
    ]) {
      const plan = buildCiTestPlan([path], { trackedFiles: TRACKED });
      expect(plan.full, path).toBe(true);
      expect(plan.reason, path).toMatch(/CI pipeline script changed/);
    }
  });

  it('selects native Windows for its registry, workflow and executed pipeline inputs', () => {
    const windowsModeOf = (path) => buildCiTestPlan([path], { trackedFiles: TRACKED }).windowsMode;
    // Defined by / executed on windows-latest.
    for (const path of [
      '.github/workflows/ci.yml',
      'scripts/ci-base-sha.js',
      'scripts/lib/githubOutput.js',
      'scripts/run-ci-tests.js',
      'scripts/run-ci-tests.test.js',
      'scripts/ci-test-plan.js',
      'scripts/ci-test-plan.test.js',
    ]) expect(windowsModeOf(path), path).toBe('files');
    // Still a full Linux plan, but nothing on windows-latest loads them: the
    // unrelated scripts leave Windows skipped.
    for (const path of [
      '.github/workflows/release.yml',
      '.github/workflows/eidoverse-acceptance.yml',
      'scripts/run-ci-lint.js',
      'scripts/scan-diff-hidden-content.js',
      'scripts/verify-ci-status.js',
    ]) {
      const plan = buildCiTestPlan([path], { trackedFiles: TRACKED });
      expect(plan.full, path).toBe(true);
      expect(plan.windowsMode, path).toBe('skip');
    }
    // Any matching trigger still wins: ci.yml next to a Linux-only script escalates.
    expect(windowsModeOf('.github/workflows/ci.yml')).toBe('files');
    expect(buildCiTestPlan(['scripts/ci-test-plan.js', '.github/workflows/ci.yml'], { trackedFiles: TRACKED }).windowsMode).toBe('files');
  });

  it('routes worktree-manager source to a full plan instead of a broad nominal scoped plan (#9999)', () => {
    const plan = buildCiTestPlan(['server/services/worktreeManager.js'], { trackedFiles: TRACKED });
    expect(plan.full).toBe(true);
    expect(plan.reason).toMatch(/worktree manager source changed/);
    expect(plan.server.mode).toBe('full');
    expect(plan.client.mode).toBe('full');
    expect(plan.windowsMode).toBe('files');
    // Its test file alone stays a scoped plan.
    expect(buildCiTestPlan(['server/services/worktreeManager.test.js'], { trackedFiles: TRACKED }).full).toBe(false);
  });

  it('routes log socket source to full sharded CI while nearby socket sources stay scoped (#10030)', () => {
    const trackedFiles = [
      ...TRACKED,
      'server/sockets/logs.js',
      'server/sockets/logs.test.js',
      'server/sockets/apps.js',
      'server/sockets/apps.test.js',
    ];
    const logs = buildCiTestPlan(['server/sockets/logs.js'], { trackedFiles });
    expect(logs.full).toBe(true);
    expect(logs.reason).toMatch(/log socket source changed \(broad import fanout\)/);
    expect(logs.server.mode).toBe('full');
    expect(logs.client.mode).toBe('full');
    expect(logs.windowsMode).toBe('files');
    expect(logs.shards).toEqual({
      server: shardIndexes('full', FULL_SUITE_SHARDS.server),
      client: shardIndexes('full', FULL_SUITE_SHARDS.client),
      windows: shardIndexes('full', FULL_SUITE_SHARDS.windows),
    });

    const nearbySocket = buildCiTestPlan(['server/sockets/apps.js'], { trackedFiles });
    expect(nearbySocket.full).toBe(false);
    expect(nearbySocket.server.mode).toBe('related');
    expect(nearbySocket.shards).toEqual({ server: [1], client: [1], windows: [1] });
  });

  it('honors an explicit full-CI request', () => {
    const plan = buildCiTestPlan(['docs/README.md'], {
      trackedFiles: TRACKED,
      forceFull: true,
    });

    expect(plan).toMatchObject({
      full: true,
      reason: 'full CI requested',
      server: { mode: 'full' },
      client: { mode: 'full' },
      db: true,
      lint: { mode: 'full' },
      build: true,
      smoke: true,
      windows: true,
    });
  });

  it('skips Windows unless a Windows-sensitive surface changed', () => {
    const sprites = buildCiTestPlan([
      'server/services/sprites/atlas.js',
    ], { trackedFiles: TRACKED });
    expect(sprites.windows).toBe(false);

    const spawn = buildCiTestPlan([
      'server/lib/bufferedSpawn.js',
    ], { trackedFiles: TRACKED });
    expect(spawn.full).toBe(false);
    expect(spawn.windows).toBe(true);
    expect(spawn.windowsMode).toBe('files');
    expect(spawn.windowsSources).toEqual([]);
    expect(spawn.windowsFiles).toEqual(WINDOWS_CONTRACT_TESTS.filter(path => TRACKED.includes(path)).sort());

    const tuiShell = buildCiTestPlan([
      'server/lib/shellCd.js',
    ], { trackedFiles: TRACKED });
    expect(tuiShell.windows).toBe(true);
    expect(tuiShell.windowsMode).toBe('files');

    const winHelper = buildCiTestPlan([
      'scripts/fix-windows-console.js',
    ], { trackedFiles: TRACKED });
    expect(winHelper.full).toBe(false);
    expect(winHelper.windows).toBe(true);
  });

  it('runs the native supervised release-recovery service contract on Windows', () => {
    const source = 'server/services/releaseCandidateRecovery.js';
    const contract = 'server/services/releaseCandidateRecovery.test.js';
    const plan = buildCiTestPlan([source], { trackedFiles: [...TRACKED, source, contract] });
    expect(plan.windows).toBe(true);
    expect(plan.windowsMode).toBe('files');
    expect(plan.windowsFiles).toContain(contract);
  });

  it.each([
    'server/lib/bufferedSpawn.js',
    'server/lib/windowsGitProcess.protocol.test.js',
  ])('does not broaden native coverage for an unrelated server edit beside %s', native => {
    const neutral = 'server/lib/zodCompat.js';
    const options = {
      trackedFiles: [...TRACKED, ...WINDOWS_CONTRACT_TESTS, native, neutral],
      clientDependencies: [],
    };
    const nativeOnly = buildCiTestPlan([native], options);
    const mixed = buildCiTestPlan([native, neutral], options);
    expect(mixed.full).toBe(false);
    expect({ mode: mixed.windowsMode, files: mixed.windowsFiles, sources: mixed.windowsSources, shards: mixed.shards.windows })
      .toEqual({ mode: nativeOnly.windowsMode, files: nativeOnly.windowsFiles, sources: nativeOnly.windowsSources, shards: nativeOnly.shards.windows });
    expect(mixed.server.sources).toContain(neutral);
  });

  it.each(['js', 'test.js'])('keeps owned-browser application coverage on the primary runner for %s changes', extension => {
    const source = 'server/services/htmlComposition/ownedBrowser.js';
    const test = 'server/services/htmlComposition/ownedBrowser.test.js';
    const plan = buildCiTestPlan([`server/services/htmlComposition/ownedBrowser.${extension}`], {
      trackedFiles: [...TRACKED, source, test],
    });
    expect(plan.windows).toBe(false);
    expect(plan.windowsFiles).toEqual([]);
    expect(plan.server[extension === 'js' ? 'sources' : 'files']).toContain(extension === 'js' ? source : test);
  });

  it('keeps the native Windows set for an explicit full-CI request', () => {
    const plan = buildCiTestPlan(['server/lib/bufferedSpawn.js'], {
      trackedFiles: TRACKED,
      forceFull: true,
    });

    expect(plan.windowsMode).toBe('files');
    expect(plan.windowsFiles).toEqual(WINDOWS_CONTRACT_TESTS.filter(path => TRACKED.includes(path)).sort());
  });

  it('only names tracked Windows contract tests', () => {
    const plan = buildCiTestPlan(['server/lib/bufferedSpawn.js'], {
      trackedFiles: TRACKED,
    });

    expect(plan.windowsFiles.every((path) => WINDOWS_CONTRACT_TESTS.includes(path))).toBe(true);
  });

  it('uses exact Windows contracts when only a Windows-sensitive test changed', () => {
    const plan = buildCiTestPlan(['server/lib/bufferedSpawn.test.js'], {
      trackedFiles: TRACKED,
    });

    expect(plan.windows).toBe(true);
    expect(plan.windowsMode).toBe('files');
    expect(plan.windowsSources).toEqual([]);
  });

  it('keeps changed retirement application fixtures on the primary runner', () => {
    const contracts = [
      'server/services/heldCheckoutExactDelivery.integration.test.js',
      'server/services/heldCheckoutRecovery.test.js',
      'server/services/heldCheckoutRecovery.receipts.test.js',
      'server/services/heldCheckoutRecovery.siblings.test.js',
    ];
    const plan = buildCiTestPlan(contracts, { trackedFiles: [...TRACKED, ...contracts] });

    expect(plan.windowsMode).toBe('skip');
    expect(plan.windowsFiles).toEqual([]);
    expect(plan.server.files).toEqual(expect.arrayContaining(contracts));
  });

  describe('slashdo submodule initialization (#6263)', () => {
    it('requests the submodule for a gitlink-only change, forced full by the unclassified path', () => {
      const plan = buildCiTestPlan([SLASHDO_GITLINK_PATH], { trackedFiles: TRACKED });

      expect(plan.full).toBe(true);
      expect(plan.slashdo).toBe(true);
    });

    it('requests the submodule when the loader source changes, without forcing full CI', () => {
      const plan = buildCiTestPlan(['server/lib/slashdoLoader.js'], { trackedFiles: TRACKED });

      expect(plan.full).toBe(false);
      expect(plan.server.mode).toBe('related');
      expect(plan.server.sources).toContain('server/lib/slashdoLoader.js');
      expect(plan.slashdo).toBe(true);
    });

    it('requests the submodule when only the adapter test file changes', () => {
      const plan = buildCiTestPlan(['server/lib/slashdoInvocation.test.js'], { trackedFiles: TRACKED });

      expect(plan.full).toBe(false);
      expect(plan.server.files).toContain('server/lib/slashdoInvocation.test.js');
      expect(plan.slashdo).toBe(true);
    });

    it('requests the submodule on an explicit full-CI request (nightly / release gate)', () => {
      const plan = buildCiTestPlan(['docs/README.md'], { trackedFiles: TRACKED, forceFull: true });

      expect(plan.slashdo).toBe(true);
    });

    it('does not request the submodule for an unrelated scoped change', () => {
      const plan = buildCiTestPlan(['server/services/sprites/atlas.js'], { trackedFiles: TRACKED });

      expect(plan.full).toBe(false);
      expect(plan.slashdo).toBe(false);
    });

    it('never requests the submodule for a documentation-only change', () => {
      const plan = buildCiTestPlan(['docs/GITHUB_ACTIONS.md'], { trackedFiles: TRACKED });

      expect(plan.slashdo).toBe(false);
    });
  });
});

describe('needsSlashdoSubmodule', () => {
  const basePlan = { full: false, changedFiles: [], server: { files: [], sources: [] } };

  it('is false for a plan that touches neither the gitlink nor the adapter', () => {
    expect(needsSlashdoSubmodule(basePlan)).toBe(false);
  });

  it('is true for a full plan even without an explicit slashdo change', () => {
    expect(needsSlashdoSubmodule({ ...basePlan, full: true })).toBe(true);
  });

  it('is true when the gitlink path itself changed', () => {
    expect(needsSlashdoSubmodule({ ...basePlan, changedFiles: [SLASHDO_GITLINK_PATH] })).toBe(true);
  });

  it('is true when a contract test file is selected', () => {
    expect(needsSlashdoSubmodule({
      ...basePlan,
      server: { files: ['server/lib/slashdoLoader.test.js'], sources: [] },
    })).toBe(true);
  });

  it('initializes slashdo when the audit catalog scope-coverage contract is selected', () => {
    expect(needsSlashdoSubmodule({
      ...basePlan,
      server: { files: ['server/lib/auditCatalog.test.js'], sources: [] },
    })).toBe(true);
  });

  it('is true when a contract source file is selected', () => {
    expect(needsSlashdoSubmodule({
      ...basePlan,
      server: { files: [], sources: ['server/lib/slashdoInvocation.js'] },
    })).toBe(true);
  });
});

// The supported Windows boundary is executable behavior, not all application
// consumers of the process graph. Primary-platform selection remains intact.
describe('Windows native support boundary', () => {
  const options = { trackedFiles: [...TRACKED, ...WINDOWS_CONTRACT_TESTS] };
  const expected = [...WINDOWS_CONTRACT_TESTS].sort();

  it.each([
    'scripts/deploy.ps1',
    'server/lib/bufferedSpawn.js',
    'server/lib/windowsGitSupervisor.cs',
    'server/lib/windowsAgentSupervisor.cs',
    'server/lib/windowsAgentProcess.js',
    'server/lib/aiToolkit/internal/windowsSafeSpawn.js',
    'server/lib/gitRepositoryIdentity.js',
    'server/lib/checkoutRetirementAdmission.js',
    'server/lib/pathSafety.js',
    'server/services/shell.windows.test.js',
    'server/services/agentTuiSpawning/sessionController.js',
    'server/services/tuiPromptRunner.js',
  ])('selects the native contracts without following application consumers for %s', path => {
    const plan = buildCiTestPlan([path], options);
    expect(plan.windows).toBe(true);
    expect(plan.windowsMode).toBe('files');
    expect(plan.windowsFiles).toEqual(expected);
    expect(plan.windowsSources).toEqual([]);
    expect(plan.shards.windows).toEqual([1]);
  });

  it.each(['.github/workflows/ci.yml', 'server/vitest.config.js', 'scripts/run-ci-tests.js'])(
    'keeps full primary coverage and only the native Windows contract set for %s', path => {
      const plan = buildCiTestPlan([path], options);
      expect(plan.full).toBe(true);
      expect(plan.server.mode).toBe('full');
      expect(plan.client.mode).toBe('full');
      expect(plan.windowsFiles).toEqual(expected);
      expect(plan.windowsMode).toBe('files');
      expect(plan.shards.windows).toEqual([1]);
    });

  it('uses the same supported Windows boundary for scheduled/release/full validation', () => {
    const plan = buildCiTestPlan(['docs/README.md'], { ...options, forceFull: true });
    expect(plan).toMatchObject({ full: true, server: { mode: 'full' }, client: { mode: 'full' },
      db: true, build: true, smoke: true, windowsMode: 'files', windowsSources: [] });
    expect(plan.windowsFiles).toEqual(expected);
    expect(plan.shards.windows).toEqual([1]);
  });

  it.each([
    'server/lib/primaryCheckoutGuard.test.js',
    'server/services/worktreeReap.test.js',
    'server/services/heldCheckoutRecovery.test.js',
    'server/services/heldCheckoutRecovery.receipts.test.js',
    'server/services/heldCheckoutRecovery.siblings.test.js',
    'server/services/videoGen/metalBufferProfiles.test.js',
    'server/routes/apps/crud.test.js',
  ])('retains %s on the primary runner without adding a Windows application suite', path => {
    const plan = buildCiTestPlan([path], { trackedFiles: [...TRACKED, path] });
    expect(plan.server.files).toContain(path);
    expect(plan.windows).toBe(false);
    expect(plan.windowsFiles).toEqual([]);
  });

  it('keeps real native launch, prompt, ownership and filesystem proof in the registry', () => {
    expect(WINDOWS_CONTRACT_TESTS).toEqual(expect.arrayContaining([
      'server/lib/cliProviderRun.test.js', 'server/lib/detachedSpawn.test.js',
      'server/services/shell.windows.test.js', 'server/services/tuiPromptRunner.test.js',
      'server/lib/execGit.test.js', 'server/lib/windowsGitProcess.test.js', 'server/lib/windowsGitProcess.protocol.test.js',
      'server/lib/windowsAgentProcess.test.js',
      'server/lib/gitRepositoryIdentity.test.js', 'server/lib/checkoutRetirementAdmission.test.js',
      'server/lib/nativeTrash.smoke.test.js',
    ]));
    const repo = fileURLToPath(new URL('../', import.meta.url));
    expect(WINDOWS_CONTRACT_TESTS.every(path => existsSync(join(repo, path)))).toBe(true);
  });

  it('runs the junction settlement contract on Windows when its test changes', () => {
    const test = 'server/lib/execGit.test.js';
    const plan = buildCiTestPlan([test], { trackedFiles: [...options.trackedFiles, test] });
    expect(plan.windows).toBe(true);
    expect(plan.windowsFiles).toContain(test);
  });

  it('fails the emitted CI plan instead of publishing a green empty Windows job', () => {
    const plan = buildCiTestPlan(['.github/workflows/ci.yml'], { trackedFiles: [] });
    expect(() => emitGitHubPlan(plan)).toThrow('Windows native contract inventory is empty');
  });

  it('fails a scoped CI plan when one registered Windows contract is missing', () => {
    const missing = 'server/lib/windowsAgentProcess.test.js';
    const trackedFiles = [...TRACKED, ...WINDOWS_CONTRACT_TESTS.filter(path => path !== missing)];
    const plan = buildCiTestPlan([missing], { trackedFiles });
    expect(plan).toMatchObject({ full: false, windows: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(() => emitGitHubPlan(plan)).toThrow(`Windows native contract inventory is missing: ${missing}`);
    } finally {
      log.mockRestore();
    }
  });
});

it('projects transitive browser consumers through the planner CLI without replacing related selection (#10838)', () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-ci-related-browser-'));
  const planner = fileURLToPath(new URL('./ci-test-plan.js', import.meta.url));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, source) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  const leaf = 'server/services/example/leaf.js';
  const unrelated = 'server/services/unrelated.js';
  const [staticSuite, deferredSuite, independentSuite] = BROWSER_SUITES;
  const plan = (changedFiles, forceFull = false) => JSON.parse(execFileSync(process.execPath, [planner], {
    cwd: root,
    encoding: 'utf8', stdio: PLANNER_STDIO,
    env: { ...process.env, CI_BASE_SHA: 'HEAD', CI_BASE_REF: 'main', CI_FORCE_FULL: String(forceFull),
      CI_CHANGED_FILES: JSON.stringify(changedFiles), GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
  }));
  const browsers = (result) => JSON.parse(result.browser_files);
  try {
    git('init', '-q');
    WINDOWS_CONTRACT_TESTS.forEach(path => write(path, '// native inventory fixture\n'));
    write(leaf, 'export const value = 1;\n');
    write(unrelated, 'export const value = 2;\n');
    write('server/services/bridge.js', "export { value } from './example/leaf';\n");
    write(staticSuite, "import '../services/bridge.js';\n");
    write(deferredSuite, "export const load = () => import('../services/bridge.js');\n");
    write(independentSuite, [
      '// import (#2120)',
      'const fixture = `export * from "./ProbeBarrel"; import(unknown)`;',
      'export const value = 3;',
    ].join('\n'));
    git('add', '--all');

    // Neither browser suite shares leaf's feature or names its basename. Only
    // transitive import discovery can report the real related-test consumers.
    const related = plan([leaf]);
    expect(related).toMatchObject({ full: false, server_mode: 'related', server_sources: JSON.stringify([leaf]) });
    expect(JSON.parse(related.server_files)).not.toContain(staticSuite);
    expect(JSON.parse(related.server_files)).not.toContain(deferredSuite);
    expect(browsers(related)).toEqual([staticSuite, deferredSuite]);
    expect(JSON.parse(related.suite_reasons).browser).toBe('2 cross-workspace browser suite(s) selected');
    expect(browsers(plan([leaf, staticSuite]))).toEqual([staticSuite, deferredSuite]);
    expect(browsers(plan([unrelated]))).toEqual([]);
    expect(browsers(plan(['docs/README.md']))).toEqual([]);
    expect(browsers(plan([staticSuite]))).toEqual([staticSuite]);
    expect(browsers(plan([], true))).toEqual([staticSuite, deferredSuite, independentSuite]);

    // Inconclusive discovery widens only the affected registered suite while
    // the ordinary server run keeps its existing related sources/selectors.
    for (const expression of ["'../services/missing.js'", 'modulePath']) {
      write(independentSuite, `export const load = () => import(${expression});\n`);
      const conservative = plan([unrelated]);
      expect(conservative).toMatchObject({ full: false, server_mode: 'related', server_sources: JSON.stringify([unrelated]) });
      expect(browsers(conservative)).toEqual([independentSuite]);
      expect(browsers(plan([leaf]))).toEqual([staticSuite, deferredSuite, independentSuite]);
      // No behavioral source traversal on test-only edits or documentation.
      expect(browsers(plan([staticSuite]))).toEqual([staticSuite]);
      expect(browsers(plan(['docs/README.md']))).toEqual([]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('cross-workspace browser suites (#10312)', () => {

  it('selects greybox pixel parity when the bundled viewer or capture contract changes', () => {
    const suite = 'server/services/greyboxRender.browser.test.js';
    const inputs = realTree();
    const trackedFiles = inputs.trackedFiles.filter((path) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || BROWSER_SUITES.includes(path));
    for (const source of ['client/src/components/catalog/GreyboxViewer.jsx', 'client/src/components/catalog/GreyboxCapture.jsx', 'server/lib/greyboxCapture.js']) {
      expect(buildCiTestPlan([source], { ...inputs, trackedFiles }).browserFiles, source).toContain(suite);
    }
  });

  it('selects animatic pixel coverage when only the compositor or Save frame control changes', () => {
    const suite = 'server/services/musicVideo/animaticCapture.browser.test.js';
    const inputs = realTree();
    const trackedFiles = inputs.trackedFiles.filter((path) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || BROWSER_SUITES.includes(path));
    for (const source of ['client/src/lib/musicVideoFrameCapture.js', 'client/src/components/musicVideo/FrameStepper.jsx', 'client/src/components/musicVideo/PreviewVideo.jsx']) {
      const plan = buildCiTestPlan([source], { ...inputs, trackedFiles });
      expect(plan.full, source).toBe(false);
      expect(plan.browserFiles, source).toContain(suite);
    }
  });

  it('selects every music-video browser suite when a client component they mount changes', () => {
    const source = 'client/src/components/musicVideo/ProductionReviewPanel.jsx';
    const inputs = realTree();
    // Keep the real source/import walk, with a bounded test corpus. Unrelated
    // feature-test growth must not route this scoped-browser contract through
    // the safety-cap fallback (the full-plan contract is checked separately).
    const trackedFiles = inputs.trackedFiles.filter((path) =>
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || BROWSER_SUITES.includes(path));
    const plan = buildCiTestPlan([source], { ...inputs, trackedFiles });

    // Server-only media suites do not mount the changed client component.
    const runtimeOnly = ['server/lib/filmLook.browser.test.js', 'server/lib/filmLookGpu.browser.test.js', 'server/lib/musicVideoTitleCard.browser.test.js',
      'server/services/federatedMedia/sourceAudio.browser.test.js',
      'server/services/greyboxRender.browser.test.js',
      'server/services/fableLoom/static-player/player.browser.test.js',
      'server/services/codeAnimation/export.realBrowser.test.js',
      'server/services/htmlComposition/index.test.js'];
    expect(plan.full).toBe(false);
    expect(plan.browserFiles).toEqual(expect.arrayContaining(BROWSER_SUITES.filter((suite) => suite.includes('/musicVideo') && !runtimeOnly.includes(suite))));
    expect(plan.browserFiles).not.toContain('server/routes/catalogGreyboxViewer.browser.test.js');
    for (const suite of runtimeOnly) expect(plan.browserFiles).not.toContain(suite);
    expect(plan.suiteReasons.browser).toMatch(/browser suite/);
  });

  it('selects greybox pixel coverage for its lazy viewer, editor and Environment route', () => {
    const inputs = realTree();
    const trackedFiles = inputs.trackedFiles.filter((path) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || BROWSER_SUITES.includes(path));
    for (const source of ['client/src/components/catalog/GreyboxViewer.jsx', 'client/src/components/catalog/GreyboxPanel.jsx', 'client/src/pages/CatalogIngredient.jsx']) {
      const plan = buildCiTestPlan([source], { ...inputs, trackedFiles });
      expect(plan.full, source).toBe(false);
      expect(plan.browserFiles, source).toContain('server/routes/catalogGreyboxViewer.browser.test.js');
    }
  });

  it('runs every registered browser suite on a full plan, and no unregistered browser test', () => {
    const trackedFiles = [
      ...BROWSER_SUITES,
      'client/src/pages/Shell.browser.test.js',
      'server/routes/browser.test.js',
      'server/services/musicVideo/documentRender.browser.test.js',
    ];
    const plan = buildCiTestPlan(['package.json'], { trackedFiles });

    expect(plan.full).toBe(true);
    expect(plan.browserFiles).toEqual(BROWSER_SUITES);
  });

  it('selects nothing when the diff names no browser suite, and ignores a deleted suite', () => {
    const trackedFiles = [...BROWSER_SUITES, 'server/services/auth.js', 'server/services/auth.test.js'];

    expect(buildCiTestPlan(['server/services/auth.js'], { trackedFiles }).browserFiles).toEqual([]);
    expect(buildCiTestPlan(['README.md'], { trackedFiles }).browserFiles).toEqual([]);
    // A deleted path is not in trackedFiles, so it cannot become a vitest selector.
    expect(buildCiTestPlan(['server/routes/gone.browser.test.js'], { trackedFiles }).browserFiles).toEqual([]);
  });

  it('selects a browser suite that is itself the changed file', () => {
    const plan = buildCiTestPlan([BROWSER_SUITES[0]], { trackedFiles: BROWSER_SUITES });

    expect(plan.browserFiles).toEqual([BROWSER_SUITES[0]]);
  });
});

describe('dependency manifest Windows escalation', () => {
  const TRACKED_WITH_CONTRACTS = [...TRACKED, ...WINDOWS_CONTRACT_TESTS];
  const LOCK = 'server/package-lock.json';
  const lockfile = (packages, root = {}) => JSON.stringify({
    name: 'portos-server',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'portos-server', version: '1.0.0', ...root }, ...packages },
  });
  const BASE_PACKAGES = {
    'node_modules/@googleapis/gmail': { version: '16.1.1', resolved: 'https://registry.example.com/g-16.1.1.tgz' },
    'node_modules/node-pty': { version: '1.2.0', hasInstallScript: true },
  };
  const BASE = lockfile(BASE_PACKAGES);
  const planFor = (files, dependencyChanges) => buildCiTestPlan(files, {
    trackedFiles: TRACKED_WITH_CONTRACTS,
    dependencyChanges,
  });
  const lockPlan = (headText, baseText = BASE) => planFor([LOCK], { [LOCK]: classifyDependencyChange(LOCK, baseText, headText) });

  it('keeps a pure-JS version bump on the primary platform and names the package', () => {
    const plan = lockPlan(lockfile({
      ...BASE_PACKAGES,
      'node_modules/@googleapis/gmail': { version: '17.0.0', resolved: 'https://registry.example.com/g-17.0.0.tgz' },
    }));

    // The Linux side stays complete; only Windows narrows.
    expect(plan.full).toBe(true);
    expect(plan.server.mode).toBe('full');
    expect(plan.windowsMode).toBe('skip');
    expect(plan.windowsFiles).toEqual([]);
    expect(plan.shards.windows).toEqual([1]);
    expect(plan.suiteReasons.windows).toContain('does not select Windows native contracts');
    expect(plan.suiteReasons.windows).toContain('@googleapis/gmail');
  });

  it('escalates Windows for a native, install-script, platform-gated or optional package', () => {
    const cases = {
      'install script': { 'node_modules/fresh-addon': { version: '1.0.0', hasInstallScript: true } },
      'os field': { 'node_modules/@scope/binding-win32-x64': { version: '1.0.0', os: ['win32'], cpu: ['x64'] } },
      optional: { 'node_modules/maybe-native': { version: '1.0.0', optional: true } },
      // Removing a trusted rebuild escalates too: either side of the diff counts.
      'trusted rebuild removed': { 'node_modules/node-pty': undefined },
      // sharp's entry carries no platform metadata; the family list catches it.
      'platform family': { 'node_modules/sharp': { version: '0.35.6' } },
    };
    for (const [label, change] of Object.entries(cases)) {
      const packages = Object.fromEntries(Object.entries({ ...BASE_PACKAGES, ...change })
        .filter(([, entry]) => entry !== undefined));
      const plan = lockPlan(lockfile(packages));
      expect(plan.full, label).toBe(true);
      expect(plan.windowsMode, label).toBe('files');
      expect(plan.shards.windows, label).toEqual(shardIndexes('full', FULL_SUITE_SHARDS.windows));
      expect(plan.suiteReasons.windows, label).toContain('selects Windows native contracts: platform-sensitive package changed');
    }
  });

  it('treats every trusted-rebuild package as platform-sensitive', () => {
    // The planner mirrors the allowlist instead of importing it (see
    // PLATFORM_PACKAGE_RES); this keeps the two from drifting.
    const trusted = Object.values(TRUSTED_REBUILDS).flatMap((groups) => groups.flatMap(({ pkgs }) => pkgs));
    expect(trusted.length).toBeGreaterThan(0);
    expect(trusted.filter((name) => !PLATFORM_PACKAGE_RES.some((re) => re.test(name)))).toEqual([]);
  });

  it('fails closed when the lockfile cannot be compared', () => {
    for (const [label, baseText, headText] of [
      ['unparsable head', BASE, '{ "packages": '],
      ['missing base', null, BASE],
      ['deleted head', BASE, null],
      ['no packages map', JSON.stringify({ lockfileVersion: 1 }), BASE],
    ]) {
      expect(classifyDependencyChange(LOCK, baseText, headText).escalate, label).toBe(true);
      expect(lockPlan(headText, baseText).windowsMode, label).toBe('files');
    }
    // No verdict at all — a caller that skipped the comparison — escalates too.
    expect(planFor([LOCK], {}).windowsMode).toBe('files');
  });

  it('escalates Windows for engines, overrides and npm configuration changes', () => {
    const manifest = { name: 'portos-server', dependencies: { express: '^5.2.1' }, engines: { node: '>=24.14' } };
    const verdict = (head) => classifyDependencyChange('server/package.json', JSON.stringify(manifest), JSON.stringify(head));

    expect(verdict({ ...manifest, dependencies: { express: '^5.3.0' } })).toMatchObject({ escalate: false, packages: ['express'] });
    expect(verdict({ ...manifest, engines: { node: '>=26' } }).escalate).toBe(true);
    expect(verdict({ ...manifest, overrides: { braces: '3.0.3' } }).escalate).toBe(true);
    expect(verdict({ ...manifest, dependencies: { ...manifest.dependencies, 'node-pty': '^1.2.0' } }).escalate).toBe(true);
    // The lockfile mirrors engines into its root entry.
    expect(classifyDependencyChange(LOCK, BASE, lockfile(BASE_PACKAGES, { engines: { node: '>=26' } })).escalate).toBe(true);

    for (const npmrc of ['server/.npmrc']) {
      const plan = planFor([npmrc], {});
      expect(plan.full, npmrc).toBe(true);
      expect(plan.reason, npmrc).toContain('npm configuration changed');
      expect(plan.windowsMode, npmrc).toBe('files');
    }
  });

  it('skips Windows for changes in workspaces the native job does not install', () => {
    const unsafe = lockfile({ ...BASE_PACKAGES, 'node_modules/@scope/binding-win32-x64': { version: '1.0.0', os: ['win32'], cpu: ['x64'] } });
    for (const path of ['package-lock.json', 'client/package-lock.json', 'autofixer/package-lock.json']) {
      const plan = planFor([path], { [path]: classifyDependencyChange(path, BASE, unsafe) });
      expect(plan.full, path).toBe(true);
      expect(plan.windowsMode, path).toBe('skip');
      expect(plan.suiteReasons.windows, path).toContain('the Windows job does not install that workspace');
    }
    for (const path of ['.npmrc', 'client/.npmrc']) {
      expect(planFor([path], {}).windowsMode, path).toBe('skip');
    }
    // The same diff in the server lockfile still escalates.
    expect(lockPlan(unsafe).windowsMode).toBe('files');
  });

  it('pins the Windows-installed workspaces to the windows-server install steps in ci.yml', () => {
    const job = workflowJobs(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'ci.yml'), 'utf8'))['windows-server'];
    const installed = [...job.matchAll(/npm (?:ci|install)\b[^\n]*/g)].map(([cmd]) => cmd.match(/--prefix\s+(\S+)/)?.[1] ?? '.');
    expect(installed.sort()).toEqual([...WINDOWS_INSTALLED_WORKSPACES].sort());
  });

  it('runs shared schema contracts on the primary platform', () => {
    for (const path of ['server/lib/validation.js', 'server/lib/schemaVersions.js']) {
      const plan = planFor([path], {});
      expect(plan.full, path).toBe(true);
      expect(plan.server.mode, path).toBe('full');
      // Full CI Gate requires the native Windows job as well as full primary
      // coverage; this primary-only schema plan leaves that job skipped.
      expect(plan.windowsMode, path).toBe('skip');
      expect(plan.windowsFiles, path).toEqual([]);
    }
  });

  it('compares the manifest at the real diff base through git', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-ci-lockfile-'));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.com',
      '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      mkdirSync(join(root, 'server'));
      writeFileSync(join(root, LOCK), BASE);
      git('add', '--all');
      git('commit', '-q', '--no-verify', '-m', 'base');
      const bumped = lockfile({ ...BASE_PACKAGES, 'node_modules/@googleapis/gmail': { version: '17.0.0' } });
      writeFileSync(join(root, LOCK), bumped);

      const inputs = collectPlanInputs({ baseSha: 'HEAD', changedFiles: [LOCK], cwd: root });
      expect(inputs.dependencyChanges[LOCK]).toMatchObject({ escalate: false, packages: ['@googleapis/gmail'] });

      // A base commit that does not exist in the checkout fails closed.
      const missing = collectPlanInputs({ baseSha: '0'.repeat(40), changedFiles: [LOCK], cwd: root });
      expect(missing.dependencyChanges[LOCK]).toMatchObject({ escalate: true, reason: 'base version unavailable' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('path-gated single-purpose jobs', () => {
  const repo = REPO_ROOT;
  // The gates read only the static input lists, which do not depend on the
  // diff; walking the repository once per case exceeded the 5 s test timeout (#12461).
  const realPlan = (changedFiles) => {
    const { promptHistoryInputs, linuxContainmentInputs, supercolliderLiveInputs, dockerContainmentLiveInputs } = realTree();
    return buildCiTestPlan(changedFiles, { promptHistoryInputs, linuxContainmentInputs, supercolliderLiveInputs, dockerContainmentLiveInputs });
  };
  const gates = (plan) => ({
    promptHistory: plan.promptHistory, linuxContainment: plan.linuxContainment, supercolliderLive: plan.supercolliderLive,
  });

  it('runs each job only when the real diff reaches its inputs', () => {
    expect(gates(realPlan(['docs/README.md'])))
      .toEqual({ promptHistory: false, linuxContainment: false, supercolliderLive: false });
    // Reached only through the hash-declaring migrations' import closure.
    expect(gates(realPlan(['server/lib/fileUtils.js']))).toMatchObject({ promptHistory: true, linuxContainment: true });
    expect(gates(realPlan(['server/lib/codeAnimationContainment.js'])))
      .toEqual({ promptHistory: false, linuxContainment: true, supercolliderLive: false });
    expect(gates(realPlan(['data.reference/prompts/stages/example.md'])))
      .toEqual({ promptHistory: true, linuxContainment: false, supercolliderLive: false });
    expect(gates(realPlan(['server/package-lock.json']))).toMatchObject({ linuxContainment: true, supercolliderLive: true });
    expect(gates(realPlan(['.github/workflows/ci.yml'])))
      .toEqual({ promptHistory: true, linuxContainment: true, supercolliderLive: true });
  });

  it('selects the SuperCollider live job for the spawn plumbing its containment cases depend on, not for unrelated files (#12612)', () => {
    // Transitive dependencies of the live suite that the old hand-kept path
    // list never named.
    for (const file of ['server/lib/bufferedSpawn.js', 'server/lib/streamingSpawn.js', 'server/lib/processEnv.js']) {
      expect(realPlan([file]).supercolliderLive, file).toBe(true);
    }
    for (const file of ['docker/supercollider/Dockerfile', 'scripts/setup-supercollider.js']) {
      expect(realPlan([file]).supercolliderLive, file).toBe(true);
    }
    expect(realPlan(['client/src/App.jsx']).supercolliderLive).toBe(false);
    expect(realPlan(['docs/SUPERCOLLIDER.md']).supercolliderLive).toBe(false);
  });

  it('covers a module newly imported by the SuperCollider runtime without editing any list (#12612)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-plan-supercollider-'));
    try {
      const write = (path, text) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write('server/services/superColliderRender.live.test.js', "import '../lib/superColliderRuntime.js';\n");
      write('server/lib/superColliderRuntime.js', "import './brandNewHelper.js';\n");
      write('server/lib/brandNewHelper.js', 'export const x = 1;\n');
      write('server/lib/unrelated.js', 'export const y = 1;\n');
      const inputs = collectSuperColliderLiveInputs(root);
      expect(inputs).toContain('server/lib/brandNewHelper.js');
      expect(inputs).not.toContain('server/lib/unrelated.js');
      // Every entry is an input even when absent, so deleting one still runs the job.
      for (const entry of SUPERCOLLIDER_LIVE_ENTRIES) expect(inputs).toContain(entry);
      expect(buildCiTestPlan(['server/lib/brandNewHelper.js'], { supercolliderLiveInputs: inputs }).supercolliderLive).toBe(true);
      expect(buildCiTestPlan(['server/lib/unrelated.js'], { supercolliderLiveInputs: inputs }).supercolliderLive).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('gates linux-containment on the whole closure of the tests the job runs', () => {
    // A transitive dependency of the route test that its name never mentions:
    // only the import walk can select it.
    const inputs = realTree();
    const closure = staticImportClosure(join(repo, 'server/routes/codeAnimationExecution.test.js')).files;
    expect(closure).toContain(join(repo, 'server/services/codeAnimation/execution.js'));
    for (const file of closure) {
      expect(inputs.linuxContainmentInputs).toContain(file.slice(repo.length).split('\\').join('/'));
    }
  });

  it('runs every gated job when forced full or when an input walk is inconclusive', () => {
    expect(gates(buildCiTestPlan(['docs/README.md'], { forceFull: true })))
      .toEqual({ promptHistory: true, linuxContainment: true, supercolliderLive: true });
    expect(gates(buildCiTestPlan(['docs/README.md'], {
      promptHistoryInputs: null, linuxContainmentInputs: null, supercolliderLiveInputs: null,
    }))).toEqual({ promptHistory: true, linuxContainment: true, supercolliderLive: true });
    expect(gates(buildCiTestPlan(['docs/README.md'], {
      promptHistoryInputs: [], linuxContainmentInputs: [], supercolliderLiveInputs: [],
    }))).toEqual({ promptHistory: false, linuxContainment: false, supercolliderLive: false });
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

  it('emits both decisions and ci.yml gates the jobs on them', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      emitGitHubPlan(buildCiTestPlan(['docs/README.md'], {
        promptHistoryInputs: [], linuxContainmentInputs: [], supercolliderLiveInputs: [],
      }));
      const outputs = JSON.parse(log.mock.calls.at(-1)[0]);
      expect(outputs).toMatchObject({ prompt_history: false, linux_containment: false, supercollider_live: false });
    } finally {
      log.mockRestore();
    }

    const jobs = workflowJobs(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8'));
    expect(jobs.impact).toContain('prompt_history: ${{ steps.plan.outputs.prompt_history }}');
    expect(jobs.impact).toContain('linux_containment: ${{ steps.plan.outputs.linux_containment }}');
    expect(jobs['prompt-history']).toContain('needs: impact');
    expect(jobs['prompt-history']).toContain("if: needs.impact.outputs.prompt_history == 'true'");
    expect(jobs['linux-containment']).toContain("if: needs.impact.outputs.linux_containment == 'true'");
    // The gate walks LINUX_CONTAINMENT_TESTS, so the job must run exactly those.
    const run = jobs['linux-containment'].match(/run: npm test --prefix server -- --run (.*)/)[1];
    expect(run.split(' ').map((path) => posix.join('server', path))).toEqual(LINUX_CONTAINMENT_TESTS);
    // A skipped gated job still reports to CI Gate, which treats skipped as passing.
    expect(jobs.gate).toContain('CI_GATE_RESULT_PROMPT_HISTORY: ${{ needs.prompt-history.result }}');
    expect(jobs.gate).toContain('CI_GATE_RESULT_LINUX_CONTAINMENT: ${{ needs.linux-containment.result }}');

    // The native SuperCollider matrix lives in ci.yml, is planner-gated, and a
    // red run fails CI Gate (#12612). No second workflow may run it on a PR.
    expect(jobs.impact).toContain('supercollider_live: ${{ steps.plan.outputs.supercollider_live }}');
    expect(jobs['supercollider-live']).toContain('needs: impact');
    expect(jobs['supercollider-live']).toContain("if: needs.impact.outputs.supercollider_live == 'true'");
    expect(jobs['supercollider-live']).toContain('runs-on: ${{ matrix.runner }}');
    expect(jobs.gate).toMatch(/needs: \[[^\]]*\bsupercollider-live\]/);
    expect(jobs.gate).toContain('CI_GATE_RESULT_SUPERCOLLIDER_LIVE: ${{ needs.supercollider-live.result }}');
    expect(existsSync(join(repo, '.github/workflows/supercollider-live.yml'))).toBe(false);

    // The Docker containment live suite (#12844) is planner-gated the same way.
    expect(jobs.impact).toContain('docker_containment_live: ${{ steps.plan.outputs.docker_containment_live }}');
    expect(jobs['docker-containment-live']).toContain("if: needs.impact.outputs.docker_containment_live == 'true'");
    expect(jobs['docker-containment-live']).toContain("PORTOS_DOCKER_CONTAINMENT_LIVE: '1'");
    expect(jobs['docker-containment-live']).toContain(`vitest run ${DOCKER_CONTAINMENT_LIVE_ENTRIES[0].replace('server/', '')}`);
    expect(jobs.gate).toMatch(/needs: \[[^\]]*\bdocker-containment-live\b/);
    expect(jobs.gate).toContain('CI_GATE_RESULT_DOCKER_CONTAINMENT_LIVE: ${{ needs.docker-containment-live.result }}');
  });

  it('selects the Docker containment live job for the profile, executor and engine resolver only', () => {
    for (const file of ['server/lib/dockerContainment.js', 'server/lib/dockerEgressProxy.js', 'server/services/dockerContainment.js', 'server/services/dockerEngine.js', 'server/lib/bufferedSpawn.js']) {
      expect(realPlan([file]).dockerContainmentLive, file).toBe(true);
    }
    expect(realPlan(['client/src/App.jsx']).dockerContainmentLive).toBe(false);
    expect(realPlan(['docs/CONTAINMENT.md']).dockerContainmentLive).toBe(false);
    expect(buildCiTestPlan(['docs/README.md'], { forceFull: true }).dockerContainmentLive).toBe(true);
  });
});
