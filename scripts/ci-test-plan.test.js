import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDbTestFiles } from './lib/dbTestFiles.js';
import {
  emitGitHubPlan,
  githubPlanOutput,
  buildCiTestPlan,
  isGeneratedSnapshotPush,
  getAlwaysRunTests,
  DOCKER_CONTAINMENT_LIVE_ENTRIES,
  LINUX_CONTAINMENT_TESTS,
  MACOS_NATIVE_TESTS,
  splitByRunner,
  SUPERCOLLIDER_LIVE_ENTRIES,
  TOOLING_OWNER_RE,
  TOOLING_TESTS,
  WINDOWS_CONTRACT_TESTS,
  classifyDependencyChange,
  collectPlanInputs,
  collectSuperColliderLiveInputs,
} from './ci-test-plan.js';
import { staticImportClosure } from '../server/lib/staticImportGraph.js';
import { readCiJobs } from './lib/ciWorkflowJobs.js';
import { workflowJobs } from './lib/workflowJobs.js';
import { BROWSER_SUITES } from './lib/browserSuites.js';
import { isGateToolingTest } from './lib/ciPlanRules.js';

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
  'server/services/backup/snapshots.js', 'server/services/backup/restore.js', 'server/services/backup/dbRestore.js',
  'client/src/components/catalog/GreyboxViewer.jsx', 'client/src/components/catalog/GreyboxCapture.jsx',
  'client/src/components/catalog/GreyboxPanel.jsx', 'client/src/pages/CatalogIngredient.jsx', 'server/lib/greyboxCapture.js',
  'client/src/lib/musicVideoFrameCapture.js', 'client/src/components/musicVideo/DocumentTemplateCanvas.jsx',
  'client/src/components/musicVideo/FrameStepper.jsx', 'client/src/components/musicVideo/PreviewVideo.jsx',
  'client/src/components/musicVideo/ProductionReviewPanel.jsx',
  'server/lib/eidoversePort.js', 'server/services/eidoverse.js', 'server/services/catalog/catalogSync.js', 'server/services/musicVideo/documentRender.js',
  'server/services/maintenanceRun.js', 'scripts/lib/guardBudget.js', 'scripts/pregate.js', 'server/test/admissionSetup.js',
  'server/lib/testHelper.js',
];
let realTreeInputs;
const realTree = () => (realTreeInputs ??= collectPlanInputs({ baseSha: 'HEAD', changedFiles: REAL_TREE_SOURCES, cwd: REPO_ROOT }));

it('includes the CTC contract in the related plan for changes to its Python test helper', () => {
  const source = 'server/lib/testHelper.js';
  const { server } = buildCiTestPlan([source], realTree());
  expect(server.mode).toBe('related');
  expect(server.files).toContain('scripts/ml/align_lyrics_ctc.test.js');
});

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
    expect(sourcePlan.server_files).toContain(contract);

    write(unicodeSource, 'export const value = 2;\n');
    commit();
    const unicodePlan = plan(base);
    expect(unicodePlan.full).toBe(false);
    expect(unicodePlan.changed_files).toEqual([unicodeSource, source]);
    expect(unicodePlan.server_sources).toContain(unicodeSource);
    expect(unicodePlan.server_files).toContain(contract);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('real shared-source import chains', () => {
  const cwd = REPO_ROOT;
  // Collect this static repository fixture before timed hooks/tests: the
  // synchronous whole-tree walk can exceed their budget on a loaded Windows host.
  const inputs = realTree();
  // Synthetic mutation and recollection regressions below keep their separate
  // per-call snapshots.

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
    expect(plan.server.files).toEqual(expect.arrayContaining(getAlwaysRunTests().filter((path) => path.startsWith('server/'))));
    // domainSchemas.test.js reaches the leaf only through pipelineValidation; it names
    // neither the leaf nor the editorial feature, so only traversal selects it.
    expect(plan.server.files).not.toContain('server/lib/domainSchemas.test.js');
    expect(staticImportClosure(join(cwd, 'server/lib/domainSchemas.test.js')).files)
      .toContain(join(cwd, source));
  });
});

