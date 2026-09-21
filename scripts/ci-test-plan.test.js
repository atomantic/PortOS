import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALWAYS_RUN_TESTS,
  buildCiTestPlan,
  collectPlanInputs,
  forceFullReasonFor,
  FULL_SUITE_SHARDS,
  isRouteOnlyAppDiff,
  needsSlashdoSubmodule,
  shardIndexes,
  SLASHDO_GITLINK_PATH,
  sourceReferencePattern,
  splitByRunner,
  WINDOWS_CONTRACT_TESTS,
  WINDOWS_RISK_RULES,
} from './ci-test-plan.js';

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
    encoding: 'utf8',
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

describe('CI test impact planner', () => {
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
    expect(plan).toMatchObject({ full: true, db: true, smoke: true, windows: true });
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
      server: { mode: 'files' },
      client: { mode: 'files' },
      db: false,
      lint: { mode: 'skip' },
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
    expect(plan.server.mode).toBe('files');
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
    ], { trackedFiles: TRACKED.filter((path) => ![
      'server/services/sprites/atlas.test.js',
      'client/src/components/catalog/CatalogCard.test.jsx',
    ].includes(path)) });

    expect(plan.full).toBe(false);
    expect(plan.server.files).not.toContain('server/services/sprites/atlas.test.js');
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
      expect(plan.server.mode).toBe('files');
      expect(plan.server.sources).toEqual([]);
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

    it('keeps an independent lockfile full-CI trigger authoritative', () => {
      const plan = buildCiTestPlan([REVIEW_LOOP_SNAPSHOT, 'package-lock.json'], {
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
        windowsMode: 'full',
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

  it('fans a full plan out across the configured shards and leaves a scoped plan on one', () => {
    expect(shardIndexes('full', 3)).toEqual([1, 2, 3]);
    expect(shardIndexes('related', 3)).toEqual([1]);
    expect(shardIndexes('files', 3)).toEqual([1]);
    expect(shardIndexes('skip', 3)).toEqual([1]);
    for (const [runner, count] of Object.entries(FULL_SUITE_SHARDS)) {
      expect(count, runner).toBeGreaterThan(1);
    }

    const full = buildCiTestPlan(['server/vitest.config.js'], { trackedFiles: TRACKED });
    expect(full.shards).toEqual({
      server: shardIndexes('full', FULL_SUITE_SHARDS.server),
      client: shardIndexes('full', FULL_SUITE_SHARDS.client),
      windows: shardIndexes('full', FULL_SUITE_SHARDS.windows),
    });
    const scoped = buildCiTestPlan(['server/services/auth.js'], { trackedFiles: TRACKED });
    expect(scoped.shards).toEqual({ server: [1], client: [1], windows: [1] });
    const docsOnly = buildCiTestPlan(['docs/README.md'], { trackedFiles: TRACKED });
    expect(docsOnly.shards).toEqual({ server: [1], client: [1], windows: [1] });
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
    expect(spawn.windowsMode).toBe('related');
    expect(spawn.windowsSources).toEqual(['server/lib/bufferedSpawn.js']);
    expect(spawn.windowsFiles).toEqual([
      'server/lib/bufferedSpawn.test.js',
      'server/lib/platform.test.js',
      'server/lib/shellCd.test.js',
      'server/services/agentTuiSpawning.test.js',
    ]);

    const tuiShell = buildCiTestPlan([
      'server/lib/shellCd.js',
    ], { trackedFiles: TRACKED });
    expect(tuiShell.windows).toBe(true);
    expect(tuiShell.windowsMode).toBe('related');

    const winHelper = buildCiTestPlan([
      'scripts/fix-windows-console.js',
    ], { trackedFiles: TRACKED });
    expect(winHelper.full).toBe(false);
    expect(winHelper.windows).toBe(true);
  });

  it('keeps the complete Windows suite for an explicit full-CI request', () => {
    const plan = buildCiTestPlan(['server/lib/bufferedSpawn.js'], {
      trackedFiles: TRACKED,
      forceFull: true,
    });

    expect(plan.windowsMode).toBe('full');
    expect(plan.windowsFiles).toEqual([]);
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

  it('is true when a contract source file is selected', () => {
    expect(needsSlashdoSubmodule({
      ...basePlan,
      server: { files: [], sources: ['server/lib/slashdoInvocation.js'] },
    })).toBe(true);
  });
});

// windows-latest bills at GitHub's 2x minute multiplier, and three Windows
// shards were ~58% of a full run's billable minutes (24.9 of 40.4, measured
// over 11 real runs). These pin the rule that bought that back: a full plan
// escalates the Windows job to the complete server suite only when the diff
// gives windows-server something to prove. Everything else still runs the
// WINDOWS_CONTRACT_TESTS baseline — reduced, never skipped (issue #7440).
describe('Windows escalation on a full plan (#7440)', () => {
  // The contract baseline resolves against tracked files, so a downgrade is
  // only observable when the contract tests exist in the tree.
  const TRACKED_WITH_CONTRACTS = [...TRACKED, ...WINDOWS_CONTRACT_TESTS];
  const plan = (files, options = {}) => buildCiTestPlan(files, {
    trackedFiles: TRACKED_WITH_CONTRACTS,
    ...options,
  });

  it('runs the contract baseline for a full trigger windows-server cannot observe', () => {
    const downgraded = plan(['client/vite.config.js']);

    // Still a full plan for every Linux suite — only the 2x job narrows.
    expect(downgraded.full).toBe(true);
    expect(downgraded.server.mode).toBe('full');
    expect(downgraded.client.mode).toBe('full');
    expect(downgraded.shards.server).toEqual(shardIndexes('full', FULL_SUITE_SHARDS.server));

    // Reduced, not skipped: the job runs, on one shard, over the baseline.
    expect(downgraded.windows).toBe(true);
    expect(downgraded.windowsMode).toBe('files');
    expect(downgraded.shards.windows).toEqual([1]);
    expect(downgraded.windowsFiles).toEqual(WINDOWS_CONTRACT_TESTS);
    expect(downgraded.suiteReasons.windows).toContain('Windows contract baseline');
  });

  it('treats a capacity escalation as a scoping limit, not a Windows risk signal', () => {
    // A diff wide enough to blow MAX_CHANGED_CODE_FILES says the planner ran
    // out of scoping headroom. Nothing about it implicates Windows.
    const wide = plan(Array.from({ length: 31 }, (_, i) => `server/services/wide${i}.js`));

    expect(wide.full).toBe(true);
    expect(wide.reason).toContain('wide change');
    expect(wide.windowsMode).toBe('files');
    expect(wide.shards.windows).toEqual([1]);
  });

  it('escalates when ANY matching trigger is Windows-relevant, not just the reported one', () => {
    // The reason line reports the first match in sorted-path order, which here
    // is the client-only one. The Windows decision must still see server/index.js.
    const mixed = plan(['client/vite.config.js', 'server/index.js']);

    expect(mixed.reason).toContain('client/vite.config.js');
    expect(mixed.windowsMode).toBe('full');
    expect(mixed.shards.windows).toEqual(shardIndexes('full', FULL_SUITE_SHARDS.windows));
  });

  it('consults the trigger list from the App.jsx branch too', () => {
    // client/src/App.jsx returns before the trigger loop, so its branch has to
    // read the same OR — otherwise an App.jsx PR that also bumps a lockfile or
    // touches server/index.js downgrades Windows on a diff that must escalate.
    expect(plan(['client/src/App.jsx']).windowsMode).toBe('files');

    for (const escalating of ['server/index.js', 'package-lock.json', 'server/lib/validation.js']) {
      const combined = plan(['client/src/App.jsx', escalating]);
      expect(combined.reason, escalating).toContain('client composition root changed');
      expect(combined.windowsMode, escalating).toBe('full');
    }
  });

  it('escalates when a Windows-risk file rides along with a client-only trigger', () => {
    // .ps1 is not in EXECUTABLE_RE, so risk detection must read every changed
    // path, not only the executable ones.
    const withPowerShell = plan(['client/vite.config.js', 'scripts/deploy.ps1']);

    expect(withPowerShell.windowsMode).toBe('full');
    expect(withPowerShell.windowsFiles).toEqual([]);
  });

  it('keeps the complete matrix on the runs that carry the discovery net', () => {
    // Nightly, the main -> release PR, release, explicit full request. ci.yml
    // has no push trigger, so these are the whole discovery net for an
    // untagged Windows regression.
    const forced = plan([], { forceFull: true, forceFullReason: 'full CI requested' });

    expect(forced.windowsMode).toBe('full');
    expect(forced.shards.windows).toEqual(shardIndexes('full', FULL_SUITE_SHARDS.windows));
  });

  it('fails closed for a call site that passes no windowsEscalates flag', () => {
    // The unclassified-file branch deliberately omits the flag, so this pins
    // fullPlan's `windowsEscalates = true` default through a real call site: a
    // branch added later without the flag over-tests rather than under-tests.
    const unclassified = plan(['data.reference/bootstrap.bin']);

    expect(unclassified.full).toBe(true);
    expect(unclassified.windowsMode).toBe('full');
  });

  it('fails closed to the full suite rather than selecting zero Windows tests', () => {
    // run-ci-tests.js prints "No server tests selected" and exits 0 on an empty
    // files list. A downgrade that resolved to [] would be a green job that ran
    // nothing, so the baseline has to actually exist first.
    const noContracts = buildCiTestPlan(['client/vite.config.js'], { trackedFiles: [] });

    expect(noContracts.windowsMode).toBe('full');
    expect(noContracts.shards.windows).toEqual(shardIndexes('full', FULL_SUITE_SHARDS.windows));

    // The downgrade is still reachable — this is a fail-closed fallback, not a
    // rule that disabled it outright.
    const withContracts = buildCiTestPlan(['client/vite.config.js'], {
      trackedFiles: WINDOWS_CONTRACT_TESTS,
    });
    expect(withContracts.windowsMode).toBe('files');
  });

  describe('no Windows-sensitive surface loses coverage', () => {
    // One representative path per WINDOWS_RISK_RULES entry. The coverage
    // assertion below fails when a rule is added without a sample here, so a
    // new Windows-sensitive surface cannot land untested.
    const RISK_SAMPLES = [
      'scripts/deploy.ps1',
      'scripts/launch.cmd',
      'scripts/fix-windows-console.js',
      'scripts/ps1-bom.test.js',
      'server/lib/bufferedSpawn.js',
      'server/lib/pathSafety.js',
      'server/lib/staticImportGraph.js',
      'server/services/agentImportCycles.test.js',
      'server/services/worktreeManager.js',
      'server/lib/shellCd.js',
      'server/lib/agentGuard/index.js',
      'server/cos-runner/index.js',
      'server/services/shell.js',
      'server/services/agentTuiSpawning.js',
      'server/services/autonomousJobs/execution.shellSpawn.js',
      'server/services/voice/fineTuning.js',
      'server/routes/apps/index.js',
      'server/routes/scaffoldVite.js',
    ];

    it('covers every risk rule with a sample', () => {
      const uncovered = WINDOWS_RISK_RULES
        .filter((rule) => !RISK_SAMPLES.some((path) => rule.test(path)))
        .map((rule) => String(rule));

      expect(uncovered).toEqual([]);
    });

    it.each(RISK_SAMPLES)('gives %s the complete Windows suite, never the baseline', (path) => {
      // Differential, so it stays load-bearing for every sample. Asserting
      // `windows === true` on `plan([path])` alone would be vacuous for
      // .ps1/.cmd/.bat: those are not in EXECUTABLE_RE, so they force a full
      // plan as an "unclassified changed file", and EVERY full plan sets
      // `windows: true` whatever the risk rules say. Pairing the sample with a
      // client-only trigger makes the plan go full for a reason that WOULD
      // downgrade, so only the risk rule can produce `full` here.
      expect(plan(['client/vite.config.js']).windowsMode).toBe('files');
      expect(plan(['client/vite.config.js', path]).windowsMode).toBe('full');
    });

    it('routes a scoped Windows-risk change to the Windows job', () => {
      // The scoped side of the same predicate: no full trigger in sight, so
      // `windows: true` here is a direct consequence of WINDOWS_RISK_RULES.
      expect(plan(['server/services/auth.js']).windows).toBe(false);
      expect(plan(['server/lib/bufferedSpawn.js']).windows).toBe(true);
    });
  });
});
