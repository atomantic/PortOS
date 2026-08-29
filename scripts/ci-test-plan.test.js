import { describe, expect, it } from 'vitest';

import {
  ALWAYS_RUN_TESTS,
  buildCiTestPlan,
  forceFullReasonFor,
  isRouteOnlyAppDiff,
  splitByRunner,
  WINDOWS_CONTRACT_TESTS,
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
});