// The gate-tooling suites spawn git or carry `test-memo: never`, so none can earn a
// narrowing record and `related` selection used to fail closed into every plan (#16798).
describe('gate-tooling tests in a related plan', () => {
  const inputs = realTree();
  const relatedPlan = (path) => {
    const plan = buildCiTestPlan([path], inputs);
    expect(plan.full, path).toBe(false);
    expect(plan.server.mode, path).toBe('related');
    return plan;
  };

  it('lists the gate-tooling suites, each an existing file under an owner path', () => {
    expect(TOOLING_TESTS).toContain('scripts/ci-test-plan.test.js');
    expect(TOOLING_TESTS).toHaveLength(9);
    for (const test of TOOLING_TESTS) {
      expect(existsSync(join(REPO_ROOT, test)), test).toBe(true);
      expect(TOOLING_OWNER_RE.test(test), test).toBe(true);
    }
  });

  it('adds none of them for a diff that touches no tooling', () => {
    const plan = relatedPlan('server/services/maintenanceRun.js');
    expect(plan.server.files.filter((path) => TOOLING_TESTS.includes(path))).toEqual([]);
  });

  it.each(['scripts/lib/guardBudget.js', 'scripts/pregate.js', 'server/test/admissionSetup.js'])(
    'selects every gate-tooling suite for a diff of %s, an owner path', (path) => {
      const plan = relatedPlan(path);
      expect(plan.server.files).toEqual(expect.arrayContaining(TOOLING_TESTS));
    });

  it.each([
    ['server/vitest.config.js', 'a Vitest config'],
    ['.github/workflows/ci.yml', 'a workflow'],
    ['server/package.json', 'a dependency manifest'],
  ])('still runs everything for %s (%s), which forces a full plan', (path) => {
    expect(buildCiTestPlan([path], inputs)).toMatchObject({ full: true, server: { mode: 'full' } });
  });

  it('matches every dependency manifest and Vitest config owner and nothing broader', () => {
    for (const path of ['package.json', 'package-lock.json', 'client/package.json', 'server/package-lock.json', 'server/.npmrc', 'client/vitest.config.js', 'server/vitest.setup.js']) {
      expect(TOOLING_OWNER_RE.test(path), path).toBe(true);
    }
    for (const path of ['server/services/maintenanceRun.js', 'server/lib/vitestHelper.js', 'client/src/vitest.js', 'docs/package.json.md', 'server/test/browserFixture.js']) {
      expect(TOOLING_OWNER_RE.test(path), path).toBe(false);
    }
  });

  // End to end through the memo walk: the planner's list plus planTestMemo, over the real
  // tree. Without the runner's narrowing, pregate.test.js (an open read) and
  // run-ci-tests.test.js (an unresolved edge) are selected for this diff.
  it('keeps both the integration and split planner suites out of memo-resolved selection for an unrelated diff', async () => {
    const { planTestMemo } = await import('./lib/testMemoRunner.js');
    const { toWorkspacePath } = await import('./lib/workspaceTests.js');
    const toolingTests = inputs.trackedFiles.filter(isGateToolingTest);
    const resolve = (path) => {
      const plan = relatedPlan(path);
      return planTestMemo({
        scope: 'server', mode: plan.server.mode, repoFiles: plan.server.files, repoSources: plan.server.sources,
        memoDir: null, repoRoot: REPO_ROOT, env: process.env, platform: process.platform, arch: process.arch, nodeVersion: process.version,
        // Only the tooling suites need analysis here; the rest of the inventory adds time, not coverage.
        listTests: () => toolingTests.map((test) => toWorkspacePath('server', test)),
      }).selected;
    };
    expect(resolve('server/services/maintenanceRun.js').filter(isGateToolingTest)).toEqual([]);
  }, 120_000);
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
      client_mode: 'related', client_sources: [leaf] });
    expect(shared.server_mode).not.toBe('skip');
    expect(plan(['server/lib/shared/leaf.ts'])).toMatchObject({ build: true,
      client_mode: 'related', client_sources: ['server/lib/shared/leaf.ts'] });

    const mixed = plan([leaf, clientSource, clientTest]);
    expect(mixed).toMatchObject({ client_mode: 'related', client_sources: [clientSource, leaf],
      client_files: [clientTest] });
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

    expect(plan(leaf)).toMatchObject({
      full: false,
      build: false,
      client_mode: 'files',
      client_files: [consumer],
      suite_reasons: {
        client: 'client test and contract coverage selected',
        build: 'skipped: no client-impacting source changed',
      },
    });
    expect(plan(unused)).toMatchObject({ full: false, build: false, client_mode: 'skip' });

    write('client/src/test/fixture.js', "export { value } from './missing.js';\n");
    expect(plan(leaf)).toMatchObject({ full: false, build: false,
      client_mode: 'files', client_files: [consumer] });

    write(consumer, "const fixture = await import(globalThis.fixturePath);\n");
    expect(plan(leaf)).toMatchObject({ full: false, build: false,
      client_mode: 'files', client_files: [consumer] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('resolves the bounded dynamic imports so an unrelated edit does not poison DB or browser dependencies', () => {
  const inputs = realTree();
  expect(inputs.dbDependencies).not.toBeNull();
  expect(Object.entries(inputs.browserDependencies).filter(([, deps]) => deps === null)).toEqual([]);
});

it('requests DB verification for every shape of suite in the real canonical inventory without widening the matrix', () => {
  const inputs = realTree();
  const dbTests = resolveDbTestFiles(inputs.trackedFiles);
  expect(dbTests.length).toBeGreaterThan(50);
  // Routing keys on the same resolver that built this list, so one real suite
  // per inventory shape proves the rule; planning all 50+ only repeated it.
  const shapes = {
    scripts: (path) => path.startsWith('scripts/'),
    store: (path) => path.endsWith('/db.test.js'),
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

it('runs the whole-tree import-cycle guard on a PR that touches one server/services file (#14327)', () => {
  const plan = buildCiTestPlan(['server/services/auth.js'], realTree());
  // The cycle check is a module the structural guard runner loads (#16996).
  expect(existsSync(join(REPO_ROOT, 'server/test/guards/modules/serviceImportCycles.test.js'))).toBe(true);
  expect(plan.server.files).toContain('server/test/guards/modules.guard.test.js');
});

it('requests DB verification for the real deck, model pin and backup source contracts', () => {
  // The backup facade re-exports its snapshot, file-restore and database-restore
  // modules, so a change to any of them must still reach backup.db.test.js.
  const sources = ['server/routes/decks.js', 'server/services/modelPinRecords.js', 'server/services/backup.js',
    'server/services/backup/snapshots.js', 'server/services/backup/restore.js', 'server/services/backup/dbRestore.js'];
  const inputs = realTree();
  for (const source of sources) {
    expect(buildCiTestPlan([source], inputs), source).toMatchObject({ full: false, db: true });
  }
});

it('keeps document generation and provider inputs out of the render-only browser closure', () => {
  const { browserDependencies } = realTree();
  const renderSuites = [
    'server/services/musicVideo/documentRender.browser.test.js',
    'server/services/musicVideo/documentRenderAudioTimeline.browser.test.js',
  ];
  const generation = browserDependencies['server/services/musicVideo/documentRenderGeneration.browser.test.js'];
  const generationInputs = [
    'server/services/musicVideo/documentGeneration.js',
    'server/lib/aiToolkit/internal/providerCatalogService.js',
    'server/lib/systemCapabilities.js',
  ];
  for (const suite of renderSuites) {
    const render = browserDependencies[suite];
    expect(render).toContain('server/services/musicVideo/documentRender.js');
    for (const input of generationInputs) expect(render).not.toContain(input);
  }
  expect(generation).toEqual(expect.arrayContaining(generationInputs));
});

describe('late-bound hubs keep unrelated suites out of browser and DB plans (#17896)', () => {
  const planFor = (source) => buildCiTestPlan([source], realTree());

  it.each(['server/lib/eidoversePort.js', 'server/services/eidoverse.js'])('plans no DB job and no browser suite for %s', (source) => {
    expect(planFor(source)).toMatchObject({ full: false, db: false, browserFiles: [] });
  });

  it('plans the DB job but no media or vault browser suite for the catalog sync service', () => {
    const plan = planFor('server/services/catalog/catalogSync.js');
    expect(plan).toMatchObject({ full: false, db: true });
    expect(plan.browserFiles.filter((suite) => !/catalog/i.test(suite))).toEqual([]);
  });

  it('still selects real direct and transitive dependents', () => {
    const inputs = realTree();
    const render = 'server/services/musicVideo/documentRender.js';
    expect(planFor(render).browserFiles).toEqual(expect.arrayContaining([
      'server/services/musicVideo/documentRender.browser.test.js',
      'server/services/musicVideo/documentRenderAudioTimeline.browser.test.js',
      'server/services/musicVideo/documentVignette.browser.test.js',
    ]));
    // Reached only through a lazy import, several modules below the suite.
    expect(inputs.browserDependencies['server/services/musicVideo/documentVignette.browser.test.js']).toContain('server/services/htmlComposition/index.js');
    expect(inputs.dbDependencies).toEqual(expect.arrayContaining([
      'server/services/catalog/catalogSync.js', 'server/services/syncCursors.js', 'server/services/instanceFeatures.js',
    ]));
  });
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
  const liveRestore = 'server/services/backupDatabaseDump.restore.live.test.js';
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
    write(liveRestore, '// No shared dependencies.\n');
    write('server/services/unrelated.js', 'export const value = 2;\n');
    git('add', '--all');

    // The contract neither names leaf.js nor shares its feature; only the
    // dependency walk can request the otherwise excluded database suite.
    const related = plan([leaf]);
    expect(related).toMatchObject({ full: false, db: true, db_live_restore: false, server_mode: 'related' });
    expect(related.server_files).not.toContain(contract);
    expect(plan(['server/services/unrelated.js'])).toMatchObject({ full: false, db: false });
    expect(plan(['docs/README.md'])).toMatchObject({ full: false, db: false });

    const restoreOnly = 'server/services/restoreInput.js';
    write(restoreOnly, 'export const value = 3;\n');
    write(liveRestore, "import './restoreInput.js';\n");
    expect(plan([restoreOnly])).toMatchObject({ full: false, db: true, db_live_restore: true });
    write(liveRestore, "import './missing.js';\n");
    expect(plan([restoreOnly])).toMatchObject({ full: false, db: true, db_live_restore: true });
    write(liveRestore, '// No shared dependencies.\n');

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
  const browsers = (result) => result.browser_files;
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
    expect(related).toMatchObject({ full: false, server_mode: 'related', server_sources: [leaf] });
    expect(related.server_files).not.toContain(staticSuite);
    expect(related.server_files).not.toContain(deferredSuite);
    expect(browsers(related)).toEqual([staticSuite, deferredSuite]);
    expect(related.browser_shards).toEqual([1, 2]);
    expect(related.suite_reasons.browser).toBe('2 cross-workspace browser suite(s) selected');
    expect(browsers(plan([leaf, staticSuite]))).toEqual([staticSuite, deferredSuite]);
    expect(browsers(plan([unrelated]))).toEqual([]);
    expect(browsers(plan(['docs/README.md']))).toEqual([]);
    expect(plan([staticSuite])).toMatchObject({ browser: true, browser_files: [staticSuite], browser_shards: [1] });
    expect(browsers(plan([], true))).toEqual([staticSuite, deferredSuite, independentSuite]);

    // Inconclusive discovery widens only the affected registered suite while
    // the ordinary server run keeps its existing related sources/selectors.
    for (const expression of ["'../services/missing.js'", 'modulePath']) {
      write(independentSuite, `export const load = () => import(${expression});\n`);
      const conservative = plan([unrelated]);
      expect(conservative).toMatchObject({ full: false, server_mode: 'related', server_sources: [unrelated] });
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
    const suites = [
      'server/services/musicVideo/animaticCapture.browser.test.js',
      'server/services/musicVideo/animaticCaptureOverlays.browser.test.js',
    ];
    const inputs = realTree();
    const trackedFiles = inputs.trackedFiles.filter((path) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || BROWSER_SUITES.includes(path));
    for (const source of ['client/src/lib/musicVideoFrameCapture.js', 'client/src/components/musicVideo/FrameStepper.jsx', 'client/src/components/musicVideo/PreviewVideo.jsx']) {
      const plan = buildCiTestPlan([source], { ...inputs, trackedFiles });
      expect(plan.full, source).toBe(false);
      expect(plan.browserFiles, source).toEqual(expect.arrayContaining(suites));
    }
  });

  it('keeps unrelated catalog edits out of composition and music-video browser suites (#18337)', () => {
    const suites = [
      'server/services/htmlComposition/index.test.js',
      'server/services/musicVideo/animaticCapture.browser.test.js',
      'server/services/musicVideo/animaticCaptureOverlays.browser.test.js',
      'server/services/musicVideo/documentTemplateParity.browser.test.js',
      'server/services/musicVideo/documentFilmLook.browser.test.js',
      'server/services/musicVideo/lyricPlaythrough.browser.test.js',
    ];
    const catalogFiles = [
      'server/lib/localLlmCatalog.js', 'server/lib/aiToolkit/internal/providerCatalogService.js',
      'server/lib/localModelHeuristics.js', 'server/lib/systemCapabilities.js',
    ];
    const inputs = realTree();
    const trackedFiles = inputs.trackedFiles.filter((path) =>
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || BROWSER_SUITES.includes(path));
    const plan = buildCiTestPlan(catalogFiles, { ...inputs, trackedFiles });
    expect(plan.full).toBe(false);
    for (const suite of suites) {
      for (const file of catalogFiles) {
        expect(inputs.browserDependencies[suite], `${suite} reaches ${file}`).not.toContain(file);
      }
      expect(plan.browserFiles).not.toContain(suite);
    }
    // Code-animation export reaches systemCapabilities.js through the media
    // queue's model registry, which checks hardware compatibility.
    const openCodeConfig = 'server/lib/opencodeConfig.js';
    for (const suite of [...suites, 'server/services/codeAnimation/export.realBrowser.test.js']) {
      expect(inputs.browserDependencies[suite], `${suite} reaches ${openCodeConfig}`).not.toContain(openCodeConfig);
    }
  });

  it('selects only the music-video browser suites that mount ProductionReviewPanel when it changes', () => {
    const source = 'client/src/components/musicVideo/ProductionReviewPanel.jsx';
    const inputs = realTree();
    // Keep the real source/import walk, with a bounded test corpus. Unrelated
    // feature-test growth must not route this scoped-browser contract through
    // the safety-cap fallback (the full-plan contract is checked separately).
    const trackedFiles = inputs.trackedFiles.filter((path) =>
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || BROWSER_SUITES.includes(path));
    const plan = buildCiTestPlan([source], { ...inputs, trackedFiles });

    // Only the three route suites mount ProductionReviewPanel.jsx (via pathContractTests);
    // server-only musicVideo render/publish/title-card suites do not mount it (#17895).
    const mountedSuites = [
      'server/routes/musicVideoProductionReview.browser.test.js',
      'server/routes/musicVideoRichAuthoring.browser.test.js',
      'server/routes/musicVideoSongRevision.browser.test.js',
    ];
    expect(plan.full).toBe(false);
    expect(plan.browserFiles).toEqual(mountedSuites);
    expect(plan.browserFiles).not.toContain('server/routes/catalogGreyboxViewer.browser.test.js');
    expect(plan.browserFiles).not.toContain('server/lib/musicVideo/musicVideoTitleCard.browser.test.js');
    expect(plan.browserFiles).not.toContain('server/services/musicVideo/documentRender.browser.test.js');
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
    // Planning sorts selectors. The registry assigns shard owners by path.
    expect(plan.browserFiles).toEqual([...BROWSER_SUITES].sort());
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

describe('path-gated single-purpose jobs', () => {
  const repo = REPO_ROOT;
  // The gates read only the static input lists, which do not depend on the
  // diff; walking the repository once per case exceeded the 5 s test timeout (#12461).
  const realPlan = (changedFiles) => {
    const { linuxContainmentInputs, supercolliderLiveInputs, dockerContainmentLiveInputs } = realTree();
    return buildCiTestPlan(changedFiles, { linuxContainmentInputs, supercolliderLiveInputs, dockerContainmentLiveInputs });
  };
  const gates = (plan) => ({
    linuxContainment: plan.linuxContainment, supercolliderLive: plan.supercolliderLive,
  });

  it('runs each job only when the real diff reaches its inputs', () => {
    expect(gates(realPlan(['docs/README.md'])))
      .toEqual({ linuxContainment: false, supercolliderLive: false });
    // Shared helper reached through the containment suite's import closure.
    expect(gates(realPlan(['server/lib/spawnCwd.js']))).toMatchObject({ linuxContainment: true });
    expect(gates(realPlan(['server/lib/codeAnimationContainment.js'])))
      .toEqual({ linuxContainment: true, supercolliderLive: false });
    expect(gates(realPlan(['server/package-lock.json']))).toMatchObject({ linuxContainment: true, supercolliderLive: true });
    expect(gates(realPlan(['.github/workflows/ci.yml'])))
      .toEqual({ linuxContainment: true, supercolliderLive: true });
  });

  it('keeps fileUtils/jsonIo/auth/browser barrels out of containment closures (#18218)', () => {
    const { trackedFiles, linuxContainmentInputs, dockerContainmentLiveInputs } = realTree();
    for (const excluded of ['server/lib/jsonIo.js', 'server/lib/secureAuthStore.js', 'server/lib/fileUtils.js']) {
      expect(linuxContainmentInputs).not.toContain(excluded);
      expect(dockerContainmentLiveInputs).not.toContain(excluded);
    }
    for (const excluded of ['server/services/authGate.js', 'server/services/browserService.js', 'server/services/pm2.js']) {
      expect(linuxContainmentInputs).not.toContain(excluded);
    }
    expect(buildCiTestPlan(['server/lib/jsonIo.js'], {
      trackedFiles, linuxContainmentInputs, dockerContainmentLiveInputs,
    })).toMatchObject({ linuxContainment: false, dockerContainmentLive: false });
    expect(buildCiTestPlan(['server/lib/secureAuthStore.js'], {
      trackedFiles, linuxContainmentInputs, dockerContainmentLiveInputs,
    })).toMatchObject({ linuxContainment: false });
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
      // The planner's module graph covers tracked files, as in CI.
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['add', '.'], { cwd: root });
      const inputs = collectSuperColliderLiveInputs(root);
      expect(inputs).toContain('server/lib/brandNewHelper.js');
      expect(inputs).not.toContain('server/lib/unrelated.js');
      // Every entry is an input even when absent, so deleting one still runs the job.
      for (const entry of SUPERCOLLIDER_LIVE_ENTRIES) expect(inputs).toContain(entry);
      expect(buildCiTestPlan(['server/lib/brandNewHelper.js'], { supercolliderLiveInputs: inputs }).supercolliderLive).toBe(true);
      expect(buildCiTestPlan(['server/lib/unrelated.js'], { supercolliderLiveInputs: inputs }).supercolliderLive).toBe(false);
      // An entry on disk the tracked graph cannot see has unknown edges: the job runs.
      write('scripts/setup-supercollider.js', "import '../server/lib/brandNewHelper.js';\n");
      expect(collectSuperColliderLiveInputs(root)).toBeNull();
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
      .toEqual({ linuxContainment: true, supercolliderLive: true });
    expect(gates(buildCiTestPlan(['docs/README.md'], {
      linuxContainmentInputs: null, supercolliderLiveInputs: null,
    }))).toEqual({ linuxContainment: true, supercolliderLive: true });
    expect(gates(buildCiTestPlan(['docs/README.md'], {
      linuxContainmentInputs: [], supercolliderLiveInputs: [],
    }))).toEqual({ linuxContainment: false, supercolliderLive: false });
  });

  it('emits both decisions and ci.yml gates the jobs on them', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      emitGitHubPlan(buildCiTestPlan(['docs/README.md'], {
        linuxContainmentInputs: [], supercolliderLiveInputs: [],
      }));
      const outputs = JSON.parse(log.mock.calls.at(-1)[0]);
      expect(outputs).toMatchObject({ linux_containment: false, supercollider_live: false });
    } finally {
      log.mockRestore();
    }

    const jobs = workflowJobs(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8'));
    expect(jobs['linux-containment']).toContain('if: fromJSON(needs.impact.outputs.plan).linux_containment\n');
    // The gate walks LINUX_CONTAINMENT_TESTS, so the job must run exactly those.
    const run = jobs['linux-containment'].match(/run: bash scripts\/ci-install-containment-tools\.sh npm test --prefix server -- --run (.*)/)[1];
    expect(run.split(' ').map((path) => posix.normalize(posix.join('server', path)))).toEqual(LINUX_CONTAINMENT_TESTS);
    // A skipped gated job still reports to CI Gate, which treats skipped as passing.
    expect(jobs.gate).toContain('CI_GATE_RESULT_LINUX_CONTAINMENT: ${{ needs.linux-containment.result }}');

    // The native SuperCollider matrix lives in ci.yml, is planner-gated, and a
    // red run fails CI Gate (#12612). No second workflow may run it on a PR.
    expect(jobs['supercollider-live']).toContain('needs: impact');
    expect(jobs['supercollider-live']).toContain('if: fromJSON(needs.impact.outputs.plan).supercollider_live\n');
    expect(jobs['supercollider-live']).toContain('runs-on: ${{ matrix.runner }}');
    expect(jobs.gate).toMatch(/needs: \[[^\]]*\bsupercollider-live\]/);
    expect(jobs.gate).toContain('CI_GATE_RESULT_SUPERCOLLIDER_LIVE: ${{ needs.supercollider-live.result }}');
    expect(existsSync(join(repo, '.github/workflows/supercollider-live.yml'))).toBe(false);

    // The Docker containment live suite (#12844) is planner-gated the same way.
    expect(jobs['docker-containment-live']).toContain('if: fromJSON(needs.impact.outputs.plan).docker_containment_live\n');
    expect(jobs['docker-containment-live']).toContain("PORTOS_DOCKER_CONTAINMENT_LIVE: '1'");
    expect(jobs['docker-containment-live']).toContain(`vitest run ${DOCKER_CONTAINMENT_LIVE_ENTRIES[0].replace('server/', '')}`);
    expect(jobs.gate).toMatch(/needs: \[[^\]]*\bdocker-containment-live\b/);
    expect(jobs.gate).toContain('CI_GATE_RESULT_DOCKER_CONTAINMENT_LIVE: ${{ needs.docker-containment-live.result }}');
  });

  // #18633: a scheduled run in the main ref group was the pending run a push
  // dropped, so its enforced budget, ungated native jobs and cache seeding lapsed.
  it('keeps scheduled runs in their own concurrency group and cancels only superseded PR runs', () => {
    const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain(
      "group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || (github.event_name == 'schedule' && 'schedule') || github.ref }}",
    );
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  // #16555: ci.yml reads every decision from the one `plan` output. A read of
  // a key the planner never emits is `null` in Actions, which silently skips
  // the job (or, in a gate's `!…` test, silently passes it) instead of failing.
  it('emits every plan key ci.yml reads, with JSON types the expressions compare correctly', () => {
    const output = githubPlanOutput(buildCiTestPlan(['docs/README.md'], {
      linuxContainmentInputs: [], supercolliderLiveInputs: [],
    }));
    const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
    const reads = [...ci.matchAll(/fromJSON\(needs\.impact\.outputs\.plan\)\.(\w+)(\s*[!=]=\s*'[^']*')?/g)];
    expect(reads.length).toBeGreaterThan(20);
    for (const [, key, comparison] of reads) {
      expect(Object.keys(output), `ci.yml reads plan.${key}`).toContain(key);
      // After fromJSON a boolean never equals the string 'true' (Actions
      // coerces both to numbers), so a boolean key is tested bare.
      if (typeof output[key] === 'boolean') expect(comparison, `plan.${key} compared as a string`).toBeUndefined();
    }
    // Every other impact output stays a declared, separately emitted value.
    const impactOutputs = [...workflowJobs(ci).impact.matchAll(/^ {6}(\w+): \$\{\{/gm)].map(([, name]) => name);
    expect(impactOutputs).toEqual(['plan', 'server_shards', 'client_shards', 'browser_shards', 'windows_shards', 'db_image']);
    for (const [, name] of ci.matchAll(/needs\.impact\.outputs\.(\w+)/g)) expect(impactOutputs, name).toContain(name);
  });

  it('gates actionlint setup, execution and fixture proof on workflow coverage', () => {
    const workflow = '.github/workflows/ci.yml';
    const lint = (mode, files) => githubPlanOutput({
      ...buildCiTestPlan(['docs/README.md']),
      lint: { mode, files },
    }).workflow_lint;
    expect(lint('full', [])).toBe(true);
    expect(lint('files', [workflow])).toBe(true);
    expect(lint('files', ['client/src/App.test.jsx'])).toBe(false);
    expect(lint('skip', [])).toBe(false);
    expect(githubPlanOutput(buildCiTestPlan([workflow], { trackedFiles: [workflow] })).workflow_lint).toBe(true);
    const { lint: job } = readCiJobs();
    for (const name of ['Install pinned actionlint', 'Lint workflows with actionlint', 'Prove actionlint rejects the known-bad fixture']) {
      expect(job).toContain(`- name: ${name}\n        if: fromJSON(needs.impact.outputs.plan).workflow_lint`);
    }
  });

  it('selects the Docker containment live job for the profile, executor and engine resolver only', () => {
    for (const file of ['server/lib/dockerContainment.js', 'server/lib/dockerEgressProxy.js', 'server/services/dockerContainment.js', 'server/services/dockerEngine.js', 'server/lib/bufferedSpawn.js']) {
      expect(realPlan([file]).dockerContainmentLive, file).toBe(true);
    }
    expect(realPlan(['client/src/App.jsx']).dockerContainmentLive).toBe(false);
    expect(realPlan(['docs/CONTAINMENT.md']).dockerContainmentLive).toBe(false);
    expect(buildCiTestPlan(['docs/README.md'], { forceFull: true }).dockerContainmentLive).toBe(true);
  });

  // The launchd-coalition suites skip on Linux and Windows, so this job is the
  // only CI proof of macOS release recovery (#14781).
  it('runs the macOS supervision suites only for the native supervision path and its harness', () => {
    for (const file of [
      'server/lib/windowsAgentProcess.js', 'server/lib/windowsAgentProcess.darwin.test.js', 'server/lib/darwinAgentSupervisor.py',
      'server/vitest.config.js', 'server/package-lock.json', 'server/.npmrc',
      'scripts/trusted-rebuilds.js', '.github/workflows/ci.yml', '.github/actions/setup-server/action.yml',
    ]) expect(buildCiTestPlan([file]).macosNative, file).toBe(true);
    for (const file of [
      'server/lib/windowsAgentSupervisor.ps1', 'server/lib/linuxAgentSupervisor.py', 'server/lib/bufferedSpawn.js',
      'server/services/releasePreflight.js', 'server/services/releaseCandidateEvidence.js', 'client/src/App.jsx', 'docs/GITHUB_ACTIONS.md',
      '.github/workflows/release.yml', 'package-lock.json', 'client/.npmrc', '.github/actions/setup-client/action.yml',
    ]) expect(buildCiTestPlan([file]).macosNative, file).toBe(false);
    expect(buildCiTestPlan(['docs/README.md'], { forceFull: true }).macosNative).toBe(true);

    const jobs = workflowJobs(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8'));
    expect(jobs['macos-native']).toContain('if: fromJSON(needs.impact.outputs.plan).macos_native\n');
    expect(jobs['macos-native']).toContain('runs-on: macos-latest');
    const run = jobs['macos-native'].match(/npm test --prefix server -- --run (.+)/)[1].trim();
    expect(run.split(' ').map((path) => posix.join('server', path))).toEqual(MACOS_NATIVE_TESTS);
    for (const test of MACOS_NATIVE_TESTS) expect(existsSync(join(repo, test)), test).toBe(true);
    expect(jobs.gate).toMatch(/needs: \[[^\]]*\bmacos-native\b/);
    expect(jobs.gate).toContain('CI_GATE_RESULT_MACOS_NATIVE: ${{ needs.macos-native.result }}');
  });

  it('runs the Node minimum job only for the manifests, runtime gate and workflow that can change its answer', () => {
    for (const file of ['package.json', 'server/package-lock.json', 'client/.npmrc', '.nvmrc',
      'scripts/checkNodeVersion.js', 'scripts/lib/directInvocation.js', 'server/test/guards/repo/node-version-drift.test.js', 'server/test/guards/repo.guard.test.js', '.github/workflows/ci.yml',
    ]) expect(buildCiTestPlan([file]).nodeMinimum, file).toBe(true);
    for (const file of ['docs/README.md', 'server/lib/processEnv.js', 'client/src/App.jsx', 'browser/package.json', '.github/workflows/release.yml']) {
      expect(buildCiTestPlan([file]).nodeMinimum, file).toBe(false);
    }
    expect(buildCiTestPlan(['docs/README.md'], { forceFull: true }).nodeMinimum).toBe(true);

    const jobs = workflowJobs(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8'));
    expect(jobs['node-minimum']).toContain('if: fromJSON(needs.impact.outputs.plan).node_minimum\n');
    expect(jobs.gate).toContain('CI_GATE_RESULT_NODE_MINIMUM: ${{ needs.node-minimum.result }}');
  });
});

// A push to main runs the complete primary suites, but the native
// single-purpose jobs follow the tree diff since the last green push or
// schedule run (CI_GATED_BASE_SHA from scripts/ci-base-sha.js), so a client
// change no longer queues the macOS, Windows and SuperCollider runners.
describe('native jobs on a push to main', () => {
  const NATIVE_OUTPUTS = ['linux_containment', 'supercollider_live', 'docker_containment_live',
    'macos_native', 'node_minimum', 'windows'];
  const nativeOutputs = (outputs) => Object.fromEntries(NATIVE_OUTPUTS.map((name) => [name, outputs[name]]));
  const allNative = (value) => Object.fromEntries(NATIVE_OUTPUTS.map((name) => [name, value]));
  const gatedPlan = (gatedChangedFiles, extra = {}) => {
    const { linuxContainmentInputs, supercolliderLiveInputs, dockerContainmentLiveInputs } = realTree();
    return buildCiTestPlan([], {
      forceFull: true, forceFullReason: 'full CI requested', trackedFiles: WINDOWS_CONTRACT_TESTS, gatedChangedFiles,
      linuxContainmentInputs, supercolliderLiveInputs, dockerContainmentLiveInputs, ...extra,
    });
  };
  const gates = (plan) => ({
    linuxContainment: plan.linuxContainment, supercolliderLive: plan.supercolliderLive,
    dockerContainmentLive: plan.dockerContainmentLive, macosNative: plan.macosNative, nodeMinimum: plan.nodeMinimum, windows: plan.windows,
  });
  const none = { linuxContainment: false, supercolliderLive: false, dockerContainmentLive: false,
    macosNative: false, nodeMinimum: false, windows: false };

  it('plans the push through the CLI from the diff against the last green main commit, and falls back to every job', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-ci-gated-push-'));
    const planner = fileURLToPath(new URL('./ci-test-plan.js', import.meta.url));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const write = (path, body) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    };
    const commit = () => {
      git('add', '--all');
      git('-c', 'user.name=Example Contributor', '-c', 'user.email=contributor@example.com',
        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD');
    };
    const plan = (gatedBase) => JSON.parse(execFileSync(process.execPath, [planner], {
      cwd: root, encoding: 'utf8', stdio: PLANNER_STDIO,
      env: { ...process.env, CI_BASE_SHA: '', CI_BASE_REF: '', CI_FORCE_FULL: 'true', CI_CHANGED_FILES: undefined,
        CI_GATED_BASE_SHA: gatedBase, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
    }));
    try {
      git('init', '-q');
      git('config', 'core.hooksPath', join(root, 'empty-hooks'));
      // The forced-full Windows plan checks its contract inventory is tracked.
      for (const test of WINDOWS_CONTRACT_TESTS) write(test, '// fixture\n');
      write('client/src/pages/Example.jsx', 'export const value = 1;\n');
      write('server/lib/darwinAgentSupervisor.py', 'print("fixture")\n');
      const green = commit();

      write('client/src/pages/Example.jsx', 'export const value = 2;\n');
      commit();
      const clientOnly = plan(green);
      // The primary suites stay complete; only the native jobs are gated.
      expect(clientOnly).toMatchObject({ full: true, server_mode: 'full', client_mode: 'full', db: true, build: true, smoke: true });
      expect(nativeOutputs(clientOnly)).toEqual(allNative(false));
      expect(clientOnly.windows_mode).toBe('skip');
      // Native gating withholds the Full CI Gate.
      expect(clientOnly.native_gated).toBe(true);

      write('server/lib/darwinAgentSupervisor.py', 'print("changed")\n');
      commit();
      expect(nativeOutputs(plan(green))).toEqual({ ...allNative(false), macos_native: true });

      // A base git cannot diff against (a failed fetch) fails open.
      const unresolvable = plan('0'.repeat(40));
      expect(nativeOutputs(unresolvable)).toEqual(allNative(true));
      expect(unresolvable).toMatchObject({ windows_mode: 'files', native_gated: false });
      // As does a push whose lookup exported nothing.
      expect(nativeOutputs(plan(''))).toEqual(allNative(true));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('decides each native job from the gated diff exactly as a pull request would', () => {
    expect(gates(gatedPlan(['client/src/App.jsx', 'client/src/components/Layout.jsx']))).toEqual(none);
    expect(gates(gatedPlan([]))).toEqual(none);
    expect(gates(gatedPlan(['server/lib/darwinAgentSupervisor.py']))).toEqual({ ...none, macosNative: true });
    expect(gates(gatedPlan(['server/lib/codeAnimationContainment.js']))).toMatchObject({ linuxContainment: true, macosNative: false, nodeMinimum: false, windows: false });
    expect(gates(gatedPlan(['server/services/dockerEngine.js']))).toMatchObject({ dockerContainmentLive: true, macosNative: false });
    expect(gates(gatedPlan(['package.json']))).toMatchObject({ nodeMinimum: true, supercolliderLive: true, macosNative: false });
    expect(gates(gatedPlan(['server/lib/bufferedSpawn.js']))).toMatchObject({ windows: true, supercolliderLive: true, macosNative: false });
    expect(gates(gatedPlan(['.github/workflows/ci.yml']))).toEqual(Object.fromEntries(Object.keys(none).map((key) => [key, true])));

    // A gated Windows run carries the same native contract set as any other.
    const windowsPlan = gatedPlan(['scripts/fix-windows-console.js']);
    expect(windowsPlan).toMatchObject({ full: true, windows: true, windowsMode: 'files', windowsFiles: [...WINDOWS_CONTRACT_TESTS].sort() });
    expect(windowsPlan.suiteReasons.windows).toContain('native jobs gated on 1 file(s) changed since the last green main run');
    expect(gatedPlan([]).suiteReasons.windows).toMatch(/^skipped: no Windows native contract changed/);
  });

  it('lets only a proven platform-neutral server manifest change skip Windows', () => {
    const LOCK = 'server/package-lock.json';
    const lock = (packages) => JSON.stringify({ name: 'server', lockfileVersion: 3, packages: { '': { name: 'server' }, ...packages } });
    const base = lock({ 'node_modules/express': { version: '5.0.0' } });
    const neutral = classifyDependencyChange(LOCK, base, lock({ 'node_modules/express': { version: '5.1.0' } }));
    const sensitive = classifyDependencyChange(LOCK, base, lock({ 'node_modules/express': { version: '5.0.0' }, 'node_modules/node-pty': { version: '1.0.0' } }));
    expect(gatedPlan([LOCK], { gatedDependencyChanges: { [LOCK]: neutral } }).windows).toBe(false);
    expect(gatedPlan([LOCK], { gatedDependencyChanges: { [LOCK]: sensitive } }).windows).toBe(true);
    // No comparison available fails closed.
    expect(gatedPlan([LOCK]).windows).toBe(true);
  });

  it('runs every native job when forced full without a gated diff', () => {
    expect(gates(buildCiTestPlan([], { forceFull: true, trackedFiles: WINDOWS_CONTRACT_TESTS, gatedChangedFiles: null })))
      .toEqual(Object.fromEntries(Object.keys(none).map((key) => [key, true])));
    // An inconclusive closure walk still runs its job.
    expect(gatedPlan(['client/src/App.jsx'], { linuxContainmentInputs: null }).linuxContainment).toBe(true);
    // A pull request never takes the gated path, even if handed a list.
    expect(buildCiTestPlan(['docs/README.md'], { gatedChangedFiles: ['server/lib/darwinAgentSupervisor.py'] }).macosNative).toBe(false);
  });

  describe('generated snapshot push (#18457)', () => {
    const GREEN = 'a'.repeat(40);
    const snapshotPlan = (gatedChangedFiles, extra = {}) => gatedPlan(gatedChangedFiles, {
      gatedBaseSha: GREEN, predecessorGreenSha: GREEN, ...extra,
    });
    const jobsRun = (plan) => githubPlanOutput(plan);

    it.each([
      ['run 45350192457 diff', ['.quality.json']],
      ['run 45337587297 diff', ['.quality.json']],
    ])('runs the generated-data plan for %s and never offers release evidence', (_name, diff) => {
      const plan = snapshotPlan(diff);
      const out = jobsRun(plan);
      expect(out).toMatchObject({
        full: false, server_mode: 'skip', client_mode: 'skip', db: false, build: false, smoke: false,
        windows: false, native_gated: true, snapshot_scoped: true, lint_mode: 'skip',
      });
      expect(out.reason).toMatch(/^generated snapshot push: only \.quality\.json changed since the green first parent aaaaaaaaa/);
      expect(gates(plan)).toEqual(none);
    });

    it.each([
      ['a concurrent code change', ['.quality.json', 'server/lib/db.js']],
      ['the snapshot renamed into another path', ['.quality.json', 'docs/quality.json']],
      ['an empty diff', []],
      ['an unreadable diff', null],
    ])('keeps the full plan for %s', (_name, diff) => {
      const out = jobsRun(snapshotPlan(diff));
      expect(out).toMatchObject({ full: true, snapshot_scoped: false });
      expect(out.reason).toBe('full CI requested');
    });

    it('keeps the full plan without proof the green run is the first parent', () => {
      expect(jobsRun(snapshotPlan(['.quality.json'], { predecessorGreenSha: undefined })).full).toBe(true);
      expect(jobsRun(snapshotPlan(['.quality.json'], { predecessorGreenSha: 'b'.repeat(40) })).full).toBe(true);
      expect(jobsRun(snapshotPlan(['.quality.json'], { gatedBaseSha: undefined })).full).toBe(true);
    });

    it('never scopes a run that is not forced full', () => {
      expect(isGeneratedSnapshotPush({ forceFull: false, gatedBaseSha: GREEN, predecessorGreenSha: GREEN,
        gatedChangedFiles: ['.quality.json'] })).toBe(false);
    });
  });

});

it('selects live restore for DB risks and its real closure, separately from general DB dependencies', () => {
  const inputs = realTree();
  const planFor = (source) => githubPlanOutput(buildCiTestPlan([source], inputs));
  for (const source of ['scripts/rehearsal-scratch-db.js', 'scripts/lib/migrationFiles.js', 'server/lib/databaseMaintenanceSchema.js',
    'server/services/backupDatabaseDump.js', 'server/services/backupDatabaseDump.restore.live.test.js', 'scripts/lib/dbImage.js',
    'server/scripts/init-db.sql', 'server/services/backupDatabaseReset.js']) {
    expect(planFor(source), source).toMatchObject({ full: false, db: true, db_live_restore: true });
  }
  expect(planFor('docker-compose.yml')).toMatchObject({ full: true, db: true, db_live_restore: true });
  expect(planFor('server/services/catalog/catalogSync.js')).toMatchObject({ full: false, db: true, db_live_restore: false });
  expect(planFor('docs/README.md')).toMatchObject({ db: false, db_live_restore: false });
  expect(githubPlanOutput(buildCiTestPlan([], { forceFull: true }))).toMatchObject({ full: true, db: true, db_live_restore: true });
});

it('runs the shipped prompt-hash guard on every plan', () => {
  expect(existsSync(join(REPO_ROOT, 'server/test/guards/repo/shippedPromptHashes.test.js'))).toBe(true);
  expect(getAlwaysRunTests()).toContain('server/test/guards/repo.guard.test.js');
});

describe('workspace-scoped featureDirectory matching (#17895)', () => {
  it('plans DocumentTemplateCanvas.jsx on the real tree with only documentTemplateParity and always-run server guards', () => {
    const source = 'client/src/components/musicVideo/DocumentTemplateCanvas.jsx';
    const paritySuite = 'server/services/musicVideo/documentTemplateParity.browser.test.js';
    const inputs = realTree();
    const plan = buildCiTestPlan([source], inputs);
    const expectedServerFiles = [
      paritySuite,
      ...splitByRunner(getAlwaysRunTests(inputs.trackedFiles)).server,
    ].sort();

    expect(plan).toMatchObject({
      full: false,
      db: false,
      build: true,
      smoke: false,
      browserFiles: [paritySuite],
      client: { mode: 'related', sources: [source] },
      server: { mode: 'files', files: expectedServerFiles, sources: [] },
    });
  });

  it('plans server/services/catalog/catalogSync.js on the real tree with client_mode skip', () => {
    const source = 'server/services/catalog/catalogSync.js';
    const plan = buildCiTestPlan([source], realTree());

    expect(plan).toMatchObject({
      full: false,
      db: true,
      build: false,
      smoke: true,
      client: { mode: 'skip', files: [], sources: [] },
    });
    expect(githubPlanOutput(plan).client_mode).toBe('skip');
  });
});

it('keeps real native launch, prompt, ownership and filesystem proof in the registry', () => {
  expect(WINDOWS_CONTRACT_TESTS).toEqual(expect.arrayContaining([
    'server/lib/cliProviderRun.test.js', 'server/lib/detachedSpawn.test.js',
    'server/services/shell.windows.test.js', 'server/services/tuiPromptRunner.test.js',
    'server/lib/execGit.test.js', 'server/lib/windowsGitProcess.test.js', 'server/lib/windowsGitProcess.protocol.test.js',
    'server/lib/windowsAgentProcess.test.js',
    'server/lib/gitRepositoryIdentity.test.js',
    'server/lib/nativeTrash.smoke.test.js',
  ]));
  const repo = fileURLToPath(new URL('../', import.meta.url));
  expect(WINDOWS_CONTRACT_TESTS.every(path => existsSync(join(repo, path)))).toBe(true);
});
