import { describe, expect, it, vi } from 'vitest';
import { emitGitHubPlan, githubPlanOutput, FULL_SUITE_SHARDS, shardIndexes } from './ciPlanOutput.js';
import { TRACKED } from '../fixtures/ciPlanTrackedFiles.js';
import { buildCiTestPlan, forceFullReasonFor, needsSlashdoSubmodule } from '../ci-test-plan.js';
import {
  getAlwaysRunTests,
  isRouteOnlyAppDiff,
  SLASHDO_GITLINK_PATH,
  sourceReferencePattern,
  splitByRunner,
  structuralTestsFor,
  WINDOWS_CONTRACT_TESTS,
} from './ciPlanRules.js';

it('selects checkout-cache contracts only in their installed-dependency runners', () => {
  const serverContract = 'scripts/workspaceCaches.test.js';
  const clientContract = 'client/src/test/workspaceCaches.test.js';
  const shared = [
    '.github/workflows/ci.yml', '.github/actions/setup-server/action.yml', 'package.json', 'scripts/lib/workspaceCacheFixture.js',
    'scripts/lib/vitestTempRootFixture.js', 'scripts/lib/vitestTempRoot.js',
    'scripts/lib/vitestWatch.js', 'scripts/lib/testOwnedProcesses.js', 'scripts/lib/darwinTestProcesses.py',
    'scripts/lib/vitestStaleRunRoots.js', 'scripts/lib/dbTestFiles.js', 'scripts/lib/workspaceTests.js',
    'scripts/vitestCiPool.js', 'scripts/vitestTempRootSetup.js', 'server/lib/killWithEscalation.js',
    'server/lib/mockPathsDataRoot.js',
  ];
  const server = [
    'server/package.json', 'server/package-lock.json',
    'server/vitest.config.js', 'server/vitest.config.db.js', 'server/vitest.setup.js',
    'server/test/admissionSetup.js', 'server/test/mediaRegistryEnvironment.js',
  ];
  const client = [
    'ecosystem.config.cjs', 'client/package.json', 'client/package-lock.json',
    'client/vite.config.js', 'lib/viteBuildEnv.js', 'client/vite.chunkGroups.js',
    'client/vitest.config.js', 'client/src/test/timeouts.js',
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
  for (const input of ['CONTRIBUTING.md', 'server/services/auth.js']) {
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

describe('CI test impact planner', () => {
  it('selects executable documentation tests, including contracts outside the always-run list', () => {
    const paths = ['docs/features/example-contract.test.js', 'docs/example.test.js'];
    const plan = buildCiTestPlan(paths, { trackedFiles: [...TRACKED, ...paths] });

    expect(plan.full).toBe(false);
    expect(plan.server.mode).toBe('files');
    expect(plan.server.files).toEqual(expect.arrayContaining(paths));
    expect(plan.client.mode).toBe('skip');
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
      'server/test/guards/repo.guard.test.js',
      'client/src/test/guards/a11y.guard.test.js',
    ])).toEqual({
      server: ['server/services/taskPromptDefaults.test.js', 'server/test/guards/repo.guard.test.js'],
      client: ['client/src/test/guards/a11y.guard.test.js'],
    });
  });

  // Every guard on the list is unreachable by import-graph selection, so a
  // docs-only plan is the one scope where the complete list has to survive.
  it('carries every tracked always-run guard on a docs-only plan', () => {
    const tracked = [...TRACKED, ...getAlwaysRunTests()];
    const plan = buildCiTestPlan(['docs/GITHUB_ACTIONS.md'], { trackedFiles: tracked });
    const { server, client } = splitByRunner(getAlwaysRunTests());

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
    // entry on getAlwaysRunTests() would then vanish from both jobs and the
    // docs-only plan would report green having run it nowhere.
    for (const path of getAlwaysRunTests()) {
      const { server, client } = splitByRunner([path]);
      expect(server.includes(path) || client.includes(path), path).toBe(true);
    }
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
      'server/lib/schemaVersions.js',
      // The client lint configuration. Both of these carry real enforced rules —
      // the .grit plugins include the crypto.randomUUID ban — so a change to
      // either must widen CI the same way the former eslint.config.js did. This
      // trigger went untested when it pointed at eslint.config.js, so the rename
      // to biome.jsonc could have silently matched nothing.
      'client/biome.jsonc',
      'biome.jsonc',
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

  // #17460: routine version bumps edit a domain slice, never the composer above.
  it('scopes a schema-version domain slice to its related suites and the registry contract test', () => {
    const slice = 'server/lib/schemaVersions/music.js';
    const contract = 'server/lib/schemaVersions.test.js';
    const plan = buildCiTestPlan([slice], {
      trackedFiles: [...TRACKED, slice, contract],
      // collectPlanInputs finds the contract test because it names the slice's basename.
      pathContractTests: { [slice]: [contract] },
    });

    expect(plan.full).toBe(false);
    expect(plan.server.mode).toBe('related');
    expect(plan.server.sources).toEqual([slice]);
    expect(plan.server.files).toContain(contract);
    expect(plan.client.mode).toBe('skip');
    expect(plan.windowsMode).toBe('skip');
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

  // One row per structural trigger in structuralTestsFor. Each diff pairs the
  // trigger with an unrelated path, so a rule that only fires when every changed
  // file matches (`.some` → `.every`) drops its guard and fails here.
  it('selects API route parity when operator tooling changes', () => {
    const changed = 'scripts/portos-acp.js';
    const guard = 'server/lib/apiRouteParity.test.js';
    const plan = buildCiTestPlan([changed], { trackedFiles: [...TRACKED, changed, guard] });
    expect(plan.full).toBe(false);
    expect(plan.server.files).toContain(guard);
  });

  const STRUCTURAL_GUARD_ROWS = [
    { changed: 'server/sockets/chat.js', runner: 'server', guards: ['server/sockets/asyncHandlerGuard.test.js'] },
    { changed: 'server/lib/bufferedSpawn.js', runner: 'server', guards: ['server/lib/moduleSummaries.test.js'] },
    { changed: 'server/lib/agent/agentOutcome.js', runner: 'server', guards: ['server/lib/agent/moduleSummaries.test.js'] },
    { changed: 'server/lib/cos/cosValidation.js', runner: 'server', guards: ['server/lib/cos/moduleSummaries.test.js'] },
    { changed: 'server/lib/catalog/catalogValidation.js', runner: 'server', guards: ['server/lib/catalog/moduleSummaries.test.js'] },
    { changed: 'server/lib/persistent/persistentMindCapabilities.js', runner: 'server', guards: ['server/lib/persistent/moduleSummaries.test.js'] },
    { changed: 'server/lib/provider/providerModels.js', runner: 'server', guards: ['server/lib/provider/moduleSummaries.test.js'] },
    { changed: 'server/routes/sprites.js', runner: 'server', guards: ['server/test/guards/modules.guard.test.js', 'server/lib/apiRouteParity.test.js', 'scripts/generate-prompt-stage-call-sites.test.js'] },
    { changed: 'server/scripts/init-db.sql', runner: 'server', guards: ['server/lib/db.ddlParity.test.js'] },
    { changed: 'server/scripts/init-db.base.sql', runner: 'server', guards: ['server/lib/db.ddlParity.test.js'] },
    { changed: 'client/src/lib/catalogLinks.js', runner: 'client', guards: ['client/src/lib/moduleSummaries.test.js'] },
    { changed: 'client/src/hooks/useAsyncAction.js', runner: 'client', guards: ['client/src/hooks/moduleSummaries.test.js'] },
    { changed: 'client/src/utils/formatters.js', runner: 'client', guards: ['client/src/utils/moduleSummaries.test.js'] },
    { changed: 'client/src/services/apiSprites.js', runner: 'client', guards: ['client/src/services/moduleSummaries.test.js'] },
    { changed: 'client/src/components/catalog/CatalogCard.jsx', runner: 'client', guards: ['client/src/test/guards/a11y.guard.test.js', 'client/src/test/guards/ui.guard.test.js'] },
  ];
  it.each(STRUCTURAL_GUARD_ROWS)('schedules the structural guards for $changed in a mixed diff', ({ changed, runner, guards }) => {
    const trackedFiles = [...TRACKED, changed, ...STRUCTURAL_GUARD_ROWS.flatMap((row) => row.guards)];
    const plan = buildCiTestPlan([changed, 'server/services/auth.js'], { trackedFiles });

    expect(plan.full).toBe(false);
    for (const guard of guards) {
      expect(plan[runner].files, guard).toContain(guard);
    }
  });

  // update.* and the lockfiles already force a full CI plan, so the planner
  // row above can't show it; pregate's downgraded plan relies on this rule.
  it.each(['update.sh', 'update.ps1', 'scripts/update.mjs', 'scripts/ensure-deps.js', 'server/package-lock.json'])('selects the ensure-deps contract for %s', (changed) => {
    expect(structuralTestsFor([changed, 'docs/README.md'], new Set(['scripts/ensure-deps.test.js']))).toContain('scripts/ensure-deps.test.js');
    expect(structuralTestsFor(['docs/README.md'], new Set(['scripts/ensure-deps.test.js']))).not.toContain('scripts/ensure-deps.test.js');
  });

  it('selects lint when scripts, lib, or autofixer changes, and skips slashdo and dependency trees', () => {
    const extra = [
      'scripts/lib/directInvocation.js',
      'scripts/backupDbCaseBoundary.test.js',
      'lib/portosAuthCore.js',
      'autofixer/server.js',
      'lib/slashdo/lib/example.js',
      'scripts/node_modules/pkg/index.js',
      'autofixer/node_modules/pkg/index.js',
    ];
    const trackedFiles = [...TRACKED, ...extra];
    for (const path of extra.slice(0, 4)) {
      const plan = buildCiTestPlan([path], { trackedFiles });
      expect(plan.lint.mode, path).toBe('files');
      expect(plan.lint.files, path).toContain(path);
    }
    for (const path of extra.slice(4)) {
      const plan = buildCiTestPlan([path], { trackedFiles });
      expect(plan.lint.mode, path).toBe('skip');
      expect(plan.lint.files, path).toEqual([]);
    }
  });

  it('runs the full lint job, with actionlint over every workflow, for any workflow change', () => {
    // `.github/workflows/` escalates to the full plan, so the lint job lints every workflow file.
    const plan = buildCiTestPlan(['.github/workflows/release.yml'], { trackedFiles: [...TRACKED, '.github/workflows/release.yml'] });
    expect(plan.full).toBe(true);
    expect(plan.lint).toEqual({ mode: 'full', files: [] });
  });

  it('does not treat a source .grit or a mistyped biome.json as lint configuration', () => {
    // Guards the trigger regex against over-matching: only the client's top-level
    // config and its sibling .grit plugins should force a full run.
    for (const path of ['client/src/foo.grit', 'client/biome.json', 'clientx/biome.jsonc']) {
      const plan = buildCiTestPlan([path], { trackedFiles: TRACKED });
      expect(plan.reason, path).not.toMatch(/lint configuration changed/);
    }
  });

  it('scopes feature-directory matching to its own workspace without pulling unrelated or cross-workspace tests (#17895)', () => {
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
      client: { mode: 'skip', files: [], sources: [] },
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
    expect(plan.server.files).not.toContain('server/services/auth.test.js');
    expect(plan.client.files).toEqual([]);
  });

  describe('workspace-scoped featureDirectory matching (#17895)', () => {
    it('keeps a client-only feature edit out of server, DB and unrelated browser suites while preserving pathContractTests', () => {
      const source = 'client/src/components/musicVideo/DocumentTemplateCanvas.jsx';
      const paritySuite = 'server/services/musicVideo/documentTemplateParity.browser.test.js';
      const unrelatedServer = 'server/services/musicVideo/projects.test.js';
      const unrelatedDb = 'server/services/musicVideo/projects.db.test.js';
      const unrelatedBrowser = 'server/services/musicVideo/documentRender.browser.test.js';
      const clientFeatureTest = 'client/src/components/musicVideo/DocumentTemplateCanvas.test.jsx';
      const trackedFiles = [...TRACKED, source, clientFeatureTest, paritySuite, unrelatedServer, unrelatedDb, unrelatedBrowser];

      const plan = buildCiTestPlan([source], {
        trackedFiles,
        pathContractTests: { [source]: [clientFeatureTest, paritySuite] },
      });

      expect(plan).toMatchObject({
        full: false,
        db: false,
        build: true,
        smoke: false,
        browserFiles: [paritySuite],
        client: { mode: 'related', sources: [source] },
        server: { mode: 'files', sources: [] },
      });
      expect(plan.client.files).toContain(clientFeatureTest);
      expect(plan.server.files).toEqual([paritySuite, 'server/services/taskPromptDefaults.test.js']);
      expect(plan.server.files).not.toContain(unrelatedServer);
      expect(plan.server.files).not.toContain(unrelatedBrowser);
    });

    it('keeps a server-only feature edit from selecting client feature or singular-name tests', () => {
      const appRoute = 'server/routes/apps/crud.js';
      const appServerTest = 'server/routes/apps/crud.test.js';
      const trackedFiles = [...TRACKED, appRoute, appServerTest];

      const plan = buildCiTestPlan([appRoute], { trackedFiles });
      expect(plan).toMatchObject({
        full: false,
        build: false,
        smoke: true,
        client: { mode: 'skip', files: [], sources: [] },
        server: { mode: 'related', sources: [appRoute] },
      });
      expect(plan.server.files).toContain(appServerTest);
      expect(plan.client.files).not.toContain('client/src/App.test.jsx');
      expect(githubPlanOutput(plan).client_mode).toBe('skip');
    });

    it('retains cross-workspace selection through clientDependencies, clientTestDependencies and pathContractTests', () => {
      const sharedLib = 'server/lib/sprites/sharedGeometry.js';
      const serverFeatureTest = 'server/routes/sprites.test.js';
      const clientFeatureTest = 'client/src/components/sprites/WalkWorkflow.test.jsx';
      const clientApiTest = 'client/src/services/apiSprites.test.js';
      const clientConsumerTest = 'client/src/components/catalog/CatalogCard.test.jsx';
      const trackedFiles = [...TRACKED, sharedLib];

      // Imported by client production code (clientDependencies): sharedLib is a client source too.
      const sharedPlan = buildCiTestPlan([sharedLib], {
        trackedFiles,
        clientDependencies: [sharedLib],
      });
      expect(sharedPlan).toMatchObject({
        full: false,
        build: true,
        server: { mode: 'related', sources: [sharedLib] },
        client: { mode: 'related', sources: [sharedLib] },
      });
      expect(sharedPlan.server.files).toContain(serverFeatureTest);
      expect(sharedPlan.client.files).toEqual(expect.arrayContaining([clientFeatureTest, clientApiTest]));

      // Imported only by a client test fixture (clientTestDependencies): runs only that consumer, not client feature tests.
      const testDepPlan = buildCiTestPlan([sharedLib], {
        trackedFiles,
        clientDependencies: [],
        clientTestDependencies: { [clientConsumerTest]: [sharedLib] },
      });
      expect(testDepPlan).toMatchObject({
        full: false,
        build: false,
        client: { mode: 'files', files: [clientConsumerTest], sources: [] },
      });

      // Explicit basename contract (pathContractTests): selects only the named client test.
      const contractPlan = buildCiTestPlan([sharedLib], {
        trackedFiles,
        clientDependencies: [],
        pathContractTests: { [sharedLib]: [clientApiTest] },
      });
      expect(contractPlan).toMatchObject({
        full: false,
        build: false,
        client: { mode: 'files', files: [clientApiTest], sources: [] },
      });
    });

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
    expect(plan.client.files).toContain('client/src/lib/moduleSummaries.test.js');
    expect(plan.client.files).toContain('client/src/test/guards/a11y.guard.test.js');
    expect(plan.client.files).toContain('client/src/test/guards/ui.guard.test.js');
    expect(plan.lint).toEqual({
      mode: 'files',
      files: [
        'client/src/components/catalog/CatalogCard.jsx',
        'client/src/lib/catalogLinks.js',
      ],
    });
    expect(plan.build).toBe(true);
  });

  it('selects the client guard runners for a plain-.js client change', () => {
    // The StrictMode mounted-ref bug reached 94 call sites through a `.js` hook, so
    // the runner holding that check must be selected by a change that touches no `.jsx`.
    const plan = buildCiTestPlan(['client/src/hooks/useAsyncAction.js'], { trackedFiles: TRACKED });

    expect(plan.client.files).toContain('client/src/test/guards/ui.guard.test.js');
    expect(plan.client.files).toContain('client/src/test/guards/a11y.guard.test.js');
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
      'scripts/ml/generate_ltx2.py',
      'scripts/ml/_runner_common.py',
      'scripts/ml/generate_ltx2.test.js',
      'server/services/videoGen/runtimes.test.js',
      'client/src/lib/videoRenderPhase.test.js',
    ];
    const pathContractTests = {
      'scripts/ml/_runner_common.py': [
        'scripts/ml/generate_ltx2.test.js',
        'server/services/videoGen/runtimes.test.js',
        'client/src/lib/videoRenderPhase.test.js',
        'server/lib/deleted.test.js',
      ],
    };

    const plan = buildCiTestPlan(['scripts/ml/_runner_common.py'], { trackedFiles: tracked, pathContractTests });

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
      'scripts/ml/generate_ltx2.test.js',
      'server/services/videoGen/runtimes.test.js',
      'server/services/taskPromptDefaults.test.js',
    ]));
    expect(plan.server.files).not.toContain('server/lib/deleted.test.js');
    expect(plan.client.files).toEqual(['client/src/lib/videoRenderPhase.test.js']);

    // A JS source in the same diff keeps its own import-graph selection; the
    // python contracts ride along as explicit files.
    const mixed = buildCiTestPlan(['scripts/ml/_runner_common.py', 'server/services/auth.js'], {
      trackedFiles: tracked,
      pathContractTests,
    });
    expect(mixed.reason).toBe('Vitest related-test fallback');
    expect(mixed.server).toMatchObject({ mode: 'related', sources: ['server/services/auth.js'] });
    expect(mixed.server.files).toContain('scripts/ml/generate_ltx2.test.js');
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
    it('selects the snapshot verifier test for its script, pins and signed fixtures', () => {
      const owner = 'server/lib/superColliderSnapshot.test.js';
      const inputs = [
        'docker/supercollider/verify-snapshot.sh',
        'docker/supercollider/debian-inrelease.sha256',
        'server/test/fixtures/supercollider-snapshot/older-trixie-updates.InRelease',
      ];
      for (const input of inputs) {
        const plan = buildCiTestPlan([input], { trackedFiles: [...TRACKED, owner, ...inputs] });
        expect(plan.full, input).toBe(false);
        expect(plan.server.files, input).toContain(owner);
      }
    });

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

    it('selects installer and route contracts for the TRELLIS.2 shell and wheel locks', () => {
      const inputs = [
        'scripts/setup-trellis2-mps.sh',
        'scripts/ml/requirements/requirements-trellis2-mps.txt',
        'scripts/ml/requirements/requirements-trellis2-mps.lock.txt',
      ];
      const owners = ['scripts/ml/setup-trellis2-mps.test.js', 'server/routes/imageTo3d.test.js'];
      for (const input of inputs) {
        const plan = buildCiTestPlan([input], { trackedFiles: [...TRACKED, ...inputs, ...owners] });
        expect(plan.full, input).toBe(false);
        expect(plan.server.files, input).toEqual(expect.arrayContaining(owners));
      }
    });

    it('scopes a requirements-pin change to the installer contract', () => {
      const requirements = [
        'scripts/ml/requirements/requirements-ltx25-cuda.txt',
        'scripts/ml/requirements/requirements-ltx25-cuda-windows.lock.txt',
        'scripts/ml/requirements/requirements-ltx25-cuda-linux.lock.txt',
        'scripts/ml/requirements/requirements-ltx25-cuda-build.lock.txt',
        'scripts/ml/requirements/requirements-flux3-mlx.lock.txt',
        'scripts/ml/requirements/requirements-minimax-h3-cuda.txt',
        'scripts/ml/requirements/requirements-minimax-h3-cuda-windows.lock.txt',
        'scripts/ml/requirements/requirements-minimax-h3-cuda-linux.lock.txt',
        'scripts/ml/requirements/requirements-minimax-h3-mlx.lock.txt',
        'scripts/ml/requirements/requirements-minimax-music3-mlx.lock.txt',
        'scripts/ml/requirements/requirements-minimax-music3-cuda.txt',
        'scripts/ml/requirements/requirements-minimax-music3-cuda-windows.lock.txt',
        'scripts/ml/requirements/requirements-minimax-music3-cuda-linux.lock.txt',
        'scripts/ml/requirements/requirements-musicgen-mlx.lock.txt',
        'scripts/ml/requirements/requirements-audioldm2-mlx.lock.txt',
        'scripts/ml/requirements/requirements-audioldm2-cuda.txt',
        'scripts/ml/requirements/requirements-audioldm2-cuda-windows.lock.txt',
        'scripts/ml/requirements/requirements-audioldm2-cuda-linux.lock.txt',
        'scripts/ml/requirements/requirements-acestep-mlx.lock.txt',
        'scripts/ml/requirements/requirements-acestep-cuda.txt',
        'scripts/ml/requirements/requirements-acestep-cuda-windows.lock.txt',
        'scripts/ml/requirements/requirements-acestep-cuda-linux.lock.txt',
        'scripts/ml/requirements/requirements-acestep15-mlx.lock.txt',
        'scripts/ml/requirements/requirements-acestep15-cuda.txt',
        'scripts/ml/requirements/requirements-acestep15-cuda-windows.lock.txt',
        'scripts/ml/requirements/requirements-acestep15-cuda-linux.lock.txt',
        'scripts/ml/requirements/requirements-flux2-mlx.lock.txt',
        'scripts/ml/requirements/requirements-flux2-cuda.txt',
        'scripts/ml/requirements/requirements-flux2-cuda-windows.lock.txt',
        'scripts/ml/requirements/requirements-flux2-cuda-linux.lock.txt',
        'scripts/ml/requirements/requirements-fastvideo-mlx.lock.txt',
        'scripts/ml/requirements/requirements-muscriptor-mlx.lock.txt',
        'scripts/ml/requirements/requirements-muscriptor-cuda.txt',
        'scripts/ml/requirements/requirements-muscriptor-cuda-windows.lock.txt',
        'scripts/ml/requirements/requirements-muscriptor-cuda-linux.lock.txt',
        'scripts/ml/requirements/requirements-mflux-mlx.lock.txt',
        'scripts/ml/requirements/requirements-wan22-cuda.txt',
        'scripts/ml/requirements/requirements-lyric-align.txt',
        'scripts/ml/requirements/requirements-lyric-align.lock.txt',
      ];
      const owners = [
        'scripts/setup-image-video.test.js',
        'server/lib/pythonSetup.install.test.js',
        'server/lib/pythonSetup.test.js',
        'server/services/imageGen/flux3Runtime.test.js',
        'server/services/musicVideo/lyricForcedAlign.test.js',
        'server/services/videoGen/runtimes.test.js',
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

  describe('server-owned data.reference JSON seeds (#18220)', () => {
    it('scopes data.reference/providers.json to server provider contracts + smoke without client/browser/build/windows', () => {
      const providerTests = [
        'scripts/generate-provider-samples.test.js',
        'server/cos-runner/allowedCommands.test.js',
        'server/lib/aiToolkit/defaults/providersSeedParity.test.js',
        'server/services/provider/providers.shape.test.js',
        'server/services/provider/providerPresets.test.js',
        'server/services/provider/providerReadiness.test.js',
      ];
      const seed = 'data.reference/providers.json';
      const trackedFiles = [...TRACKED, seed, ...providerTests];

      const plan = buildCiTestPlan([seed], { trackedFiles });

      expect(plan.full).toBe(false);
      expect(plan.reason).toBe('server seed contracts');
      expect(plan.server.mode).toBe('files');
      expect(plan.server.files).toEqual(expect.arrayContaining([
        ...providerTests,
        'server/services/taskPromptDefaults.test.js',
      ]));
      expect(plan.client).toMatchObject({ mode: 'skip', files: [], sources: [] });
      expect(plan.browserFiles).toEqual([]);
      expect(plan.build).toBe(false);
      expect(plan.smoke).toBe(true);
      expect(plan.db).toBe(false);
      expect(plan.windows).toBe(false);
    });

    it('scopes data.reference/prompts/*.json seeds to server prompt contract tests + pathContractTests + smoke', () => {
      const promptTests = [
        'scripts/migrations/shippedPromptHashes.test.js',
        'scripts/regen-shipped-prompt-hashes.test.js',
        'server/lib/promptSystemStages.test.js',
      ];
      const pathHit = 'server/routes/prompts.test.js';
      const seeds = [
        'data.reference/prompts/stage-config.json',
        'data.reference/prompts/shipped-hashes.json',
      ];
      const trackedFiles = [...TRACKED, ...seeds, ...promptTests, pathHit];

      for (const seed of seeds) {
        const plan = buildCiTestPlan([seed], {
          trackedFiles,
          pathContractTests: { [seed]: [pathHit] },
        });
        expect(plan.full, seed).toBe(false);
        expect(plan.server.mode, seed).toBe('files');
        expect(plan.server.files, seed).toEqual(expect.arrayContaining([
          'server/services/taskPromptDefaults.test.js',
          'scripts/migrations/shippedPromptHashes.test.js',
          pathHit,
        ]));
        expect(plan.client.mode, seed).toBe('skip');
        expect(plan.build, seed).toBe(false);
        expect(plan.browserFiles, seed).toEqual([]);
        expect(plan.windows, seed).toBe(false);
        expect(plan.smoke, seed).toBe(true);
      }
    });

    it('scopes other data.reference/**/*.json seeds via pathContractTests + smoke and still fails closed for unknown non-JSON files', () => {
      const seed = 'data.reference/settings.json';
      const hit = 'scripts/lib/mergeJsonStarter.test.js';
      const scoped = buildCiTestPlan([seed], {
        trackedFiles: [...TRACKED, seed, hit],
        pathContractTests: { [seed]: [hit] },
      });
      expect(scoped.full).toBe(false);
      expect(scoped.server.files).toContain(hit);
      expect(scoped.smoke).toBe(true);
      expect(scoped.client.mode).toBe('skip');
      expect(scoped.build).toBe(false);
      expect(scoped.windows).toBe(false);

      const unknownBinary = buildCiTestPlan(['data.reference/unknown.bin'], { trackedFiles: TRACKED });
      expect(unknownBinary.full).toBe(true);
      expect(unknownBinary.reason).toMatch(/unclassified changed file: data\.reference\/unknown\.bin/);

      const unknownCode = buildCiTestPlan(['data.reference/unexpected.js'], { trackedFiles: [...TRACKED, 'data.reference/unexpected.js'] });
      expect(unknownCode.full).toBe(true);
      expect(unknownCode.reason).toMatch(/unmapped executable surface: data\.reference\/unexpected\.js/);

      const outsideSeed = buildCiTestPlan(['unmapped/config.json'], { trackedFiles: [...TRACKED, 'unmapped/config.json'] });
      expect(outsideSeed.full).toBe(true);
      expect(outsideSeed.reason).toMatch(/unmapped executable surface: unmapped\/config\.json/);
    });
  });

  it('runs the tree-scanning route and prompt-stage guards whenever a server source or client API wrapper changes', () => {
    const treeGuards = [
      'server/test/guards/modules.guard.test.js',
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
    const apiWrapper = buildCiTestPlan(['client/src/services/apiNewRoute.js'], {
      trackedFiles: [...tracked, 'client/src/services/apiNewRoute.js'],
    });
    expect(apiWrapper.server.files).toContain('server/lib/apiRouteParity.test.js');
  });

  it('fails closed to the full suite for a python script nothing pins', () => {
    // Per script: a pinned sibling in the same diff does not vouch for the orphan.
    const plan = buildCiTestPlan(['scripts/ml/generate_ltx2.py', 'scripts/orphan.py'], {
      trackedFiles: [...TRACKED, 'scripts/ml/generate_ltx2.py', 'scripts/orphan.py', 'scripts/ml/generate_ltx2.test.js'],
      pathContractTests: { 'scripts/ml/generate_ltx2.py': ['scripts/ml/generate_ltx2.test.js'] },
    });
    expect(plan.full).toBe(true);
    expect(plan.reason).toMatch(/python script with no parsing contract: scripts\/orphan\.py/);
    // A python file outside scripts/ is still an unclassified artifact.
    const nested = buildCiTestPlan(['server/tools/helper.py'], { trackedFiles: TRACKED });
    expect(nested.reason).toMatch(/unclassified/);
  });

  it('matches the way tests name one python script, not every one', () => {
    const re = new RegExp(sourceReferencePattern('scripts/ml/generate_ltx2.py'));
    expect(re.test("join(SCRIPTS, 'generate_ltx2.py')")).toBe(true);
    expect(re.test('readFileSync("scripts/ml/generate_ltx2.py", "utf8")')).toBe(true);
    expect(re.test('"generate_ltx2.py"')).toBe(true);
    expect(re.test("'generate_ltx2_cuda.py'")).toBe(false);
    expect(re.test("'my_generate_ltx2.py'")).toBe(false);
    expect(re.test("'generate_ltx2.pyc'")).toBe(false);
    expect(re.test("'generate_ltx2xpy'")).toBe(false);
  });

  it('never selects a model-capability fixture sandbox as a suite on a feature-name match', () => {
    const source = 'client/src/components/models/Panel.jsx';
    const fixture = 'server/fixtures/model-tests/sandbox/cart-totals/cart-totals.test.mjs';
    const real = 'client/src/components/models/Panel.test.jsx';
    const plan = buildCiTestPlan([source], { trackedFiles: [...TRACKED, source, real, fixture] });
    expect(plan.client.files).toContain(real);
    expect(plan.server.files).not.toContain(fixture);
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
      'scripts/lib/ciPlanRules.js',
      'scripts/lib/ciPlanOutput.js',
      'scripts/lib/moduleGraph.test.js',
      'scripts/lib/moduleGraph.js',
      'scripts/run-ci-tests.js',
      'scripts/lib/ciNpmRunner.js',
      'scripts/lib/ciTestDiagnosticsFormat.js',
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
      'scripts/lib/ciNpmRunner.js',
      'scripts/lib/ciTestDiagnosticsFormat.js',
      'scripts/run-ci-tests.test.js',
      'scripts/ci-test-plan.js',
      'scripts/ci-test-plan.test.js',
      // run-ci-tests.js loads the planner's rules on windows-latest.
      'scripts/lib/ciPlanRules.js',
      'scripts/lib/ciPlanDependencies.js',
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
    // ci.yml's composite actions are part of its job definitions, windows-server's included.
    for (const path of ['.github/actions/setup-server/action.yml', '.github/actions/test-memo/action.yml']) {
      expect(windowsModeOf(path), path).toBe('files');
      expect(buildCiTestPlan([path], { trackedFiles: TRACKED }).full, path).toBe(true);
    }
    // Any matching trigger still wins: ci.yml next to a Linux-only script escalates.
    expect(windowsModeOf('.github/workflows/ci.yml')).toBe('files');
    expect(buildCiTestPlan(['scripts/ci-test-plan.js', '.github/workflows/ci.yml'], { trackedFiles: TRACKED }).windowsMode).toBe('files');
  });

  it.each(['server/services/worktreeManager.js', 'server/services/worktree/create.js'])(
    'routes %s to a full plan instead of a broad nominal scoped plan (#9999)',
    (path) => {
      const plan = buildCiTestPlan([path], { trackedFiles: TRACKED });
      expect(plan.full).toBe(true);
      expect(plan.reason).toMatch(/worktree manager source changed/);
      expect(plan.server.mode).toBe('full');
      expect(plan.client.mode).toBe('full');
      expect(plan.windowsMode).toBe('files');
    },
  );

  it('keeps the worktree manager facade test on a scoped plan', () => {
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
      browser: [1],
      windows: shardIndexes('full', FULL_SUITE_SHARDS.windows),
    });

    const nearbySocket = buildCiTestPlan(['server/sockets/apps.js'], { trackedFiles });
    expect(nearbySocket.full).toBe(false);
    expect(nearbySocket.server.mode).toBe('related');
    expect(nearbySocket.shards).toEqual({ server: [1], client: [1], browser: [1], windows: [1] });
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

  it.each(['update.sh', 'update.ps1', 'scripts/update.mjs', 'scripts/deferred-update.mjs', 'scripts/update-headless-recovery.test.js'])('runs the real PowerShell failure-settlement contract for %s', source => {
    const contract = 'scripts/update-headless-recovery.test.js';
    const plan = buildCiTestPlan([source], { trackedFiles: [...TRACKED, source, contract] });
    expect(plan.windows).toBe(true);
    expect(plan.windowsFiles).toContain(contract);
  });

  it('runs the native release pre-flight contract on Windows', () => {
    const source = 'server/services/releasePreflight.js';
    const contract = 'server/services/releasePreflight.test.js';
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
    'scripts/update-submodules.test.js',
    'server/lib/bufferedSpawn.js',
    'server/lib/windowsGitSupervisor.cs',
    'server/lib/windowsAgentSupervisor.cs',
    'server/lib/windowsAgentProcess.js',
    'server/lib/aiToolkit/internal/windowsSafeSpawn.js',
    'server/lib/gitRepositoryIdentity.js',
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
